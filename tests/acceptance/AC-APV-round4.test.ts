/**
 * PR #35 第四轮修改清单（astra 三审 N1～N8 + DEC-122～124）。
 * P1：N1 重提按完整载荷复核自助字段白名单；N2 所有手动派单入口复核审批资格（已离职不可选）。
 * P2 / P3：N3 交接不披露范围外实例；N4 交接批次可推进；N6 / DEC-122 性别年龄交付；N8 管理员动作逐按钮。
 * 新决策：DEC-123 异常管理员停用时剩余待办自动转派；DEC-124 历史审批人只算本轮。
 * N5（交接与最终同意 / 撤回竞争）、N7（锁序可检出）在 AC-APV-concurrency-pg.test.ts（真 PostgreSQL）。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { revokeMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

type Scene = Awaited<ReturnType<typeof transferScene>>;

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

/** 只放行指定动作之外的一切（真实授权器之外的最小夹具）。 */
function denying(predicate: (resource: string, action: string) => boolean): Authorizer {
  return (request) => !predicate(String(request.resource ?? ''), request.action);
}

async function membershipRevision(w: ApprovalWorld, userId: string) {
  const rows = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
  return Number(rowsOf<{ revision: number }>(rows)[0]!.revision);
}

/** 让某人离职生效（直接离职，最后工作日早于业务日期），账号与成员关系保持有效。 */
async function depart(w: ApprovalWorld, employeeId: string) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
  );
  await w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
    }),
    201,
  );
}

/** 员工自助教育经历变更申请，被第一节点驳回后返回实例。 */
async function returnedPersonnelRequest(w: ApprovalWorld, s: Scene) {
  await w.json(
    await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school', 'major'] } },
    }),
  );
  await w.publishedProcess({
    approvalType: 'personnel_change',
    conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
    nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school', 'major'] }],
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
        values: { school: '错别字大学' },
      },
    }),
    201,
  );
  const view = await w.instanceOf(created.id, s.subject.userId);
  return w.json<InstanceView>(await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision));
}

describe('N1（P1）：重提按“旧载荷 + 本次修正”的完整载荷复核当前自助字段白名单', () => {
  async function revokeSchool(w: ApprovalWorld) {
    await w.json(
      await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
        ifMatch: 1,
        body: { value: { education: ['major'] } },
      }),
    );
  }

  it('学校移出自助清单后，空修正重提被拒，申请保持退回', async () => {
    const w = await approvalWorld(database().db, 'apv-n1-empty');
    const s = await transferScene(w);
    const returned = await returnedPersonnelRequest(w, s);
    await revokeSchool(w);
    const response = await w.request(s.subject.userId, 'POST', `${BASE}/instances/${returned.id}/resubmit`, {
      ifMatch: returned.revision,
    });
    expect(response.status).toBe(403);
    expect((await w.detail(returned.id, s.subject.userId)).status).toBe('returned');
  });

  it('只修正其他仍合法的字段：旧载荷里的学校仍在，重提被拒', async () => {
    const w = await approvalWorld(database().db, 'apv-n1-other');
    const s = await transferScene(w);
    const returned = await returnedPersonnelRequest(w, s);
    await revokeSchool(w);
    const response = await w.request(s.subject.userId, 'POST', `${BASE}/instances/${returned.id}/resubmit`, {
      ifMatch: returned.revision,
      body: { fields: { major: '计算机' } },
    });
    expect(response.status).toBe(403);
    expect((await w.detail(returned.id, s.subject.userId)).status).toBe('returned');
  });
});

