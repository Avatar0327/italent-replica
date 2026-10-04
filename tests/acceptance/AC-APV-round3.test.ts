/**
 * PR #35 第三轮修改清单（astra 二审 F1～F17 + DEC-113～119）。
 * P1：F1 授权与记录隐藏不依赖展示窗口；F2 异常管理员交接不绕过实例范围与 DEC-092；F3 / DEC-113 重提复核当前权限；
 * F4 加签与撤回组合；F5 嵌套加签；F6 已离职视为审批人为空；F7 干预 / 跳转后的历史边界。
 * P2 / P3：F8～F17；代选决策 DEC-114 / DEC-115 / DEC-119。
 */
import { randomUUID } from 'node:crypto';
import { revokeMembership, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import {
  approvalWorld,
  permissionAdmin,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

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

async function membershipRevision(w: ApprovalWorld, userId: string) {
  const rows = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
  return Number(rowsOf<{ revision: number }>(rows)[0]!.revision);
}

async function deactivate(w: ApprovalWorld, userId: string) {
  const expectedRevision = await membershipRevision(w, userId);
  await revokeMembership(w.db, { tenantId: w.tenant.id, userId, expectedRevision }, cmd());
}

/** 只放行指定动作之外的一切（真实授权器之外的最小夹具）。 */
function denying(predicate: (resource: string, action: string) => boolean): Authorizer {
  return (request) => !predicate(String(request.resource ?? ''), request.action);
}

/** 员工自助提交一条教育经历变更申请（不发布流程，由调用方准备匹配的流程）。 */
async function personnelRequest(w: ApprovalWorld, s: Awaited<ReturnType<typeof transferScene>>) {
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school'] } },
  });
  expect(settings.status).toBe(200);
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
        values: { school: '错别字大学' },
      },
    }),
    201,
  );
  return w.instanceOf(created.id, s.subject.userId);
}

async function personnelScene(w: ApprovalWorld, s: Awaited<ReturnType<typeof transferScene>>) {
  await w.publishedProcess({
    approvalType: 'personnel_change',
    conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
    nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school'] }],
  });
  return personnelRequest(w, s);
}

