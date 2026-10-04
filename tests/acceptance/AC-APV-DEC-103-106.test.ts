/**
 * PR #35 第二轮修改清单·补充（原站取证 Q-M0-38～47 + DEC-103～106）。
 * DEC-103 驳回 / 撤回后重提一律沿用原实例与原版本；DEC-104 审批记录查看权限是查看方的节点开关；
 * DEC-105 员工子集变更不做审批中编辑；DEC-106 相同 / 历史相同审批人自动处理的结果「同意」/「跳过」；
 * 第 26 条 加签按 `14` §11.4：多人依次、全部完成才离开节点，加签人不能编辑（§11.3）；
 * 第 14 / 18 条 标准流程编码（`14` §11.1）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
  type NodeInput,
  type ProcessView,
} from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

async function outboxEvents(w: ApprovalWorld, instanceId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ event_type: string }>(
      await tx.execute(sql`SELECT event_type FROM approval_outbox WHERE object_id=${instanceId}::uuid`),
    ).map((row) => row.event_type),
  );
}

/** 以当前生效版本为底稿发布下一版（在途实例应仍按旧版本流转）。 */
async function publishNextVersion(w: ApprovalWorld, process: ProcessView, nodes: readonly NodeInput[]) {
  let next = await w.json<ProcessView>(
    await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id}/versions`, { ifMatch: process.revision }),
    201,
  );
  next = await w.json<ProcessView>(
    await w.request(w.hr.id, 'PUT', `${BASE}/processes/${process.id}/draft`, {
      ifMatch: next.revision,
      body: {
        name: '第二版',
        priority: next.latestVersion.priority,
        isFallback: false,
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: next.latestVersion.conditions,
        nodes,
      },
    }),
  );
  return w.publish(next);
}

async function patchBusiness(w: ApprovalWorld, id: string, fields: Record<string, unknown>) {
  const business = await w.business(id);
  return w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'PATCH', `/api/tenant/employment/businesses/${id}`, {
      ifMatch: business.revision,
      body: { fields },
    }),
  );
}

describe('DEC-103：重提一律沿用原实例与原流程版本', () => {
  it('驳回后修改了发起条件字段再提交：实例 ID 与流程版本不变，不重新匹配，也不再触发“流程发起”', async () => {
    const w = await approvalWorld(database().db, 'apv-dec103-reject');
    const s = await transferScene(w);
    const other = await w.org('另一调入部门');
    const otherHead = await w.person('另一调入负责人', other);
    await w.setOrgRoles(other, { head: otherHead.employeeId });
    const byDepartment = (code: string, priority: number, org: string) =>
      w.publishedProcess({
        code,
        priority,
        conditions: { items: [{ no: 1, field: 'record.departmentId', operator: 'in_org_tree', value: org }] },
        nodes: [{ key: 'in_head', approver: 'record_department_head' }],
      });
    const first = await byDepartment('BY_TO', 2, s.to);
    await byDepartment('BY_OTHER', 1, other);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    expect(view).toMatchObject({ processId: first.id, versionNo: 1 });
    await publishNextVersion(w, first, [{ key: 'v2_node', approver: 'record_department_hrbp' }]);
    view = await w.json(await w.taskAction(s.inHead.userId, current(view).id, 'reject', view.revision));
    const patched = await patchBusiness(w, draft.id, { departmentId: other });
    await w.json(await w.submitRaw(patched));
    const resumed = await w.instanceOf(draft.id);
    expect(resumed).toMatchObject({ id: view.id, status: 'running', processId: first.id, versionNo: 1 });
    expect(current(resumed)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: otherHead.userId });
    expect(resumed.logs.filter((log) => log.event === 'start')).toHaveLength(1);
    const events = await outboxEvents(w, view.id);
    expect(events.filter((event) => event === 'approval.instance.started')).toHaveLength(1);
    expect(events).toContain('approval.instance.resubmitted');
  });

  it('撤回后修改再提交：沿用原实例与原版本，从第一个节点重新审批；非原发起人不能重新提交', async () => {
    const w = await approvalWorld(database().db, 'apv-dec103-withdraw');
    const s = await transferScene(w);
    const process = await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[2]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to, place: '旧地点' });
    let view = await w.submit(draft);
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(view.currentNodeKey).toBe('in_head');
    const business = await w.business(draft.id);
    const withdrawn = await w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/withdraw`, {
      ifMatch: business.revision,
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    await publishNextVersion(w, process, [{ key: 'v2_node', approver: 'record_department_hrbp' }]);
    const patched = await patchBusiness(w, draft.id, { place: '新地点' });
    const otherHr = await w.member('其他 HR');
    const denied = await w.submitRaw(patched, otherHr);
    expect(await reasonOf(denied)).toMatchObject({ status: 403, reason: 'APPROVAL_NOT_INITIATOR' });
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft' });
    await w.json(await w.submitRaw(patched));
    const resumed = await w.instanceOf(draft.id);
    expect(resumed).toMatchObject({ id: view.id, status: 'running', versionNo: 1, currentNodeKey: 'out_head' });
    expect(current(resumed)).toMatchObject({ assigneeUserId: s.outHead.userId });
    expect(resumed.logs.filter((log) => log.event === 'start')).toHaveLength(1);
  });
});

