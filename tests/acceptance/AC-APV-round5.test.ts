/**
 * PR #35 第五轮修改清单（astra 四审 R4-1～R4-7 + 覆盖补充）。
 * R4-1 交接的幂等重放按当前权限裁剪；R4-3 全局账号停用纳入审批资格并触发 DEC-123 接管；R4-4 回退的租户管理员
 * 也要有审批资格；R4-6 来源用户不是本租户成员返回 400；R4-7 范围谓词为 NULL 的实例计入不可识别数量。
 * 覆盖补充：DEC-123 在真实授权器下“替代人范围不足”与“无人接手回滚”；N6 性别、年龄分别授权。
 * R4-2（停用与派单交错）、R4-5（并发首次指定替代人）在 AC-APV-concurrency-pg.test.ts（真 PostgreSQL）。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { createUser, getUser, revokeMembership, setUserStatus, sql, withTenant } from '@italent/db';
import { APPROVAL_INSTANCE_OBJECT, MODULE_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { createProfile, grant, makeGrantable, setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import {
  approvalWorld,
  grantFieldAccess,
  permissionAdmin,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

type Scene = Awaited<ReturnType<typeof transferScene>>;
interface HandoverResult {
  tasks: number;
  skipped: { instanceId: string; reason: string }[];
  unlisted: number;
  remaining: boolean;
  nextCursor: string | null;
}

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

function denying(predicate: (resource: string, action: string) => boolean): Authorizer {
  return (request) => !predicate(String(request.resource ?? ''), request.action);
}

async function membershipRevision(w: ApprovalWorld, userId: string) {
  const rows = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
  return Number(rowsOf<{ revision: number }>(rows)[0]!.revision);
}

async function revoke(w: ApprovalWorld, userId: string) {
  const expectedRevision = await membershipRevision(w, userId);
  return revokeMembership(w.db, { tenantId: w.tenant.id, userId, expectedRevision }, cmd());
}

async function disableUser(w: ApprovalWorld, userId: string) {
  const user = await getUser(w.db, userId);
  return setUserStatus(w.db, { userId, status: 'disabled', expectedRevision: user!.revision }, cmd());
}

/** 让某人离职生效（直接离职，最后工作日早于业务日期），账号、成员关系与管理员身份保持有效。 */
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

/** 两节点调动流程，第二节点 HRBP 为空 → 异常管理员（默认 w.exceptionAdmin）待办。 */
async function exceptionWorld(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.setOrgRoles(s.to, { hrbp: null });
  await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
  return { w, s };
}

/** 生成一个异常管理员待办；发起人默认是 HR（调用交接的人，交接时按 DEC-092 跳过）。 */
async function exceptionInstance(w: ApprovalWorld, s: Scene, initiator = w.hr.id) {
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: initiator });
  let view = await w.submit(draft, initiator);
  view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
  expect(current(view)).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });
  return view;
}

function handover(w: ApprovalWorld, body: Record<string, unknown>, actor = w.hr.id) {
  return w.request(actor, 'POST', `${BASE}/exception-admins/handover`, { ifMatch: 0, body });
}

describe('R4-1（P2）：交接的幂等重放按调用者当前的范围裁剪返回结果', () => {
  it('有权执行 → 撤销实例转交权限 → 同一幂等键重放：不再返回实例编号、原因与游标，只计入不可识别数量', async () => {
    const { w, s } = await exceptionWorld('apv-r41');
    const own = await exceptionInstance(w, s);
    const successor = await w.member('新异常管理员');
    const options = {
      ...w.as(w.hr.id),
      ifMatch: 0,
      idempotencyKey: 'r41-handover',
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    };
    const first = await w.json<HandoverResult>(
      await w.api.request('POST', `${BASE}/exception-admins/handover`, options),
    );
    expect(first.skipped).toEqual([{ instanceId: own.id, reason: 'APPROVAL_ADMIN_SELF' }]);
    // 撤销实例转交按钮（流程发布权保留），用同一幂等键、同一请求体重放。
    const narrowed = tenantApi(w.db, {
      authorize: denying((resource) => resource.includes('ApprovalInstance')),
      clock: w.clock,
    });
    const replay = await narrowed.request('POST', `${BASE}/exception-admins/handover`, options);
    const text = await replay.text();
    expect(replay.status, text).toBe(200);
    expect(text).not.toContain(own.id);
    expect(JSON.parse(text)).toMatchObject({ tasks: 0, skipped: [], unlisted: 1, nextCursor: null });
  });
});