describe('F1：授权与记录隐藏不依赖最近 200 条的展示窗口', () => {
  it('超过 200 条任务后，历史参与人仍按其节点的表单与记录隐藏查看', async () => {
    const w = await approvalWorld(database().db, 'apv-f1');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { ...TRANSFER_NODES[0]!, formFields: ['departmentId'], hideRecords: true },
        { ...TRANSFER_NODES[2]!, formFields: ['departmentId', 'place'] },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to, place: '新地点' }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO approval_tasks
        (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,created_at)
        SELECT gen_random_uuid(),${w.tenant.id},${view.id}::uuid,100000+g,1,'in_head',${w.exceptionAdmin}::uuid,
          'transfer','cancelled',now() FROM generate_series(1,250) g`),
    );
    const early = await w.detail(view.id, s.outHead.userId);
    expect(early).toMatchObject({ recordsHidden: true, logs: [], form: { nodeKey: 'out_head' } });
    expect(early.form.values).not.toHaveProperty('place');
    const history = await w.json<{ items: unknown[]; recordsHidden: boolean }>(
      await w.request(s.outHead.userId, 'GET', `${BASE}/instances/${view.id}/logs`),
    );
    expect(history).toMatchObject({ items: [], recordsHidden: true });
  });
});

describe('F2：异常管理员交接不绕过实例范围与本人回避（DEC-092 / DEC-102）', () => {
  async function exceptionScene(label: string) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    const process = await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });
    const successor = await w.member('新异常管理员');
    return { w, s, process, view, successor };
  }

  it('操作人是本单发起人：只替换流程配置，不改派该实例的异常任务', async () => {
    const { w, process, view, successor } = await exceptionScene('apv-f2-self');
    const result = await w.json<{
      processes: number;
      tasks: number;
      skipped: { instanceId: string; reason: string }[];
    }>(
      await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    expect(result).toMatchObject({ processes: 1, tasks: 0 });
    expect(result.skipped).toEqual([{ instanceId: view.id, reason: 'APPROVAL_ADMIN_SELF' }]);
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.exceptionAdmin });
    const republished = await w.json<{ currentVersion: { exceptionAdminUserId: string; versionNo: number } }>(
      await w.request(w.hr.id, 'GET', `${BASE}/processes/${process.id}`),
    );
    expect(republished.currentVersion).toMatchObject({ exceptionAdminUserId: successor, versionNo: 2 });
  });

  it('没有实例转交按钮的流程管理员：只能替换流程配置，实例任务不改派', async () => {
    const { w, view, successor } = await exceptionScene('apv-f2-scope');
    const configOnly = await w.member('只有配置权的管理员');
    const api = tenantApi(w.db, {
      authorize: denying((resource) => resource.includes('ApprovalInstance')),
      clock: w.clock,
    });
    const response = await api.request('POST', `${BASE}/exception-admins/handover`, {
      ...w.as(configOnly),
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as { tasks: number; skipped: { reason: string }[]; unlisted: number };
    expect(result.tasks).toBe(0);
    // 第四轮 N3：调用者看不到的实例不列出编号与原因，只计入不可识别的 unlisted。
    expect(result).toMatchObject({ skipped: [], unlisted: 1 });
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.exceptionAdmin });
  });
});

describe('F3 / DEC-113：重提时复核原发起人当前的权限、范围与本人绑定', () => {
  it('撤销自助申请权限后重提被拒，申请保持退回', async () => {
    const w = await approvalWorld(database().db, 'apv-f3-perm');
    const s = await transferScene(w);
    const view = await personnelScene(w, s);
    const returned = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision),
    );
    const api = tenantApi(w.db, {
      authorize: denying((resource, action) => action === 'object.button' && resource.includes('self-service-submit')),
      clock: w.clock,
    });
    const response = await api.request('POST', `${BASE}/instances/${view.id}/resubmit`, {
      ...w.as(s.subject.userId),
      ifMatch: returned.revision,
      body: { fields: { school: '正确大学' } },
    });
    expect(response.status).toBe(403);
    expect((await w.detail(view.id, s.subject.userId)).status).toBe('returned');
  });

  it('解除账号与本人档案的绑定后重提被拒', async () => {
    const w = await approvalWorld(database().db, 'apv-f3-unbind');
    const s = await transferScene(w);
    const view = await personnelScene(w, s);
    const returned = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision),
    );
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links
        WHERE tenant_id=${w.tenant.id} AND user_id=${s.subject.userId}::uuid`),
    );
    const response = await w.request(s.subject.userId, 'POST', `${BASE}/instances/${view.id}/resubmit`, {
      ifMatch: returned.revision,
      body: { fields: { school: '正确大学' } },
    });
    expect(response.status).toBe(403);
    expect((await w.detail(view.id, s.subject.userId)).status).toBe('returned');
  });
});