describe('DEC-104：审批记录查看权限（查看方的节点开关）', () => {
  it('默认所有能打开详情的人都看得到审批记录与意见；勾选的节点上，本节点审批人看不到', async () => {
    const w = await approvalWorld(database().db, 'apv-dec104-node');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [TRANSFER_NODES[0]!, { ...TRANSFER_NODES[2]!, hideRecords: true }, TRANSFER_NODES[1]!],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, { comment: '薪资 30k' }),
    );
    const hidden = await w.detail(view.id, s.inHead.userId);
    expect(hidden.recordsHidden).toBe(true);
    expect(hidden.logs).toEqual([]);
    expect(hidden.tasks.every((task) => task.assigneeUserId === s.inHead.userId)).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain('薪资 30k');
    expect(hidden.commentNotice).toContain('敏感');
    const history = await w.json<{ items: unknown[]; recordsHidden?: boolean }>(
      await w.request(s.inHead.userId, 'GET', `${BASE}/instances/${view.id}/logs`),
    );
    expect(history).toMatchObject({ items: [], recordsHidden: true });
    const tasks = await w.json<{ items: { assigneeUserId: string }[] }>(
      await w.request(s.inHead.userId, 'GET', `${BASE}/instances/${view.id}/tasks`),
    );
    expect(tasks.items.every((task) => task.assigneeUserId === s.inHead.userId)).toBe(true);
    for (const viewer of [w.hr.id, s.outHead.userId]) {
      const open = await w.detail(view.id, viewer);
      expect(open.recordsHidden ?? false).toBe(false);
      expect(open.tasks.find((task) => task.nodeKey === 'out_head')!.comment).toBe('薪资 30k');
    }
    view = await w.json(
      await w.taskAction(s.inHead.userId, current(hidden).id, 'approve', hidden.revision, { comment: '同意调入' }),
    );
    const next = await w.detail(view.id, s.inHrbp.userId);
    expect(next.recordsHidden ?? false).toBe(false);
    expect(next.tasks.map((task) => task.comment)).toEqual(expect.arrayContaining(['薪资 30k', '同意调入']));
  });

  it('开始节点勾选：发起人看不到审批记录与意见，审批人不受影响', async () => {
    const w = await approvalWorld(database().db, 'apv-dec104-start');
    const s = await transferScene(w);
    await w.publishedProcess({ hideRecordsFromInitiator: true, nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[2]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, { comment: '内部意见' }),
    );
    const owner = await w.detail(view.id);
    expect(owner).toMatchObject({ recordsHidden: true, logs: [] });
    expect(JSON.stringify(owner)).not.toContain('内部意见');
    expect(owner.actions).toContain('withdraw');
    const approver = await w.detail(view.id, s.inHead.userId);
    expect(approver.tasks.find((task) => task.nodeKey === 'out_head')!.comment).toBe('内部意见');
  });

  it('开关随流程版本冻结：在途实例不受新版本开关影响', async () => {
    const w = await approvalWorld(database().db, 'apv-dec104-version');
    const s = await transferScene(w);
    const process = await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[2]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    await publishNextVersion(w, process, [TRANSFER_NODES[0]!, { ...TRANSFER_NODES[2]!, hideRecords: true }]);
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, { comment: '旧版意见' }),
    );
    const later = await w.detail(view.id, s.inHead.userId);
    expect(later.recordsHidden ?? false).toBe(false);
    expect(later.tasks.find((task) => task.nodeKey === 'out_head')!.comment).toBe('旧版意见');
  });
});