describe('R4-3（P2）：全局账号状态纳入审批资格，全局停用同样触发 DEC-123 接管与停用保护', () => {
  it('审批人账号被全局停用（成员关系仍有效）：按“审批人为空”处理，转异常管理员', async () => {
    const w = await approvalWorld(database().db, 'apv-r43-route');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    await disableUser(w, s.inHrbp.userId);
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({
      nodeKey: 'in_hrbp',
      assigneeUserId: w.exceptionAdmin,
      isExceptionAdmin: true,
    });
  });

  it('setUserStatus(disabled)：已交接的异常管理员剩余在途异常待办转给替代人，写审计与 outbox', async () => {
    const { w, s } = await exceptionWorld('apv-r43-takeover');
    const view = await exceptionInstance(w, s);
    const successor = await w.member('接任的异常管理员');
    const handed = await w.json<HandoverResult>(
      await handover(w, { fromUserId: w.exceptionAdmin, toUserId: successor }),
    );
    expect(handed.skipped.map((item) => item.instanceId)).toEqual([view.id]);
    await disableUser(w, w.exceptionAdmin);
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: successor, isExceptionAdmin: true });
    const audits = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ object_id: string }>(
        await tx.execute(sql`SELECT object_id FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND action='approval.instance.exception_admin_takeover'`),
      ),
    );
    expect(audits.map((row) => row.object_id)).toEqual([view.id]);
    const events = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ object_id: string }>(
        await tx.execute(sql`SELECT object_id::text FROM approval_outbox WHERE tenant_id=${w.tenant.id}
          AND event_type='approval.task.transferred' AND object_id=${view.id}::uuid`),
      ),
    );
    expect(events).toHaveLength(1);
  });

  it('setUserStatus(disabled)：仍是可用流程的异常管理员（未交接）时被拒绝，账号保持有效', async () => {
    const { w } = await exceptionWorld('apv-r43-guard');
    await expect(disableUser(w, w.exceptionAdmin)).rejects.toThrow('异常管理员');
    expect((await getUser(w.db, w.exceptionAdmin))!.status).toBe('active');
  });
});

describe('R4-4（P2）：替代人不能接手时，回退的租户管理员也要有审批资格', () => {
  /** 替代人本人发起的单：交接时替代人本人回避（无直线经理）而跳过，停用时替代人同样不能接手。 */
  async function scene(label: string) {
    const { w, s } = await exceptionWorld(label);
    const successor = await w.member('接任的异常管理员');
    const view = await exceptionInstance(w, s, successor);
    const handed = await w.json<HandoverResult>(
      await handover(w, { fromUserId: w.exceptionAdmin, toUserId: successor }),
    );
    expect(handed.skipped).toEqual([{ instanceId: view.id, reason: 'APPROVAL_EXCEPTION_ADMIN_SELF' }]);
    return { w, s, successor, view };
  }

  it('最早开通的租户管理员已离职：跳过，改由下一个可用的租户管理员接手', async () => {
    const { w, s, view } = await scene('apv-r44-next');
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: s.manager.userId }, cmd());
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
    await depart(w, s.manager.employeeId);
    await revoke(w, w.exceptionAdmin);
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.hr.id, isExceptionAdmin: true });
  });

  it('唯一的租户管理员已离职：无人可接手，拒绝本次停用并说明原因，什么都不改', async () => {
    const { w, s, view } = await scene('apv-r44-none');
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: s.manager.userId }, cmd());
    await depart(w, s.manager.employeeId);
    const revision = await membershipRevision(w, w.exceptionAdmin);
    const error = await revoke(w, w.exceptionAdmin).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { reason: 'APPROVAL_EXCEPTION_ADMIN_UNAVAILABLE' } });
    expect(await membershipRevision(w, w.exceptionAdmin)).toBe(revision);
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.exceptionAdmin });
  });
});

describe('R4-6（P3）：交接的来源用户不是本租户成员时返回 400，不抛 500', () => {
  it('来源用户不存在 / 只是其他租户的用户：400 APPROVAL_USER_INVALID', async () => {
    const w = await approvalWorld(database().db, 'apv-r46');
    const successor = await w.member('新异常管理员');
    const outsider = await createUser(w.db, { email: 'apv-r46-outsider@example.com', displayName: '外部用户' }, cmd());
    for (const fromUserId of ['00000000-0000-4000-8000-000000000046', outsider.id]) {
      const response = await handover(w, { fromUserId, toUserId: successor });
      expect(await reasonOf(response), fromUserId).toMatchObject({ status: 400, reason: 'APPROVAL_USER_INVALID' });
    }
  });
});