describe('F4 / F5 / F8：加签链的组合', () => {
  async function addSignScene(label: string, actions: Record<string, unknown> = { addSign: true }) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    const first = await w.member('财务甲');
    const second = await w.member('财务乙');
    await w.publishedProcess({ nodes: [{ ...TRANSFER_NODES[0]!, actions }, TRANSFER_NODES[2]!] });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    return { w, s, first, second, view };
  }

  it('F4：加签进行中，加签人与发起加签的原审批人都不能撤回（不丢失未完成的加签义务）', async () => {
    const { w, s, first, second, view: start } = await addSignScene('apv-f4', { addSign: true, retrieve: true });
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(start).id, 'add-sign', start.revision, {
        userIds: [first, second],
        type: 'before',
      }),
    );
    const firstTask = current(view);
    view = await w.json(await w.taskAction(first, firstTask.id, 'approve', view.revision));
    expect((await w.detail(view.id, first)).actions).not.toContain('retrieve');
    const retrieve = await w.request(first, 'POST', `${BASE}/tasks/${firstTask.id}/retrieve`, {
      ifMatch: view.revision,
    });
    expect(await reasonOf(retrieve)).toMatchObject({ status: 409, reason: 'APPROVAL_NOT_RETRIEVABLE' });
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: second });
  });

  it('F4：后加签后原审批人不能撤回本人的同意', async () => {
    const { w, s, first, view: start } = await addSignScene('apv-f4-after', { addSign: true, retrieve: true });
    const own = current(start);
    const view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, own.id, 'add-sign', start.revision, { userIds: [first], type: 'after' }),
    );
    const retrieve = await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${own.id}/retrieve`, {
      ifMatch: view.revision,
    });
    expect(await reasonOf(retrieve)).toMatchObject({ status: 409, reason: 'APPROVAL_NOT_RETRIEVABLE' });
  });

  it('F5：加签人不能再加签，入口明确拒绝，不出现无人可办的排队任务', async () => {
    const { w, s, first, second, view: start } = await addSignScene('apv-f5');
    const nested = await w.member('嵌套加签人');
    const view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(start).id, 'add-sign', start.revision, {
        userIds: [first, second],
        type: 'before',
      }),
    );
    expect((await w.detail(view.id, first)).actions).not.toContain('addSign');
    const response = await w.taskAction(first, current(view).id, 'add-sign', view.revision, {
      userIds: [nested],
      type: 'before',
    });
    expect(await reasonOf(response)).toMatchObject({ status: 409, reason: 'APPROVAL_ADD_SIGN_NESTED' });
  });

  it('F8：轮到排队中的加签人时其账号已停用，转异常管理员并保留加签链', async () => {
    const { w, s, first, second, view: start } = await addSignScene('apv-f8');
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(start).id, 'add-sign', start.revision, {
        userIds: [first, second],
        type: 'after',
      }),
    );
    await deactivate(w, second);
    view = await w.json(await w.taskAction(first, current(view).id, 'approve', view.revision));
    const handover = current(view);
    expect(handover).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true, nodeKey: 'out_head' });
    view = await w.json(await w.taskAction(w.exceptionAdmin, handover.id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: s.inHead.userId });
  });
});

describe('F6：已离职但账号仍有效的人视为审批人为空（`14` §11.7、DEC-098）', () => {
  it('调入部门负责人离职已生效：中间节点转异常管理员', async () => {
    const w = await approvalWorld(database().db, 'apv-f6');
    const s = await transferScene(w);
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.inHead.employeeId}`),
    );
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.inHead.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
      }),
      201,
    );
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[2]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({
      nodeKey: 'in_head',
      assigneeUserId: w.exceptionAdmin,
      isExceptionAdmin: true,
    });
  });
});

describe('F7：管理员干预 / 跳转后，之前的节点不再算历史审批人（`14` 模型 427 行）', () => {
  it('跳回已审批节点后，旧的同意不再触发历史同人自动处理', async () => {
    const w = await approvalWorld(database().db, 'apv-f7');
    const s = await transferScene(w);
    const admin = await w.member('流程管理员');
    await w.publishedProcess({
      nodes: [{ ...TRANSFER_NODES[0]!, historySameAssigneeSkip: true }, TRANSFER_NODES[2]!],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head' });
    view = await w.json(
      await w.instanceAction(admin, view.id, 'admin-intervene', view.revision, {
        kind: 'jump',
        toNodeKey: 'out_head',
        reason: '重新审批',
      }),
    );
    expect(current(view)).toMatchObject({ nodeKey: 'out_head', assigneeUserId: s.outHead.userId });
  });
});

describe('F9：员工子集申请撤回后沿原实例重提（DEC-103 / DEC-113）', () => {
  it('撤回后带修正重提：同一实例继续审批，修正追加为新版本', async () => {
    const w = await approvalWorld(database().db, 'apv-f9');
    const s = await transferScene(w);
    const view = await personnelScene(w, s);
    const withdrawn = await w.json<InstanceView>(
      await w.instanceAction(s.subject.userId, view.id, 'withdraw', view.revision),
    );
    expect(withdrawn.status).toBe('withdrawn');
    expect((await w.detail(view.id, s.subject.userId)).actions).toContain('resubmit');
    const resumed = await w.json<InstanceView>(
      await w.request(s.subject.userId, 'POST', `${BASE}/instances/${view.id}/resubmit`, {
        ifMatch: withdrawn.revision,
        body: { fields: { school: '正确大学' } },
      }),
    );
    expect(resumed).toMatchObject({ id: view.id, status: 'running', form: { values: { school: '正确大学' } } });
    const versions = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ values: Record<string, unknown> }>(
        await tx.execute(sql`SELECT values FROM personnel_change_request_versions
          WHERE request_id=${view.businessId}::uuid ORDER BY version_no`),
      ),
    );
    expect(versions.map((row) => row.values)).toEqual([{ school: '错别字大学' }, { school: '正确大学' }]);
  });
});

