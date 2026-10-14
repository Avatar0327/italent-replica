/**
 * 第 4 轮（S3-P2-01 / S3-P2-02，拆分后第 3 轮审查）：
 * - 三笔及以上的到期队列：后序业务要对照**全部尚未解决的前序**（失败未修正的、以及因前序失败被挂起的）判断能否越过，
 *   不能只看最近一次失败——T1 新增下属 S、T2 新增无关下属 U、T3 把 S 转交给 R：10-10 调度时 T1、T2 各因区间内记录
 *   记需重建，T3 与 T1 触及同一下属，必须挂起；HR 依次重试后 S 的经理仍为 M（没有任何一笔以倒序落地去覆盖它）。
 *   已落地直接调动的生效入口（activation-checks.ts）与申请的 activate 端口走同一套前序复核。
 * - 联动足迹按落地时实际使用的有效字段计算：部门延迟继承（自动带出关闭）时，已落地的直接调动取任职记录上的部门，
 *   未落地的申请按“可能依赖”保守处理——T1 勾选部门负责人 / 店长且部门延迟继承为 O，T2 把 O 的该角色转交给 R，
 *   迟到执行时 T2 必须挂起，角色持有人不被倒序执行覆盖；按期执行的对照组最终持有人为 R。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activateWithJudgement } from '../../apps/api/src/modules/employment/activation-checks.js';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { versions } from './AC-JOB-sequence-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const REBUILD_REQUIRED = 'REBUILD_REQUIRED';
const PREDECESSOR_FAILED = 'PREDECESSOR_FAILED';
const revisionOf = async (w: ActivationWorld, employeeId: string) => (await w.session.getEmployee(employeeId)).revision;
const managerOf = async (w: ActivationWorld, hireId: string) => (await w.business(hireId)).fields.directManagerId;

function context(w: ActivationWorld, at: string) {
  return {
    tenantId: w.session.tenant.id,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now: new Date(at),
    commandId: randomUUID(),
    expectedRevision: 0,
  };
}

/** 失败 / 挂起会递增业务 revision（HR 须基于最新结果重试），任职比对时去掉它。 */
const withoutRevision = (record: object) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'revision'));

/** 任职（不含 revision）、载荷版本、人员状态：被拒绝或挂起的执行不得写入任何任职数据。 */
async function snapshot(w: ActivationWorld, employeeId: string) {
  return {
    records: (await w.session.records(employeeId, '2026-10-12')).map(withoutRevision),
    versions: await versions(w.db, w.session.tenant.id, employeeId),
    employeeStatus: (await w.session.getEmployee(employeeId)).status,
  };
}

async function expectRebuildRequired(
  w: ActivationWorld,
  late: { id: string },
  blockerIds: readonly string[],
  window: { planned: string; execution: string },
  failures = 1,
) {
  expect((await w.business(late.id)).activation).toMatchObject({
    status: 'failed',
    failureReason: REBUILD_REQUIRED,
    failureCount: failures,
  });
  const failed = (await w.auditEvents(late.id)).filter((event) => event.action === 'employment.activation.failed');
  expect(failed).toHaveLength(failures);
  const last = failed.at(-1)!;
  expect(last.after).toMatchObject({
    reason: REBUILD_REQUIRED,
    detail: { plannedEffectiveDate: window.planned, executionDate: window.execution },
  });
  const blockers = (last.after!.detail as { blockers: { id: string }[] }).blockers.map((item) => item.id);
  expect(blockers.sort()).toEqual([...blockerIds].sort());
}

async function expectSuspended(w: ActivationWorld, business: { id: string }, blockedBy: { id: string }) {
  expect((await w.business(business.id)).activation).toMatchObject({
    status: 'suspended',
    failureReason: PREDECESSOR_FAILED,
    blockedByBusinessId: blockedBy.id,
  });
}

async function directTransfer(w: ActivationWorld, employeeId: string, effectiveDate: string, fields: object) {
  return w.session.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate, fields },
    await revisionOf(w, employeeId),
  );
}

