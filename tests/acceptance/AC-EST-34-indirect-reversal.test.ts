/**
 * AC-EST-34（DEC-273）：撤权 / 停用 / 移出成员、异常管理员交接合席等**服务端间接触发**的会签结算回退，使原部门超编时
 * 不要求确认、不阻断：照常完成，记超编警告审计（带来源标记），响应附一条不阻断的通用提示（DEC-284：不带任何
 * 具体信息，对所有操作人相同；幂等重放只返回处理状态）。显式入口（审批人自己点不同意）不带 confirmed 仍须
 * 409 CONFIRMATION_REQUIRED（严格 / 非严格两档）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createUser, eq, grantMembership, orgHierarchyLinks, orgVersions, sql, withTenant, type Db } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { InstanceView } from './AC-APV-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00Z';
const AUDIT = 'employment.establishment.exceeded-confirmed';
const APPROVAL = '/api/tenant/approval';
const USERS = '/api/tenant/permission/users';
const GENERIC_WARNING = {
  reason: 'ESTABLISHMENT_EXCEEDED',
  message: '此操作导致编制超编，已记录警告，可在编制管理中查看（按你的权限）',
};
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;
const ESTABLISHMENT = MODULE_OBJECTS.establishment.code;

/** 可信夹具：追加一条组织版本写入负责人（人员 ID），与 AC-APV-support.setOrgRoles 相同。 */
async function setOrgHead(db: Db, tenantId: string, orgId: string, personId: string) {
  await withTenant(db, tenantId, async (tx) => {
    const [old] = await tx
      .select()
      .from(orgVersions)
      .where(eq(orgVersions.orgId, orgId))
      .orderBy(sql`version_no DESC`)
      .limit(1);
    const versionId = randomUUID();
    await tx.insert(orgVersions).values({
      ...old!,
      id: versionId,
      versionNo: old!.versionNo + 1,
      previousVersionId: old!.id,
      personInChargeId: personId,
    });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
  });
}

async function userOfEmployee(db: Db, tenantId: string, employeeId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT user_id AS "userId" FROM permission_user_person_links
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { userId: string }[] }).rows) as {
      userId: string;
    }[];
    expect(rows).toHaveLength(1);
    return rows[0]!.userId;
  });
}

/**
 * 两人会签、不同意比例 100%：甲从满编部门（容量 1 的调入部门）申请调出，预减的空位被乙占用；
 * 会签席位一为调入部门负责人 A（已不同意），另一席无人解析 → 异常管理员 B 待办。任何使 B 这一席并入 A 的间接结算
 * 都会沿「不同意」办结申请、恢复甲在原部门的占用而超编。
 */