describe('F10：审批侧撤回按真实创建人维度判断数据范围', () => {
  async function scopedWithdrawer(w: ApprovalWorld) {
    const world = await permissionAdmin(w);
    const user = await w.member('只看本人创建的 HR');
    const objectCode = MODULE_OBJECTS.employmentRecord.code;
    const profile = await createProfile(world, `apvf10${user.slice(0, 6)}`);
    const set = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: MODULE_OBJECTS.employmentRecord.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
        buttons: [{ buttonCode: 'Employment.Withdraw', level: 'detail' }],
      },
      objectCode,
    );
    expect(set.status, await set.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user, profile.id)).status).toBe(201);
    const policy = await world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${objectCode}/page/${objectCode}.list`,
      { ...world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    return { user, real: tenantApi(w.db, { authorize: undefined, clock: w.clock }) };
  }

  it('本人创建并提交的申请可以撤回；他人创建、本人提交的申请超出“使用用户”范围被拒', async () => {
    const w = await approvalWorld(database().db, 'apv-f10');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const { user, real } = await scopedWithdrawer(w);
    const own = await w.submit(
      await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: user }),
      user,
    );
    const ok = await real.request('POST', `${BASE}/instances/${own.id}/withdraw`, {
      ...w.as(user),
      ifMatch: own.revision,
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const other = await w.submit(await w.application(s.manager.employeeId, { departmentId: s.to }), user);
    const denied = await real.request('POST', `${BASE}/instances/${other.id}/withdraw`, {
      ...w.as(user),
      ifMatch: other.revision,
    });
    expect(await reasonOf(denied)).toMatchObject({ status: 403, reason: 'APPROVAL_SCOPE_DENIED' });
  });
});

describe('F13：仿真复用提交预检（DEC-091）', () => {
  it('异常管理员是发起人且没有虚拟直线经理：仿真给出不可提交与原因', async () => {
    const w = await approvalWorld(database().db, 'apv-f13');
    const process = await w.publishedProcess({ exceptionAdminUserId: w.hr.id, nodes: [TRANSFER_NODES[0]!] });
    const head = await w.member('虚拟负责人');
    const data = {
      values: { processCode: 'TransferProcessNew' },
      relations: { latest_record_department_head: head },
      initiatorUserId: w.hr.id,
    };
    const single = await w.json<{ startable: boolean; blockers: string[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id}/simulate`, {
        body: { scope: 'published', data },
      }),
    );
    expect(single.startable).toBe(false);
    expect(single.blockers.join('')).toContain('异常管理员');
    const byObject = await w.json<{ replicaStartable: boolean; replicaError: string }>(
      await w.request(w.hr.id, 'POST', `${BASE}/simulate`, {
        body: { approvalType: 'transfer', scope: 'published', data },
      }),
    );
    expect(byObject.replicaStartable).toBe(false);
    expect(byObject.replicaError).toContain('异常管理员');
  });
});