describe('DEC-105：员工子集变更不做审批中编辑', () => {
  it('子集变更节点不公布编辑、编辑返回 409，申请内容不变；流程编码按子集派生', async () => {
    const w = await approvalWorld(database().db, 'apv-dec105');
    const s = await transferScene(w);
    const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school'] } },
    });
    expect(settings.status).toBe(200);
    await w.publishedProcess({
      approvalType: 'personnel_change',
      conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
      nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school'] }],
    });
    const path = `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`;
    const record = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
      201,
    );
    const created = await w.json<{ id: string }>(
      await w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
        ifMatch: 0,
        body: {
          employeeId: s.subject.employeeId,
          subset: 'education',
          recordId: record.id,
          targetRevision: record.revision,
          values: { school: '乙校' },
        },
      }),
      201,
    );
    const view = await w.instanceOf(created.id, s.subject.userId);
    expect(view.processCode).toBe('ChangeEducationProcess');
    expect((await w.detail(view.id, s.outHead.userId)).actions).not.toContain('edit');
    const edit = await w.taskAction(s.outHead.userId, current(view).id, 'edit', view.revision, {
      fields: { school: '丙校' },
    });
    expect(edit.status).toBe(409);
    expect((await w.detail(view.id, s.outHead.userId)).form.values).toEqual({ school: '乙校' });
  });
});

describe('DEC-106：相同 / 历史相同审批人自动处理的结果', () => {
  it('结果「跳过」处理人记为系统，「同意」记为该审批人；审批记录能区分两者', async () => {
    const w = await approvalWorld(database().db, 'apv-dec106');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { head: s.outHead.employeeId });
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head' },
        { key: 'in_head', approver: 'record_department_head', sameAssigneeSkip: true, sameAssigneeResult: 'skip' },
        { key: 'in_hrbp', approver: 'record_department_hrbp' },
        {
          key: 'again',
          approver: 'record_department_head',
          historySameAssigneeSkip: true,
          historySameAssigneeResult: 'approve',
        },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(view.tasks.find((task) => task.nodeKey === 'in_head')).toMatchObject({
      status: 'skipped',
      origin: 'same_skip',
      assigneeUserId: null,
    });
    expect(view.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'skip',
          nodeKey: 'in_head',
          actorUserId: null,
          detail: expect.objectContaining({ mechanism: 'same', handler: '系统', candidateUserId: s.outHead.userId }),
        }),
      ]),
    );
    view = await w.json(await w.taskAction(s.inHrbp.userId, current(view).id, 'approve', view.revision));
    expect(view.status).toBe('approved');
    expect(view.tasks.find((task) => task.nodeKey === 'again')).toMatchObject({
      status: 'approved',
      origin: 'history_skip',
      assigneeUserId: s.outHead.userId,
    });
    expect(view.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'auto_approve',
          nodeKey: 'again',
          detail: expect.objectContaining({
            mechanism: 'history',
          }),
        }),
      ]),
    );
  });

  it('结果只接受「同意」与「跳过」', async () => {
    const w = await approvalWorld(database().db, 'apv-dec106-invalid');
    const response = await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
      ifMatch: 0,
      body: {
        code: 'BAD_RESULT',
        name: '非法结果',
        approvalType: 'transfer',
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
        nodes: [{ key: 'n', approver: 'record_department_head', sameAssigneeSkip: true, sameAssigneeResult: 'reject' }],
      },
    });
    expect(response.status).toBe(400);
  });
});