async function countersignWorld(strict: boolean) {
  const w = await carriedWorld(database().db, 'indirect-reversal');
  await configure(w, strict);
  const tenant = w.session.tenant.id;
  const hr = w.session.user.id;
  const api = tenantApi(w.db, { clock: () => new Date(NOW) });
  const as = (user: string) => ({ user, tenant });
  const suffix = randomBytes(3).toString('hex');
  const admin = await createUser(w.db, { email: `indirect-${suffix}@example.com`, displayName: '异常管理员B' }, cmd());
  await grantMembership(w.db, { tenantId: tenant, userId: admin.id, expectedRevision: 0 }, cmd());
  // DEC-092：管理员不得干预本人发起的实例，交接与撤权由独立的配置管理员发起。
  const operator = await createUser(
    w.db,
    { email: `operator-${suffix}@example.com`, displayName: '配置管理员' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: tenant, userId: operator.id, expectedRevision: 0 }, cmd());
  // 审批人 A：入职即按 DEC-140 建账号并绑定（放在独立部门，不占调出 / 调入部门的编制）；设为调入部门负责人。
  const approverOrg = await w.session.org('审批人部门', { establishedOn: '2026-01-01' });
  const approverEmployee = await w.session.employee('审批人A');
  await w.session.business(
    approverEmployee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: approverOrg.id } },
    approverEmployee.revision,
  );
  const approverUserId = await userOfEmployee(w.db, tenant, approverEmployee.id);
  await setOrgHead(w.db, tenant, w.to.id, approverEmployee.id);
  const created = await api.request('POST', `${APPROVAL}/processes`, {
    ...as(hr),
    ifMatch: 0,
    body: {
      code: `INDIRECT_${suffix}`,
      approvalType: 'transfer',
      name: '间接回退验收流程',
      exceptionAdminUserId: admin.id,
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
      // 首节点必须能解析出审批人（APPROVAL_FIRST_NODE_EMPTY），会签放在第二节点。
      nodes: [
        { key: 'first', name: '调入部门负责人审批', approver: 'latest_record_department_head' },
        {
          key: 'joint',
          name: '两人会签',
          kind: 'countersign',
          approvers: ['latest_record_department_head', 'record_department_head'],
          exits: ['approve', 'disagree'],
          transitionRule: {
            type: 'custom',
            rules: { approve: { kind: 'percent', value: 100 }, disagree: { kind: 'percent', value: 100 } },
          },
        },
      ],
    },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const process = (await created.json()) as { id: string; revision: number };
  const published = await api.request('POST', `${APPROVAL}/processes/${process.id}/publish`, {
    ...as(hr),
    ifMatch: process.revision,
  });
  expect(published.status, await published.clone().text()).toBe(200);

  const a = await w.hired('甲');
  const b = await w.hired('乙');
  expect((await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-01' })).status).toBe(201);
  const outgoing = await w.save(a, {
    withEstablishment: false,
    mode: 'application',
    submit: true,
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(outgoing.status, await outgoing.clone().text()).toBe(201);
  const application = (await outgoing.json()) as { id: string; revision: number };
  const incoming = await w.save(b, { withEstablishment: false });
  expect(incoming.status, await incoming.clone().text()).toBe(201);

  async function instance(): Promise<InstanceView> {
    const list = await api.request('GET', `${APPROVAL}/instances?role=initiated&businessId=${application.id}`, as(hr));
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: { id: string }[] };
    expect(items).toHaveLength(1);
    const detail = await api.request('GET', `${APPROVAL}/instances/${items[0]!.id}`, as(hr));
    expect(detail.status).toBe(200);
    return (await detail.json()) as InstanceView;
  }
  const pendingOf = (view: InstanceView, userId: string) =>
    view.tasks.find((task) => task.status === 'pending' && task.assigneeUserId === userId);
  async function decide(userId: string, action: 'approve' | 'disagree', confirmed?: boolean) {
    const view = await instance();
    const task = pendingOf(view, userId);
    expect(task, JSON.stringify(view.tasks)).toBeDefined();
    return api.request('POST', `${APPROVAL}/tasks/${task!.id}/${action}`, {
      ...as(userId),
      ifMatch: view.revision,
      body: { comment: null, ...(confirmed === undefined ? {} : { confirmed }) },
    });
  }
  const disagree = (userId: string, confirmed?: boolean) => decide(userId, 'disagree', confirmed);
  // A 通过首节点；会签节点 A 先不同意（1/2，未达 100%），B 的异常待办仍在。
  const approved = await decide(approverUserId, 'approve');
  expect(approved.status, await approved.clone().text()).toBe(200);
  const first = await disagree(approverUserId);
  expect(first.status, await first.clone().text()).toBe(200);
  const view = await instance();
  expect(view.status).toBe('running');
  expect(pendingOf(view, admin.id)).toBeDefined();

  async function snapshot() {
    const view = await instance();
    return {
      business: await w.business(application.id),
      instance: view.status,
      tasks: view.tasks.map((task) => [task.nodeKey, task.assigneeUserId, task.status, task.origin]),
      logs: view.logs.map((log) => log.event),
      employee: await w.session.getEmployee(a.employee.id),
      records: await w.session.records(a.employee.id, '2026-10-05'),
      occupant: await w.session.records(b.employee.id, '2026-10-05'),
      audit: (await w.auditEvents(application.id)).map((event) => event.action),
    };
  }
  return {
    ...w,
    api,
    as,
    hr,
    operator: operator.id,
    admin: admin.id,
    approverUserId,
    a,
    b,
    application,
    instance,
    disagree,
    snapshot,
  };
}

type Indirect = Awaited<ReturnType<typeof countersignWorld>>;
function helpers(w: Indirect) {
  const handover = (body: Record<string, unknown>) =>
    w.api.request('POST', `${APPROVAL}/exception-admins/handover`, { ...w.as(w.operator), ifMatch: 0, body });
  async function member(userId: string) {
    const response = await w.api.request('GET', `${USERS}/${userId}`, w.as(w.hr));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { membershipStatus: string; membershipRevision: number };
  }
  const auditOf = async () => (await w.auditEvents(w.application.id)).filter((event) => event.action === AUDIT);
  return { handover, member, auditOf };
}

type Snapshot = Awaited<ReturnType<Indirect['snapshot']>>;

/** 单据 / 实例办结为不同意；合席、会签流转与不同意日志新增；待办清空；业务与员工 revision 各递增一次。 */
async function expectDisapproved(w: Indirect, origin: string, before: Snapshot) {
  const after = await w.snapshot();
  expect(after.business.status).toBe('disapproved');
  expect(after.instance).toBe('disapproved');
  expect(after.tasks.filter((task) => task[2] === 'pending')).toEqual([]);
  expect(after.tasks).toContainEqual(['joint', w.approverUserId, 'merged', 'handover']);
  expect(after.logs.slice(before.logs.length)).toEqual(
    expect.arrayContaining(['countersign_merge', 'countersign_flow', 'disapprove']),
  );
  expect(after.business.revision).toBe(before.business.revision + 1);
  expect(after.employee.revision).toBe(before.employee.revision + 1);
  expect(after.occupant).toEqual(before.occupant);
  const audits = await helpers(w).auditOf();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.after).toMatchObject({ reason: 'ESTABLISHMENT_EXCEEDED', action: 'disapprove', origin });
  expect(audits[0]!.after).toMatchObject({ confirmed: false });
  return after;
}

/** 响应里的提示只有通用文案：不含部门 / 职位 / 业务 / 员工 ID（DEC-284①）。 */
function expectGenericOnly(w: Indirect, body: unknown) {
  const text = JSON.stringify(body);
  for (const id of [w.to.id, w.from.id, w.targetPosition, w.application.id, w.a.employee.id])
    expect(text).not.toContain(id);
}

for (const strict of [false, true])
  it(`AC-EST-34 异常管理员交接合席触发不同意：不弹确认、只记警告并附提示 strict=${strict}`, async () => {
    const w = await countersignWorld(strict);
    const { handover } = helpers(w);
    const before = await w.snapshot();
    const response = await handover({ fromUserId: w.admin, toUserId: w.approverUserId });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { tasks: number; establishmentWarning: unknown };
    expect(body.tasks).toBe(1);
    expect(body.establishmentWarning).toEqual(GENERIC_WARNING);
    expectGenericOnly(w, body);
    await expectDisapproved(w, 'admin-handover', before);
  });

it('AC-EST-34 交接幂等重放只返回处理状态：撤去编制查看权后同键重放不带提示，状态与日志不变', async () => {
  const w = await countersignWorld(false);
  const before = await w.snapshot();
  const key = `handover-replay-${w.application.id.slice(0, 8)}`;
  const body = { fromUserId: w.admin, toUserId: w.approverUserId };
  const first = await w.api.request('POST', `${APPROVAL}/exception-admins/handover`, {
    ...w.as(w.operator),
    ifMatch: 0,
    idempotencyKey: key,
    body,
  });
  expect(first.status, await first.clone().text()).toBe(200);
  expect(((await first.json()) as { establishmentWarning: unknown }).establishmentWarning).toEqual(GENERIC_WARNING);
  const after = await expectDisapproved(w, 'admin-handover', before);
  // 撤去操作人的编制查看权后重放：只返回处理状态，不再带首次的提示。
  const authorize: Authorizer = (request) =>
    !(request.userId === w.operator && request.resource === ESTABLISHMENT && request.action === 'object.view');
  const revokedApi = tenantApi(w.db, { clock: () => new Date(NOW), authorize });
  const replay = await revokedApi.request('POST', `${APPROVAL}/exception-admins/handover`, {
    ...w.as(w.operator),
    ifMatch: 0,
    idempotencyKey: key,
    body,
  });
  expect(replay.status, await replay.clone().text()).toBe(200);
  const replayed = (await replay.json()) as Record<string, unknown>;
  expect(replayed).toMatchObject({ processes: 1, tasks: 1 });
  expect(replayed).not.toHaveProperty('establishmentWarning');
  expect(replayed).not.toHaveProperty('establishmentWarnings');
  expectGenericOnly(w, replayed);
  expect(await w.snapshot()).toEqual(after);
});

for (const strict of [false, true])
  for (const path of ['status', 'remove'] as const)
    it(`AC-EST-34 成员${path === 'status' ? '停用' : '移出租户'}接管合席：撤权照常生效、记警告并附提示 strict=${strict}`, async () => {
      const w = await countersignWorld(strict);
      const { handover, member } = helpers(w);
      const view = await w.instance();
      // 先只指定替代人（游标越过本实例，不转派），使 B 不再是可用流程的异常管理员、可以被停用。
      const designated = await handover({ fromUserId: w.admin, toUserId: w.approverUserId, cursor: view.id });
      expect(designated.status, await designated.clone().text()).toBe(200);
      expect(((await designated.json()) as { tasks: number }).tasks).toBe(0);
      expect((await w.instance()).status).toBe('running');
      const before = await w.snapshot();
      const membership = await member(w.admin);
      const revoked = await w.api.request('POST', `${USERS}/${w.admin}/${path}`, {
        ...w.as(w.operator),
        ifMatch: membership.membershipRevision,
        ...(path === 'status' ? { body: { status: 'disabled' } } : {}),
      });
      expect(revoked.status, await revoked.clone().text()).toBe(200);
      const receipt = await revoked.json();
      expect(receipt).toEqual({
        userId: w.admin,
        membershipStatus: 'revoked',
        membershipRevision: membership.membershipRevision + 1,
        establishmentWarning: GENERIC_WARNING,
      });
      expectGenericOnly(w, receipt);
      expect((await member(w.admin)).membershipStatus).toBe('revoked');
      await expectDisapproved(w, 'membership-revocation', before);
    });

it('AC-EST-34 负向：无任职查看权、有编制范围的操作人停用成员：停用成功，提示只有通用文案', async () => {
  const w = await countersignWorld(false);
  const { handover, member } = helpers(w);
  const view = await w.instance();
  expect((await handover({ fromUserId: w.admin, toUserId: w.approverUserId, cursor: view.id })).status).toBe(200);
  const before = await w.snapshot();
  const membership = await member(w.admin);
  const authorize: Authorizer = (request) =>
    !(request.userId === w.operator && request.resource === EMPLOYMENT && request.action === 'object.view');
  const restricted = tenantApi(w.db, { clock: () => new Date(NOW), authorize });
  const revoked = await restricted.request('POST', `${USERS}/${w.admin}/status`, {
    ...w.as(w.operator),
    ifMatch: membership.membershipRevision,
    body: { status: 'disabled' },
  });
  expect(revoked.status, await revoked.clone().text()).toBe(200);
  const receipt = await revoked.json();
  expect(receipt).toEqual({
    userId: w.admin,
    membershipStatus: 'revoked',
    membershipRevision: membership.membershipRevision + 1,
    establishmentWarning: GENERIC_WARNING,
  });
  expectGenericOnly(w, receipt);
  await expectDisapproved(w, 'membership-revocation', before);
});

for (const strict of [false, true])
  it(`AC-EST-34 负向：异常管理员本人点不同意仍须确认 strict=${strict}`, async () => {
    const w = await countersignWorld(strict);
    const before = await w.snapshot();
    await warning(await w.disagree(w.admin), false);
    expect(await w.snapshot()).toEqual(before);
    const confirmed = await w.disagree(w.admin, true);
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const audits = await helpers(w).auditOf();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ origin: 'explicit', confirmed: true, strictControl: strict });
    expect((await w.business(w.application.id)).status).toBe('disapproved');
  });