describe('N2（P1）：所有手动派单入口都不能选中已离职但账号仍有效的人', () => {
  async function scene(label: string, actions: Record<string, unknown>) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await depart(w, s.inHead.employeeId);
    await w.publishedProcess({ nodes: [{ ...TRANSFER_NODES[0]!, actions }] });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    return { w, s, view };
  }

  it('普通转交给已离职的人：400，任务不动', async () => {
    const { w, s, view } = await scene('apv-n2-transfer', { transfer: true });
    const response = await w.taskAction(s.outHead.userId, current(view).id, 'transfer', view.revision, {
      toUserId: s.inHead.userId,
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_USER_INVALID' });
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: s.outHead.userId });
  });

  it('加签名单含已离职的人：400，任务不动', async () => {
    const { w, s, view } = await scene('apv-n2-add-sign', { addSign: true });
    const response = await w.taskAction(s.outHead.userId, current(view).id, 'add-sign', view.revision, {
      userIds: [s.inHead.userId],
      type: 'before',
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_USER_INVALID' });
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: s.outHead.userId });
  });

  it('管理员转交 / 改派给已离职的人：400，任务不动', async () => {
    const { w, s, view } = await scene('apv-n2-admin', {});
    const admin = await w.member('流程管理员');
    for (const [action, body] of [
      ['admin-transfer', {}],
      ['admin-intervene', { kind: 'reassign', reason: '改派' }],
    ] as const) {
      const response = await w.instanceAction(admin, view.id, action, view.revision, {
        ...body,
        taskId: current(view).id,
        toUserId: s.inHead.userId,
      });
      expect(await reasonOf(response), action).toMatchObject({ status: 400, reason: 'APPROVAL_USER_INVALID' });
    }
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: s.outHead.userId });
  });

  it('异常管理员交接的替代人已离职：400，流程配置不变', async () => {
    const { w, s } = await scene('apv-n2-handover', {});
    const response = await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: s.inHead.userId },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_USER_INVALID' });
  });
});

/** 第二个节点 HRBP 为空 → 异常管理员待办；发起人默认是 HR。 */
async function exceptionInstance(w: ApprovalWorld, s: Scene, initiator = w.hr.id) {
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: initiator });
  let view = await w.submit(draft, initiator);
  view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
  expect(current(view)).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });
  return view;
}