async function putLinkage(w: ActivationWorld, business: { id: string; revision: number }, body: object) {
  const response = await w.session.request('PUT', `/transfers/${business.id}/linkage`, {
    ifMatch: business.revision,
    body,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 主管 M、接收人 R、无关下属 U 入职；下属 S 入职并汇报给 M。T1 新增下属 S，T2 新增下属 U，T3 把 S 转交给 R。 */
async function chainScene(label: string) {
  const w = await activationWorld(database().db, label);
  const midOrg = await w.session.org('中间部门', { establishedOn: '2026-01-01' });
  const finalOrg = await w.session.org('最终部门', { establishedOn: '2026-01-01' });
  const m = await w.hired('调动主管 M');
  const r = await w.hired('接收人 R');
  const u = await w.hired('无关下属 U');
  const employee = await w.session.employee('下属 S');
  const hire = await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: w.from.id, directManagerId: m.employee.id, place: '原地点' },
    },
    employee.revision,
  );
  const s = { employee, hire };
  const t1 = await directTransfer(w, m.employee.id, '2026-10-05', {
    departmentId: w.to.id,
    addedSubordinateIds: [s.employee.id],
    place: 'T1',
  });
  const t2 = await directTransfer(w, m.employee.id, '2026-10-07', {
    departmentId: midOrg.id,
    addedSubordinateIds: [u.employee.id],
    place: 'T2',
  });
  const t3 = await directTransfer(w, m.employee.id, '2026-10-08', { departmentId: finalOrg.id, place: 'T3' });
  await putLinkage(w, t3, {
    dutyTransfer: {
      subordinates: [{ employeeId: s.employee.id, receiverId: r.employee.id, relation: 'direct' }],
      orgRoles: [],
    },
  });
  return { w, m, r, s, u, t1, t2, t3 };
}

it('对照组：三笔按期执行 → T1 把 S 的经理写为 M，T2 把 U 的经理写为 M，T3 把 S 转交给 R', async () => {
  const { w, m, r, s, u, t1, t2, t3 } = await chainScene('org32r4ontime');
  expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({ activated: [t1.id], failed: [], errors: [] });
  expect(await managerOf(w, s.hire.id)).toBe(m.employee.id);
  expect(await w.runScheduler('2026-10-07T01:00:00Z')).toMatchObject({ activated: [t2.id], failed: [], errors: [] });
  expect(await w.runScheduler('2026-10-08T01:00:00Z')).toMatchObject({ activated: [t3.id], failed: [], errors: [] });
  expect(await managerOf(w, s.hire.id)).toBe(r.employee.id);
  expect(await managerOf(w, u.hire.id)).toBe(m.employee.id);
});

it('S3-P2-01 三笔队列：T2 是最近一次失败且与 T3 无关，但 T3 与 T1 触及同一下属 → T3 仍按 T1 挂起；重试不改 S 的经理', async () => {
  const { w, m, s, u, t1, t2, t3 } = await chainScene('org32r4chain');
  const before = await snapshot(w, m.employee.id);
  const run = await w.runScheduler('2026-10-10T01:00:00Z');
  expect(run).toMatchObject({ activated: [], failed: [t1.id, t2.id], suspended: [t3.id], errors: [] });
  await expectRebuildRequired(w, t1, [t2.id, t3.id], { planned: '2026-10-05', execution: '2026-10-10' });
  await expectRebuildRequired(w, t2, [t3.id], { planned: '2026-10-07', execution: '2026-10-10' });
  await expectSuspended(w, t3, t1);
  expect(await managerOf(w, s.hire.id)).toBe(m.employee.id);
  expect(await managerOf(w, u.hire.id)).toBeNull();
  expect(await snapshot(w, m.employee.id)).toEqual(before);
  // HR 依次重试：T3 不能越过失败的 T1；T2、T1 的区间仍含后笔 → 再记需重建。S 的经理始终是 M——按期执行时最终为 R，
  // 但 F-036 前这组只能由 HR 处理，任何一笔都不得以倒序落地（先 T3 再 T1 会把 S 的经理写回 M 并覆盖转交结果）。
  const retriedT3 = await w.retry(t3, '2026-10-10T02:00:00Z');
  expect(retriedT3.status).toBe(409);
  expect(await retriedT3.json()).toMatchObject({
    error: { details: { reason: PREDECESSOR_FAILED, blockedByBusinessId: t1.id } },
  });
  const retriedT2 = await w.retry(t2, '2026-10-10T03:00:00Z');
  expect(retriedT2.status, await retriedT2.clone().text()).toBe(200);
  await expectRebuildRequired(w, t2, [t3.id], { planned: '2026-10-07', execution: '2026-10-10' }, 2);
  await expectSuspended(w, t3, t1);
  const retriedT1 = await w.retry(t1, '2026-10-10T04:00:00Z');
  expect(retriedT1.status, await retriedT1.clone().text()).toBe(200);
  await expectRebuildRequired(w, t1, [t2.id, t3.id], { planned: '2026-10-05', execution: '2026-10-10' }, 2);
  await expectSuspended(w, t3, t1);
  expect(await managerOf(w, s.hire.id)).toBe(m.employee.id);
  expect(await managerOf(w, u.hire.id)).toBeNull();
  expect(await snapshot(w, m.employee.id)).toEqual(before);
  expect((await w.todos()).map((item) => item.id)).toEqual([t1.id, t2.id]);
});