/** 给 HR（真实授权器下的租户管理员）实例转交按钮，任职记录列表的范围只有“使用用户”。 */
async function usingUserTransferAdmin(w: ApprovalWorld) {
  const world = await permissionAdmin(w);
  const profile = await createProfile(world, 'apvr47transfer');
  const set = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: [],
      buttons: [{ buttonCode: 'adminTransfer', level: 'detail' }],
    },
    APPROVAL_INSTANCE_OBJECT,
  );
  expect(set.status, await set.clone().text()).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, w.hr.id, profile.id)).status).toBe(201);
  const objectCode = MODULE_OBJECTS.employmentRecord.code;
  const policy = await world.api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/TenantBase/${objectCode}/page/${objectCode}.list`,
    { ...world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
  );
  expect(policy.status, await policy.clone().text()).toBe(200);
  return world;
}

/** 员工自助教育经历变更：第一节点同意后，第二节点 HRBP 为空 → 异常管理员待办。 */
async function personnelException(w: ApprovalWorld, s: Scene) {
  await w.json(
    await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school', 'major'] } },
    }),
  );
  await w.publishedProcess({
    approvalType: 'personnel_change',
    conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
    nodes: [
      { key: 'head', approver: 'latest_record_department_head', formFields: ['school', 'major'] },
      { key: 'hrbp', approver: 'record_department_hrbp', formFields: ['school', 'major'] },
    ],
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
  let view = await w.instanceOf(created.id, s.subject.userId);
  view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
  expect(current(view)).toMatchObject({ nodeKey: 'hrbp', assigneeUserId: w.exceptionAdmin });
  return view;
}

describe('R4-7（P3）：范围谓词为 NULL 的实例计入范围外数量，授权侧仍默认拒绝', () => {
  it('调用者范围只有“使用用户”、遗留异常待办属于员工子集变更：不交接，但计入 unlisted', async () => {
    const w = await approvalWorld(database().db, 'apv-r47');
    const s = await transferScene(w);
    const view = await personnelException(w, s);
    const world = await usingUserTransferAdmin(w);
    const successor = await w.member('新异常管理员');
    const response = await world.api.request('POST', `${BASE}/exception-admins/handover`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).not.toContain(view.id);
    expect(JSON.parse(text)).toMatchObject({ tasks: 0, skipped: [], unlisted: 1 });
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.exceptionAdmin });
  });
});

describe('覆盖补充：DEC-123 在真实授权器下的替代人范围与回滚', () => {
  /**
   * 真实授权器下 HR 是租户管理员但没有实例转交按钮：交接只替换流程配置，在途异常待办留在原异常管理员名下。
   * 停用挂接点由最后装配的应用注册，故在停用前新建一个真实授权器的应用。
   */
  async function scene(label: string, initiator: 'applicant' | 'hr') {
    const { w, s } = await exceptionWorld(label);
    const applicant = initiator === 'hr' ? w.hr.id : await w.member('发起人');
    const view = await exceptionInstance(w, s, applicant);
    const world = await permissionAdmin(w);
    const successor = await w.member('接任的异常管理员');
    const handed = await world.api.request('POST', `${BASE}/exception-admins/handover`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    });
    expect(await handed.json()).toMatchObject({ tasks: 0, unlisted: 1 });
    tenantApi(w.db, { authorize: undefined, clock: w.clock });
    return { w, view, applicant };
  }

  it('替代人没有覆盖该实例的数据范围：转租户管理员', async () => {
    const { w, view } = await scene('apv-dec123-scope', 'applicant');
    await revoke(w, w.exceptionAdmin);
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.hr.id, isExceptionAdmin: true });
  });

  it('替代人范围不足、租户管理员是本单发起人且无直线经理：无人接手，停用整体回滚', async () => {
    const { w, view } = await scene('apv-dec123-rollback', 'hr');
    const revision = await membershipRevision(w, w.exceptionAdmin);
    const error = await revoke(w, w.exceptionAdmin).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { reason: 'APPROVAL_EXCEPTION_ADMIN_UNAVAILABLE' } });
    expect(await membershipRevision(w, w.exceptionAdmin)).toBe(revision);
    expect(current(await w.detail(view.id))).toMatchObject({ assigneeUserId: w.exceptionAdmin });
    const audits = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT 1 FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND action='approval.instance.exception_admin_takeover'`),
      ),
    );
    expect(audits).toHaveLength(0);
  });
});

describe('覆盖补充：N6 真实角色下性别、年龄分别授权', () => {
  const personnelObject = PERSONNEL_OBJECTS.find((object) => object.code === PERSONNEL_OBJECT)!;

  async function scene(label: string) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    const patched = await w.request(w.hr.id, 'PATCH', `/api/tenant/personnel/employees/${s.subject.employeeId}`, {
      ifMatch: 0,
      body: { gender: '女', birthday: '1990-01-15' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    await w.publishedProcess({
      nodes: [{ ...TRANSFER_NODES[0]!, formFields: ['departmentId', 'gender', 'age'] }],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const world: PermissionWorld = await permissionAdmin(w);
    const employment = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);
    await grantFieldAccess(world, s.outHead.userId, { view: employment });
    return { w, s, view, world };
  }

  it.each([
    ['gender', 'age'],
    ['age', 'gender'],
  ] as const)('只授权员工信息的「$0」查看权：详情只给 $0', async (granted, hidden) => {
    const { w, s, view, world } = await scene(`apv-n6-${granted}`);
    await grantFieldAccess(world, s.outHead.userId, { view: [granted] }, personnelObject);
    const detail = (await (
      await world.api.request('GET', `${BASE}/instances/${view.id}`, w.as(s.outHead.userId))
    ).json()) as InstanceView;
    expect(detail.form.values).toHaveProperty(granted);
    expect(detail.form.values).not.toHaveProperty(hidden);
    expect(detail.form.values).toHaveProperty('departmentId', s.to);
  });
});