describe('第 26 条：加签按 `14` §11.4 多人依次审批', () => {
  async function addSignScene(label: string, node: Partial<NodeInput> = {}) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    const first = await w.member('财务甲');
    const second = await w.member('财务乙');
    await w.publishedProcess({
      nodes: [{ ...TRANSFER_NODES[0]!, actions: { addSign: true }, ...node }, TRANSFER_NODES[2]!],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    return { w, s, first, second, view };
  }

  it('前加签：加签人按选择顺序依次审批，全部同意后回到原审批人', async () => {
    const { w, s, first, second, view: start } = await addSignScene('apv-add-sign-before-many');
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(start).id, 'add-sign', start.revision, {
        userIds: [first, second],
        type: 'before',
      }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: first, origin: 'add_sign_before' });
    view = await w.json(await w.taskAction(first, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ assigneeUserId: second, nodeKey: 'out_head' });
    view = await w.json(await w.taskAction(second, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ assigneeUserId: s.outHead.userId, origin: 'add_sign_return' });
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: s.inHead.userId });
  });

  it('后加签：原审批人同意后加签人依次审批，全部完成才离开本节点', async () => {
    const { w, s, first, second, view: start } = await addSignScene('apv-add-sign-after-many');
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(start).id, 'add-sign', start.revision, {
        userIds: [first, second],
        type: 'after',
      }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: first, origin: 'add_sign_after' });
    view = await w.json(await w.taskAction(first, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ assigneeUserId: second, nodeKey: 'out_head' });
    view = await w.json(await w.taskAction(second, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: s.inHead.userId });
  });

  it('任一加签人驳回即整单驳回，排队中的加签人不再收到任务', async () => {
    const { w, s, first, second, view: start } = await addSignScene('apv-add-sign-reject-many');
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(start).id, 'add-sign', start.revision, {
        userIds: [first, second],
        type: 'after',
      }),
    );
    view = await w.json(await w.taskAction(first, current(view).id, 'reject', view.revision, { comment: '不同意' }));
    expect(view.status).toBe('returned');
    expect(view.tasks.filter((task) => task.status === 'pending')).toEqual([]);
    expect((await w.todos(second)).items).toEqual([]);
  });

  it('加签人不能审批中编辑（`14` §11.3）；回到原审批人后可以', async () => {
    const node: Partial<NodeInput> = { editMode: 'with_approve', formFields: ['place'], editableFields: ['place'] };
    const { w, s, first, view: start } = await addSignScene('apv-add-sign-edit', node);
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(start).id, 'add-sign', start.revision, {
        userIds: [first],
        type: 'before',
      }),
    );
    const denied = await w.taskAction(first, current(view).id, 'approve', view.revision, {
      fields: { place: '加签人改的地点' },
    });
    expect(await reasonOf(denied)).toMatchObject({ status: 403, reason: 'APPROVAL_ADD_SIGNER_EDIT' });
    view = await w.json(await w.taskAction(first, current(view).id, 'approve', view.revision));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, {
        fields: { place: '原审批人改的地点' },
      }),
    );
    expect(view.currentNodeKey).toBe('in_head');
  });

  it('加签人不能重复、不能是本人，单次最多 10 人', async () => {
    const { w, s, first, view } = await addSignScene('apv-add-sign-validate');
    const task = current(view).id;
    const duplicate = await w.taskAction(s.outHead.userId, task, 'add-sign', view.revision, {
      userIds: [first, first],
      type: 'before',
    });
    expect(duplicate.status).toBe(400);
    const self = await w.taskAction(s.outHead.userId, task, 'add-sign', view.revision, {
      userIds: [first, s.outHead.userId],
      type: 'before',
    });
    expect(self.status).toBe(400);
    const many = Array.from({ length: 11 }, () => first);
    const tooMany = await w.taskAction(s.outHead.userId, task, 'add-sign', view.revision, {
      userIds: many,
      type: 'before',
    });
    expect(tooMany.status).toBe(400);
  });
});

describe('第 14 / 18 条：标准流程编码与预置', () => {
  it('预置不含“重聘”；转正等类型按标准编码带发起条件；调动节点表单含 TransferDetailView 字段', async () => {
    const w = await approvalWorld(database().db, 'apv-standard-codes');
    const installed = await w.json<{ items: { id: string; approvalType: string }[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }),
    );
    const types = installed.items.map((item) => item.approvalType);
    expect(types).not.toContain('rehire');
    expect(types).not.toContain('retire_rehire');
    const detailOf = async (type: string) =>
      w.json<ProcessView>(
        await w.request(
          w.hr.id,
          'GET',
          `${BASE}/processes/${installed.items.find((i) => i.approvalType === type)!.id}`,
        ),
      );
    expect((await detailOf('regularization')).latestVersion).toMatchObject({
      isFallback: false,
      conditions: { items: [expect.objectContaining({ field: 'processCode', value: 'ProbationProcessNew' })] },
    });
    const transfer = await detailOf('transfer');
    expect(transfer.latestVersion.nodes[0]!.formFields).toEqual(expect.arrayContaining(['jobNumber', 'effectiveDate']));
  });
});