it('S3-P2-01 已落地直接调动的生效入口与申请 activate 端口同一套前序复核：前序失败未修正时拒绝执行、不动下属经理', async () => {
  const { w, m, s, t1, t2, t3 } = await chainScene('org32r4entry');
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [t1.id, t2.id], suspended: [t3.id] });
  const ctx = context(w, '2026-10-10T02:00:00Z');
  const failure = await withTenant(w.db, w.session.tenant.id, async (tx) => {
    const item = (await pendingActivations(tx, ctx, m.employee.id)).find((entry) => entry.id === t3.id)!;
    return activateWithJudgement(tx, ctx, item);
  });
  expect(failure).toMatchObject({ reason: 'RULE_REJECTED', detail: { rule: 'ACTIVATION_PREDECESSOR_PENDING' } });
  expect(await managerOf(w, s.hire.id)).toBe(m.employee.id);
  expect((await w.outboxEvents(t3.id)).map((event) => event.eventType)).not.toContain('employment.transfer.linked');
  expect(await w.session.record(t3.id, '2026-10-10')).toMatchObject({ effectiveDate: '2026-10-08' });
});

const ROLES = [
  { role: 'person_in_charge', flag: 'isDepartmentHead', field: 'personInChargeId', column: 'head' },
  { role: 'shop_owner', flag: 'isStoreManager', field: 'shopOwnerId', column: 'shop' },
] as const;
type Role = (typeof ROLES)[number];
const MODES = ['direct', 'application'] as const;
type Mode = (typeof MODES)[number];
const ROLE_CASES = ROLES.flatMap((role) => MODES.map((mode) => ({ role, mode, label: `${role.role}/${mode}` })));

/** 组织当前版本上的负责人 / 店长。 */
async function orgRoles(w: ActivationWorld, orgId: string) {
  return withTenant(
    w.db,
    w.session.tenant.id,
    async (tx) =>
      resultRows<{ head: string | null; shop: string | null }>(
        await tx.execute(sql`SELECT person_in_charge_id AS head, shop_owner_id AS shop FROM org_versions
        WHERE tenant_id=${w.session.tenant.id} AND org_id=${orgId} ORDER BY version_no DESC LIMIT 1`),
      )[0]!,
  );
}