describe('F14：员工子集变更不开放审批中编辑（DEC-105）', () => {
  it('配置时拒绝子集节点的编辑设置；历史配置下详情不公布编辑，执行返回 409', async () => {
    const w = await approvalWorld(database().db, 'apv-f14');
    const s = await transferScene(w);
    const rejected = await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
      ifMatch: 0,
      body: {
        code: 'SubsetEdit',
        name: '子集可编辑',
        approvalType: 'personnel_change',
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
        nodes: [
          {
            key: 'head',
            approver: 'latest_record_department_head',
            formFields: ['school'],
            editableFields: ['school'],
            editMode: 'separate',
          },
        ],
      },
    });
    expect(await reasonOf(rejected)).toMatchObject({ status: 400, reason: 'APPROVAL_DEFINITION_INVALID' });
    // 历史配置（绕过入口校验直接落库）：详情按适配器能力过滤动作。
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const ctx = {
        tenantId: w.tenant.id,
        userId: w.hr.id,
        timezone: 'Asia/Shanghai',
        now: new Date(),
        expectedRevision: 0,
      };
      const created = await createProcess(
        tx,
        { ...ctx, commandId: randomUUID() },
        { code: 'LegacySubsetEdit', approvalType: 'personnel_change' },
        {
          name: '历史子集流程',
          groupName: null,
          description: null,
          priority: 0,
          isFallback: true,
          exceptionAdminUserId: w.exceptionAdmin,
          urgeEnabled: true,
          hideRecordsFromInitiator: false,
          conditions: { items: [], expression: '' },
          nodes: [
            {
              key: 'head',
              name: '负责人',
              approver: 'latest_record_department_head',
              noAssignee: 'exception_admin',
              sameAssigneeSkip: false,
              historySameAssigneeSkip: false,
              sameAssigneeResult: 'approve',
              historySameAssigneeResult: 'approve',
              formFields: ['school'],
              editableFields: ['school'],
              editMode: 'separate',
              actions: { transfer: false, addSign: false, copySend: false, retrieve: false, urge: 'inherit' },
              rejectCommentRequired: false,
              hideRecords: false,
              rejectResubmit: 'restart',
              messageRules: [],
            },
          ],
        },
      );
      await publishProcess(tx, { ...ctx, commandId: randomUUID(), expectedRevision: created.revision }, created.id);
    });
    const view = await personnelRequest(w, s);
    expect((await w.detail(view.id, s.outHead.userId)).actions).not.toContain('edit');
    const edit = await w.taskAction(s.outHead.userId, current(view).id, 'edit', view.revision, {
      fields: { school: '丙校' },
    });
    expect(await reasonOf(edit)).toMatchObject({ status: 409, reason: 'APPROVAL_EDIT_UNSUPPORTED' });
  });
});

describe('F16：本人发起或本人为异动对象的申请，详情不公布 DEC-092 禁止的管理员动作', () => {
  it('发起人兼管理员看不到改派 / 干预；其他管理员可以', async () => {
    const w = await approvalWorld(database().db, 'apv-f16');
    const s = await transferScene(w);
    const admin = await w.member('其他管理员');
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(view.actions).not.toContain('adminTransfer');
    expect(view.actions).not.toContain('adminIntervene');
    expect((await w.detail(view.id, admin)).actions).toEqual(
      expect.arrayContaining(['adminTransfer', 'adminIntervene']),
    );
  });
});

describe('F17：安装预置只接受 If-Match: 0', () => {
  it('非零 revision 返回 409，不安装', async () => {
    const w = await approvalWorld(database().db, 'apv-f17');
    const response = await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 5 });
    expect(response.status).toBe(409);
    const list = await w.json<{ items: unknown[] }>(await w.request(w.hr.id, 'GET', `${BASE}/processes`));
    expect(list.items).toEqual([]);
  });
});

describe('DEC-114（代选）：“与上一节点相同”比较上一节点解析出的候选人', () => {
  it('A → A（跳过）→ A：第三个节点继续跳过，整单通过', async () => {
    const w = await approvalWorld(database().db, 'apv-dec114');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { head: s.outHead.employeeId });
    await w.publishedProcess({
      nodes: [
        { key: 'n1', approver: 'latest_record_department_head' },
        { key: 'n2', approver: 'record_department_head', sameAssigneeSkip: true, sameAssigneeResult: 'skip' },
        { key: 'n3', approver: 'record_department_head', sameAssigneeSkip: true, sameAssigneeResult: 'skip' },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(view.status).toBe('approved');
    expect(view.tasks.filter((task) => task.status === 'skipped').map((task) => task.nodeKey)).toEqual(['n2', 'n3']);
  });
});

describe('DEC-115（代选）：记录隐藏时严格隐藏，任一参与节点开启即隐藏', () => {
  it('被隐藏方看不到本人已处理的历史，仍看得到当前待办', async () => {
    const w = await approvalWorld(database().db, 'apv-dec115-own');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [{ ...TRANSFER_NODES[0]!, hideRecords: true }, TRANSFER_NODES[2]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, { comment: '本人意见' }),
    );
    const own = await w.detail(view.id, s.outHead.userId);
    expect(own.recordsHidden).toBe(true);
    expect(JSON.stringify(own)).not.toContain('本人意见');
    expect(own.tasks).toEqual([expect.objectContaining({ status: 'pending', assigneeUserId: s.inHead.userId })]);
  });

  it('同一人在多个节点参与，最近节点未开启但较早节点开启：仍隐藏', async () => {
    const w = await approvalWorld(database().db, 'apv-dec115-any');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { ...TRANSFER_NODES[0]!, hideRecords: true },
        TRANSFER_NODES[2]!,
        { key: 'again', approver: 'latest_record_department_head' },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    view = await w.json(await w.taskAction(s.inHead.userId, current(view).id, 'approve', view.revision));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(view.status).toBe('approved');
    expect((await w.detail(view.id, s.outHead.userId)).recordsHidden).toBe(true);
  });
});

describe('DEC-119（代选）：日志与详情中的字段名按“节点表单 + 字段查看权”过滤', () => {
  it('编辑日志里本节点表单之外的字段名不出现在后续节点的详情中', async () => {
    const w = await approvalWorld(database().db, 'apv-dec119');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          ...TRANSFER_NODES[0]!,
          formFields: ['departmentId', 'place'],
          editableFields: ['place'],
          editMode: 'separate',
        },
        { ...TRANSFER_NODES[2]!, formFields: ['departmentId'] },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to, place: '旧地点' }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'edit', view.revision, { fields: { place: '新地点' } }),
    );
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    const later = await w.detail(view.id, s.inHead.userId);
    const edit = later.logs.find((log) => log.event === 'edit')!;
    expect(edit.detail.fields).toEqual([]);
    const owner = await w.detail(view.id, s.outHead.userId);
    expect(owner.logs.find((log) => log.event === 'edit')!.detail.fields).toEqual(['place']);
  });
});