describe('N3 / N4（P2）：交接不披露范围外实例，批次能往前推进', () => {
  it('N3：没有实例权限的配置管理员调用交接，响应里不出现实例 UUID 与原因，只给不可识别的提示', async () => {
    const w = await approvalWorld(database().db, 'apv-n3');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const view = await exceptionInstance(w, s);
    const successor = await w.member('新异常管理员');
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
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).not.toContain(view.id);
    expect(JSON.parse(text)).toMatchObject({ processes: 1, tasks: 0, skipped: [], unlisted: 1 });
  });

  it('N4：前 200 个实例都因本人回避跳过、第 201 个合法：凭游标翻过跳过项，下一次即可交接', async () => {
    const w = await approvalWorld(database().db, 'apv-n4');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const applicant = await w.member('发起人');
    const legal = await exceptionInstance(w, s, applicant);
    // 200 个由 HR（调用者）发起的在途实例，编号都排在合法实例之前；只读到“本人回避”就跳过，不会被打开。
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO approval_instances
        (id,tenant_id,process_id,version_id,approval_type,object_code,business_type,business_id,subject_employee_id,
         initiator_user_id,process_code,title,business_version,status,current_node_key,round,revision,
         created_at,updated_at)
        SELECT ('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,i.tenant_id,i.process_id,i.version_id,
          i.approval_type,i.object_code,i.business_type,gen_random_uuid(),i.subject_employee_id,${w.hr.id}::uuid,
          i.process_code,i.title,i.business_version,'running','in_hrbp',1,1,now(),now()
        FROM approval_instances i, generate_series(1,200) g
        WHERE i.tenant_id=${w.tenant.id} AND i.id=${legal.id}::uuid`);
      await tx.execute(sql`INSERT INTO approval_tasks
        (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,is_exception_admin,created_at)
        SELECT gen_random_uuid(),${w.tenant.id},('00000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,1,1,
          'in_hrbp',${w.exceptionAdmin}::uuid,'exception_admin','pending',true,now()
        FROM generate_series(1,200) g`);
    });
    const successor = await w.member('新异常管理员');
    type Result = { tasks: number; remaining: boolean; nextCursor: string | null; skipped: { reason: string }[] };
    const first = await w.json<Result>(
      await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    expect(first).toMatchObject({ tasks: 0, remaining: true });
    expect(first.skipped).toHaveLength(200);
    expect(new Set(first.skipped.map((item) => item.reason))).toEqual(new Set(['APPROVAL_ADMIN_SELF']));
    const second = await w.json<Result>(
      await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor, cursor: first.nextCursor },
      }),
    );
    expect(second).toMatchObject({ tasks: 1, remaining: false });
    expect(current(await w.detail(legal.id, applicant))).toMatchObject({ assigneeUserId: successor });
  });
});

describe('N6 / DEC-122（P2）：调动审批详情交付性别、年龄，按节点表单与字段查看权裁剪', () => {
  async function scene(label: string) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    const patched = await w.request(w.hr.id, 'PATCH', `/api/tenant/personnel/employees/${s.subject.employeeId}`, {
      ifMatch: 0,
      body: { gender: '女', birthday: '1990-01-15' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    await w.publishedProcess({
      nodes: [
        { ...TRANSFER_NODES[0]!, formFields: ['departmentId', 'gender', 'age'] },
        { ...TRANSFER_NODES[2]!, formFields: ['departmentId'] },
      ],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    return { w, s, view };
  }

  it('节点表单含性别、年龄：详情给出员工档案的实际值（年龄按业务日期 2026-10-01 计算为 36）', async () => {
    const { w, s, view } = await scene('apv-n6-values');
    const detail = await w.detail(view.id, s.outHead.userId);
    expect(detail.form.values).toMatchObject({ gender: '女', age: 36, departmentId: s.to });
  });

  it('节点表单不含这两个字段的审批人看不到；没有员工信息查看权的审批人也看不到', async () => {
    const { w, s, view } = await scene('apv-n6-trim');
    const noProfile = tenantApi(w.db, {
      authorize: denying(
        (resource, action) => action === 'data.scope.all' && resource === 'TenantBase.EmployeeInformation',
      ),
      clock: w.clock,
    });
    const trimmed = (await (
      await noProfile.request('GET', `${BASE}/instances/${view.id}`, w.as(s.outHead.userId))
    ).json()) as InstanceView;
    expect(trimmed.form.values).toHaveProperty('departmentId', s.to);
    expect(trimmed.form.values).not.toHaveProperty('gender');
    expect(trimmed.form.values).not.toHaveProperty('age');
    const approved = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
    );
    const later = await w.detail(approved.id, s.inHead.userId);
    expect(later.form.values).not.toHaveProperty('gender');
    expect(later.form.values).not.toHaveProperty('age');
  });

  it('性别、年龄是带出的只读字段：配置成可编辑字段被拒', async () => {
    const w = await approvalWorld(database().db, 'apv-n6-readonly');
    const response = await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
      ifMatch: 0,
      body: {
        code: 'EditGender',
        name: '编辑性别',
        approvalType: 'transfer',
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
        nodes: [
          {
            key: 'n',
            approver: 'record_department_head',
            formFields: ['gender'],
            editableFields: ['gender'],
            editMode: 'separate',
          },
        ],
      },
    });
    const body = (await response.json()) as { error: { details: { reason: string; violations: string[] } } };
    expect(response.status).toBe(400);
    expect(body.error.details.reason).toBe('APPROVAL_DEFINITION_INVALID');
    // 区分“字段不在目录”与“只读字段不可编辑”：性别是调动表单的已知字段，被拒的原因必须是只读。
    expect(body.error.details.violations.join('')).toContain('只读');
  });
});

describe('N8（P3）：详情的管理员动作按两个按钮各自的权限生成', () => {
  async function scene(label: string) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const admin = await w.member('管理员');
    return { w, view, admin };
  }

  it.each([
    ['只有转交权限', 'adminIntervene', 'adminTransfer', 'adminIntervene'],
    ['只有干预权限', 'adminTransfer', 'adminIntervene', 'adminTransfer'],
  ] as const)('%s', async (_label, denied, shown, hidden) => {
    const { w, view, admin } = await scene(`apv-n8-${denied}`);
    const api = tenantApi(w.db, {
      authorize: denying((resource) => resource.includes(`#${denied}@`)),
      clock: w.clock,
    });
    const detail = (await (
      await api.request('GET', `${BASE}/instances/${view.id}`, w.as(admin))
    ).json()) as InstanceView;
    expect(detail.actions).toContain(shown);
    expect(detail.actions).not.toContain(hidden);
  });
});