/** 组织变更：把 M 设为该组织的负责人 / 店长（10-01 起生效）。 */
async function setRoleHolder(
  w: ActivationWorld,
  org: { id: string; revision: number },
  role: Role,
  employeeId: string,
) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const response = await api.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: org.revision,
    body: { [role.field]: employeeId, effectiveDate: '2026-10-01' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 关闭调动表单自动带出：未填的部门等字段延迟到生效时继承（inheritance.ts 的 deferredFieldCodes）。 */
async function deferInheritance(w: ActivationWorld) {
  const response = await w.session.request('PUT', '/transfers/settings', {
    ifMatch: 0,
    body: { unrestrictTargetDepartment: true, autoPopulate: false },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/**
 * M 原为调出部门 O 的负责人 / 店长。T1（直接调动或已批准申请）勾选该角色、不填部门 → 部门延迟继承，生效时解析为 O；
 * T2 把 M 调入最终部门并把 O 的该角色转交给 R。已批准未生效的申请会挡住新建直接调动，申请模式下先建 T2 再提 T1。
 */
async function roleScene(label: string, role: Role, mode: Mode) {
  const w = await activationWorld(database().db, label);
  const finalOrg = await w.session.org('最终部门', { establishedOn: '2026-01-01' });
  const m = await w.hired('调动主管 M');
  const r = await w.hired('接收人 R');
  await setRoleHolder(w, w.from, role, m.employee.id);
  await deferInheritance(w);
  const fields = { [role.flag]: true, place: 'T1' };
  const t1 = mode === 'direct' ? await directTransfer(w, m.employee.id, '2026-10-05', fields) : null;
  const t2 = await directTransfer(w, m.employee.id, '2026-10-07', { departmentId: finalOrg.id, place: 'T2' });
  await putLinkage(w, t2, {
    dutyTransfer: { subordinates: [], orgRoles: [{ orgId: w.from.id, role: role.role, receiverId: r.employee.id }] },
  });
  const application =
    t1 ?? (await w.approve(await w.apply(m.employee.id, '2026-10-05', fields), '2026-10-01T02:00:00Z'));
  // 前提：T1 最新载荷上部门为空（延迟继承，依赖识别只读载荷时看不到 O）；直接调动的任职记录在落地时已解析为 O。
  expect(await payloadDepartment(w, application.id)).toBeNull();
  expect((await w.business(application.id)).fields).toMatchObject({
    [role.flag]: true,
    departmentId: mode === 'direct' ? w.from.id : null,
  });
  return { w, m, r, t1: application, t2 };
}

/** 最新载荷版本上的原始部门列（不解析继承）。 */
async function payloadDepartment(w: ActivationWorld, businessId: string) {
  return withTenant(
    w.db,
    w.session.tenant.id,
    async (tx) =>
      resultRows<{ dept: string | null }>(
        await tx.execute(sql`SELECT department_id AS dept FROM employment_payload_versions
        WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid ORDER BY version_no DESC LIMIT 1`),
      )[0]!.dept,
  );
}

it.each(ROLE_CASES)('对照组 $label：按期执行时 T1 先把 M 写为 O 的角色持有人，T2 再把该角色转交给 R', async (c) => {
  const { w, r, t1, t2 } = await roleScene(`org32r4role-${c.role.role}-${c.mode}-ontime`, c.role, c.mode);
  expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({ activated: [t1.id], failed: [], errors: [] });
  expect(await w.runScheduler('2026-10-07T01:00:00Z')).toMatchObject({ activated: [t2.id], failed: [], errors: [] });
  expect((await orgRoles(w, w.from.id))[c.role.column]).toBe(r.employee.id);
});

it.each(ROLE_CASES)(
  'S3-P2-02 $label：T1 的部门延迟继承为 O，足迹仍含 O 的角色 → T2 有依赖、挂起；持有人不被倒序覆盖',
  async (c) => {
    const { w, m, t1, t2 } = await roleScene(`org32r4role-${c.role.role}-${c.mode}-late`, c.role, c.mode);
    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ activated: [], failed: [t1.id], suspended: [t2.id], errors: [] });
    await expectRebuildRequired(w, t1, [t2.id], { planned: '2026-10-05', execution: '2026-10-10' });
    await expectSuspended(w, t2, t1);
    expect((await orgRoles(w, w.from.id))[c.role.column]).toBe(m.employee.id);
    expect((await w.retry(t2, '2026-10-10T02:00:00Z')).status).toBe(409);
    const retried = await w.retry(t1, '2026-10-10T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    await expectRebuildRequired(w, t1, [t2.id], { planned: '2026-10-05', execution: '2026-10-10' }, 2);
    await expectSuspended(w, t2, t1);
    expect((await orgRoles(w, w.from.id))[c.role.column]).toBe(m.employee.id);
    expect((await w.todos()).map((item) => item.id)).toEqual([t1.id]);
  },
);