describe('测试质量：DEC-106 的结果取值校验能区分新旧行为', () => {
  it('「跳过」被接受并原样读回；非法取值按枚举校验报错（不是未知字段）', async () => {
    const w = await approvalWorld(database().db, 'apv-dec106-schema');
    const process = await w.createProcess({
      nodes: [{ key: 'n', approver: 'record_department_head', sameAssigneeSkip: true, sameAssigneeResult: 'skip' }],
    });
    expect(process.latestVersion.nodes[0]).toMatchObject({
      sameAssigneeResult: 'skip',
      historySameAssigneeResult: 'approve',
    });
    const invalid = await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
      ifMatch: 0,
      body: {
        code: 'BadResult',
        name: '非法结果',
        approvalType: 'transfer',
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
        nodes: [{ key: 'n', approver: 'record_department_head', sameAssigneeResult: 'reject' }],
      },
    });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: { details: { code: string; path: (string | number)[] }[] } };
    expect(body.error.details).toEqual([
      expect.objectContaining({ code: 'invalid_value', path: ['nodes', 0, 'sameAssigneeResult'] }),
    ]);
  });
});

describe('F12 / DEC-116：审批类型目录与预置按规格（`14` §11.1）核对', () => {
  /** 期望值来自规格目录（`14` §11.1 首版涉及的任职记录类型与员工信息类型），不取实现自身的目录。 */
  const SPEC_PROCESS_CODES = [
    'EntryProcessNew',
    'ProbationProcessNew',
    'DimissionProcessNew',
    'TransferProcessNew',
    'AddEmployeeProcess',
    'TraineeEntryProcess',
    'RetireProcess',
    'EmpInfoChangeProcess',
  ];

  it('每个规格编码都有审批类型与带该编码条件的草稿预置', async () => {
    const w = await approvalWorld(database().db, 'apv-f12');
    const types = await w.json<{ items: { code: string; defaultProcessCode: string | null }[] }>(
      await w.request(w.hr.id, 'GET', `${BASE}/types`),
    );
    const codes = types.items.map((item) => item.defaultProcessCode);
    for (const code of SPEC_PROCESS_CODES) expect(codes).toContain(code);
    const installed = await w.json<{ items: { id: string; approvalType: string }[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }),
    );
    for (const code of SPEC_PROCESS_CODES) {
      const type = types.items.find((item) => item.defaultProcessCode === code)!;
      const preset = installed.items.find((item) => item.approvalType === type.code);
      expect(preset, code).toBeDefined();
      const detail = await w.json<{ latestVersion: { conditions: { items: { field: string; value: unknown }[] } } }>(
        await w.request(w.hr.id, 'GET', `${BASE}/processes/${preset!.id}`),
      );
      expect(detail.latestVersion.conditions.items).toEqual([
        expect.objectContaining({ field: 'processCode', value: code }),
      ]);
    }
  });
});