describe('DEC-123：异常管理员停用时剩余在途异常待办自动转派', () => {
  it('替代人能接手的转给替代人；替代人本人回避的转给租户管理员；写审计与 outbox', async () => {
    const w = await approvalWorld(database().db, 'apv-dec123');
    const s = await transferScene(w);
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const successor = await w.member('接任的异常管理员');
    // A：HR 本人发起，HR 交接时按 DEC-092 跳过；停用时替代人可接手。
    const ownByHr = await exceptionInstance(w, s);
    // B：替代人本人发起，交接时替代人本人回避且无直线经理而跳过；停用时转租户管理员（HR）。
    const ownBySuccessor = await exceptionInstance(w, s, successor);
    const handover = await w.json<{ skipped: { instanceId: string; reason: string }[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    expect(handover.skipped.map((item) => item.instanceId).sort()).toEqual([ownByHr.id, ownBySuccessor.id].sort());
    const revision = await membershipRevision(w, w.exceptionAdmin);
    await revokeMembership(
      w.db,
      { tenantId: w.tenant.id, userId: w.exceptionAdmin, expectedRevision: revision },
      cmd(),
    );
    expect(current(await w.detail(ownByHr.id))).toMatchObject({ assigneeUserId: successor, isExceptionAdmin: true });
    expect(current(await w.detail(ownBySuccessor.id, successor))).toMatchObject({
      assigneeUserId: w.hr.id,
      isExceptionAdmin: true,
    });
    const events = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ object_id: string; event_type: string }>(
        await tx.execute(sql`SELECT object_id::text,event_type FROM approval_outbox WHERE tenant_id=${w.tenant.id}
          AND event_type='approval.task.transferred'
          AND object_id IN (${ownByHr.id}::uuid,${ownBySuccessor.id}::uuid)`),
      ),
    );
    expect(new Set(events.map((event) => event.object_id))).toEqual(new Set([ownByHr.id, ownBySuccessor.id]));
    const audits = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ object_id: string }>(
        await tx.execute(sql`SELECT object_id FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND action='approval.instance.exception_admin_takeover'`),
      ),
    );
    expect(new Set(audits.map((row) => row.object_id))).toEqual(new Set([ownByHr.id, ownBySuccessor.id]));
  });
});

describe('DEC-124（暂定）：“历史审批人相同”只算本轮有效同意', () => {
  it('驳回重提后，上一轮的同意不参与自动处理，需重新人工审批', async () => {
    const w = await approvalWorld(database().db, 'apv-dec124');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { head: s.outHead.employeeId });
    await w.publishedProcess({
      nodes: [
        { key: 'n1', approver: 'latest_record_department_head' },
        { key: 'n2', approver: 'record_department_hrbp', rejectResubmit: 'rejecting_node' },
        { key: 'n3', approver: 'record_department_head', historySameAssigneeSkip: true },
      ],
    });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    view = await w.json(await w.taskAction(s.inHrbp.userId, current(view).id, 'reject', view.revision));
    expect(view.status).toBe('returned');
    await w.json(await w.submitRaw(await w.business(draft.id)));
    view = await w.instanceOf(draft.id);
    expect(current(view)).toMatchObject({ nodeKey: 'n2', assigneeUserId: s.inHrbp.userId });
    view = await w.json(await w.taskAction(s.inHrbp.userId, current(view).id, 'approve', view.revision));
    // 上一轮 outHead 在 n1 的同意不算历史：n3 需要 outHead 人工审批。
    expect(current(view)).toMatchObject({ nodeKey: 'n3', assigneeUserId: s.outHead.userId, origin: 'resolved' });
  });
});
