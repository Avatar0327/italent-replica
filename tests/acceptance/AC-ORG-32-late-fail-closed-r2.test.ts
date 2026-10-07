/**
 * 第 2 轮（S1-P2-01 / S1-P2-02 / P3；DEC-278 补登“不豁免未落地申请”）：
 * - 迟到执行的窄口径 fail-closed 对未落地的迟到调动同样生效：审批落地、定时生效、HR 重试三类入口都按
 *   [计划日, 实际执行日) 判定；区间内的其他申请不分状态（草稿 / 审批中 / 已驳回 / 已批准未落地）都算；
 * - REBUILD_REQUIRED 的 blockers 不受 DEC-112 前序失败门禁挂起：后一笔区间为空先顺延，HR 再重试前一笔即成功；
 * - 区间内记录超过上限时仍记 REBUILD_REQUIRED，blockers 截断并标记 truncated。
 * 每例比对任职 / 载荷版本 / 时间轴（占编由它投影）/ 人员状态 / 调编占用的前后快照。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { lateWindowBlockers } from '../../apps/api/src/modules/employment/late-transfer.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import { versions } from './AC-JOB-sequence-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
const REBUILD_REQUIRED = 'REBUILD_REQUIRED';
const STATES = ['draft', 'in_review', 'rejected', 'approved'] as const;
type State = (typeof STATES)[number];
const UNMATERIALIZED = ['draft', 'in_review', 'rejected'] as const;
const LINKS = ['head', 'store', 'subordinate', 'cross'] as const;
type Link = (typeof LINKS)[number];
const departmentBefore = (record: { readonly before?: unknown }) =>
  (record.before as { fields: { departmentId: string | null } } | null)?.fields.departmentId;

function context(w: ActivationWorld, expectedRevision: number, at = '2026-10-01T01:00:00Z') {
  return {
    tenantId: w.session.tenant.id,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now: new Date(at),
    commandId: randomUUID(),
    expectedRevision,
  };
}

const revisionOf = async (w: ActivationWorld, employeeId: string) => (await w.session.getEmployee(employeeId)).revision;

/** 同一员工的另一笔调动申请，置于指定状态；已批准的在 10-01 批准、等待生效。 */
async function application(w: ActivationWorld, employeeId: string, effectiveDate: string, state: State) {
  const fields = { place: '申请地点' };
  if (state === 'draft')
    return w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'application', effectiveDate, fields },
      await revisionOf(w, employeeId),
    );
  const applied = await w.apply(employeeId, effectiveDate, fields);
  if (state === 'in_review') return applied;
  if (state === 'approved') return w.approve(applied, '2026-10-01T02:00:00Z');
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    transitionEmployment(tx, context(w, applied.revision), { id: applied.id, action: 'reject' }),
  );
  return applied;
}

/** 计划 10-05 调入“调入部门”的调动申请（审批中）；何时批准由调用方决定。 */
function lateApplication(w: ActivationWorld, employeeId: string) {
  return w.apply(employeeId, '2026-10-05', { departmentId: w.to.id, place: '新地点' });
}

async function lateDirect(w: ActivationWorld, employeeId: string, departmentId: string, effectiveDate = '2026-10-05') {
  return w.session.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId, place: '新地点' } },
    await revisionOf(w, employeeId),
  );
}

/** 带联动的直接未来调动：部门负责人 / 店长 / 新增下属 / 已有跨对象联动版本（待调薪）。 */
async function linkedTransfer(
  w: ActivationWorld,
  employeeId: string,
  departmentId: string,
  effectiveDate: string,
  link: Link,
  subordinateId: string,
) {
  const linkage = {
    head: { isDepartmentHead: true },
    store: { isStoreManager: true },
    subordinate: { addedSubordinateIds: [subordinateId] },
    cross: {},
  }[link];
  const business = await w.session.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId, place: `${link}地点`, ...linkage } },
    await revisionOf(w, employeeId),
  );
  if (link === 'cross') {
    const response = await w.session.request('PUT', `/transfers/${business.id}/linkage`, {
      ifMatch: business.revision,
      body: { adjustSalary: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  return business;
}

/** 任职、载荷版本、时间轴（区间与顺序号）、人员状态、调编占用：被拒绝的迟到执行不得写入任何任职数据。 */
async function snapshot(w: ActivationWorld, employeeId: string) {
  const tenantId = w.session.tenant.id;
  const [timeline, allocations] = await withTenant(w.db, tenantId, async (tx) => [
    resultRows(
      await tx.execute(sql`SELECT record_id AS id, start_date::text AS date, sort_order AS "order",
        valid_during::text AS during FROM employment_timeline
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY start_date, sort_order`),
    ),
    resultRows(
      await tx.execute(sql`SELECT a.business_id AS "businessId", a.capacity_id AS "capacityId",
        a.local_delta AS local, a.inclusive_delta AS inclusive, a.reversed
      FROM transfer_establishment_allocations a
      JOIN employment_business_objects b ON b.tenant_id=a.tenant_id AND b.id=a.business_id
      WHERE a.tenant_id=${tenantId} AND b.employee_id=${employeeId}::uuid ORDER BY a.created_at, a.id`),
    ),
  ]);
  return {
    records: await w.session.records(employeeId, '2026-10-12'),
    versions: await versions(w.db, tenantId, employeeId),
    employeeStatus: (await w.session.getEmployee(employeeId)).status,
    timeline,
    allocations,
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
  expect((await w.todos()).find((item) => item.id === late.id)?.activation).toMatchObject({
    status: 'failed',
    failureReason: REBUILD_REQUIRED,
  });
  const events = await w.auditEvents(late.id);
  const failed = events.filter((event) => event.action === 'employment.activation.failed');
  expect(failed).toHaveLength(failures);
  const last = failed.at(-1)!;
  expect(last.after).toMatchObject({
    reason: REBUILD_REQUIRED,
    detail: { plannedEffectiveDate: window.planned, executionDate: window.execution, truncated: false },
  });
  const blockers = (last.after!.detail as { blockers: { id: string }[] }).blockers.map((item) => item.id);
  expect(blockers.sort()).toEqual([...blockerIds].sort());
  // 被拒绝的迟到执行不改期、不追加载荷版本。
  expect(events.some((event) => event.action === 'employment.transfer.rescheduled')).toBe(false);
}

it.each(STATES)(
  'S1-P2-01 审批落地：区间内有未落地申请（%s）→ 批准成功但不落地，记需重建待 HR，任职不变',
  async (state) => {
    const w = await activationWorld(database().db, `org32r2apv-${state}`);
    const person = await w.hired();
    const late = await lateApplication(w, person.employee.id);
    const other = await application(w, person.employee.id, '2026-10-08', state);
    const before = await snapshot(w, person.employee.id);
    expect((await w.approve(late, '2026-10-10T01:00:00Z')).status).toBe('approved');
    await expectRebuildRequired(w, late, [other.id], { planned: '2026-10-05', execution: '2026-10-10' });
    expect(await snapshot(w, person.employee.id)).toEqual(before);
    expect((await w.business(other.id)).status).toBe(state);
  },
);

it.each(UNMATERIALIZED)(
  'S1-P2-01 定时生效与 HR 重试：已批准申请迟到执行，区间内有未落地申请（%s）→ 记需重建，重试仍失败',
  async (state) => {
    const w = await activationWorld(database().db, `org32r2sch-${state}`);
    const person = await w.hired();
    const late = await w.approve(await lateApplication(w, person.employee.id), '2026-10-01T02:00:00Z');
    expect(late.status).toBe('approved');
    const other = await application(w, person.employee.id, '2026-10-08', state);
    const before = await snapshot(w, person.employee.id);
    expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({
      activated: [],
      failed: [late.id],
      errors: [],
    });
    await expectRebuildRequired(w, late, [other.id], { planned: '2026-10-05', execution: '2026-10-10' });
    expect(await snapshot(w, person.employee.id)).toEqual(before);
    const retried = await w.retry(late, '2026-10-11T01:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    await expectRebuildRequired(w, late, [other.id], { planned: '2026-10-05', execution: '2026-10-11' }, 2);
    expect(await snapshot(w, person.employee.id)).toEqual(before);
    expect((await w.business(other.id)).status).toBe(state);
  },
);

it('S1-P2-02 后一笔为已批准未落地申请：不被前序失败门禁挡住、区间为空先顺延；HR 重试前一笔后按原计划日排序', async () => {
  const w = await activationWorld(database().db, 'org32r2approved');
  const person = await w.hired();
  const late = await w.approve(await lateApplication(w, person.employee.id), '2026-10-01T02:00:00Z');
  const other = await application(w, person.employee.id, '2026-10-08', 'approved');
  const run = await w.runScheduler('2026-10-10T01:00:00Z');
  expect(run).toMatchObject({ failed: [late.id], errors: [] });
  expect(run.activated).toEqual([other.id]);
  await expectRebuildRequired(w, late, [other.id], { planned: '2026-10-05', execution: '2026-10-10' });
  expect((await w.business(other.id)).activation).toMatchObject({ status: 'effective' });
  expect(await w.session.record(other.id, '2026-10-10')).toMatchObject({ effectiveDate: '2026-10-10', isCurrent: true });
  const retried = await w.retry(late, '2026-10-10T02:00:00Z');
  expect(retried.status, await retried.clone().text()).toBe(200);
  expect((await w.business(late.id)).activation).toMatchObject({ status: 'effective' });
  const sameDay = (await w.session.records(person.employee.id, '2026-10-10')).filter(
    (r) => r.effectiveDate === '2026-10-10',
  );
  expect(sameDay.map((r) => r.id)).toEqual([late.id, other.id]);
  expect(sameDay.find((r) => r.isCurrent)?.id).toBe(other.id);
  // 前一笔补插在后一笔之前：R1 向后更新把后一笔的部门从调出部门改为调入部门，后一笔的“变更前”读到前一笔。
  expect(departmentBefore(await w.session.record(other.id, '2026-10-10'))).toBe(w.to.id);
});

it.each(['rejected', 'approved'] as const)(
  'P3 已落地的直接未来调动：区间内有%s的申请 → 记需重建待 HR',
  async (state) => {
    const w = await activationWorld(database().db, `org32r2direct-${state}`);
    const person = await w.hired();
    const late = await lateDirect(w, person.employee.id, w.to.id);
    const other = await application(w, person.employee.id, '2026-10-08', state);
    const before = await snapshot(w, person.employee.id);
    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ failed: [late.id], errors: [] });
    await expectRebuildRequired(w, late, [other.id], { planned: '2026-10-05', execution: '2026-10-10' });
    if (state === 'rejected') {
      expect(await snapshot(w, person.employee.id)).toEqual(before);
      expect((await w.business(other.id)).status).toBe('rejected');
      return;
    }
    // 已批准的后笔是前序失败的 blocker：不挂起，区间为空照常顺延落地。
    expect(run.activated).toEqual([other.id]);
    expect(await w.session.record(other.id, '2026-10-10')).toMatchObject({ effectiveDate: '2026-10-10', isCurrent: true });
  },
);

it.each(STATES)('反例：申请的载荷生效日在区间外（%s）→ 已批准申请的迟到执行照常顺延', async (state) => {
  const w = await activationWorld(database().db, `org32r2outside-${state}`);
  const person = await w.hired();
  const late = await w.approve(await lateApplication(w, person.employee.id), '2026-10-01T02:00:00Z');
  const other = await application(w, person.employee.id, '2026-10-12', state);
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ activated: [late.id], failed: [], errors: [] });
  expect(await w.session.record(late.id, '2026-10-10')).toMatchObject({
    effectiveDate: '2026-10-10',
    isCurrent: true,
    fields: { departmentId: w.to.id },
  });
  const events = await w.auditEvents(late.id);
  expect(events.filter((event) => event.action === 'employment.transfer.rescheduled')).toHaveLength(1);
  expect(events.some((event) => event.action === 'employment.activation.failed')).toBe(false);
  expect((await w.business(other.id)).status).toBe(state);
});

it('反例：区间为空的简单迟到审批落地：改到批准当天生效并保留计划日审计', async () => {
  const w = await activationWorld(database().db, 'org32r2simple');
  const person = await w.hired();
  const late = await lateApplication(w, person.employee.id);
  expect((await w.approve(late, '2026-10-10T01:00:00Z')).status).toBe('effective');
  expect(await w.session.record(late.id, '2026-10-10')).toMatchObject({
    effectiveDate: '2026-10-10',
    isCurrent: true,
    fields: { departmentId: w.to.id },
  });
  const events = await w.auditEvents(late.id);
  expect(events.filter((event) => event.action === 'employment.transfer.rescheduled')).toHaveLength(1);
  expect(events.find((event) => event.action === 'employment.transfer.rescheduled')!.after).toMatchObject({
    originalEffectiveDate: '2026-10-05',
    effectiveDate: '2026-10-10',
  });
  expect(events.some((event) => event.action === 'employment.activation.failed')).toBe(false);
});

const MATRIX = LINKS.flatMap((first) => LINKS.map((second) => [first, second] as const));
it.each(MATRIX)(
  'S1-P2-02 两笔带联动的迟到调动（前 %s / 后 %s）：后笔不被挂起、区间为空先顺延；重试前笔成功并按原计划日排序',
  async (first, second) => {
    const w = await activationWorld(database().db, `org32r2lnk-${first}-${second}`);
    const finalOrg = await w.session.org('最终部门', { establishedOn: '2026-01-01' });
    const person = await w.hired();
    const subordinate = await w.hired('下属');
    const one = await linkedTransfer(w, person.employee.id, w.to.id, '2026-10-05', first, subordinate.employee.id);
    const two = await linkedTransfer(w, person.employee.id, finalOrg.id, '2026-10-07', second, subordinate.employee.id);
    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ failed: [one.id], errors: [] });
    // 带联动的后笔不是 reminderOnly：不因前序失败挂起，顺延落地后计入 activated。
    expect(run.activated).toEqual([two.id]);
    await expectRebuildRequired(w, one, [two.id], { planned: '2026-10-05', execution: '2026-10-10' });
    expect((await w.business(two.id)).activation).toMatchObject({ status: 'effective' });
    expect(await w.session.record(two.id, '2026-10-10')).toMatchObject({ effectiveDate: '2026-10-10', isCurrent: true });
    const retried = await w.retry(one, '2026-10-10T02:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await w.business(one.id)).activation).toMatchObject({ status: 'effective' });
    const sameDay = (await w.session.records(person.employee.id, '2026-10-10')).filter(
      (r) => r.effectiveDate === '2026-10-10',
    );
    expect(sameDay.map((r) => r.id)).toEqual([one.id, two.id]);
    expect(sameDay.find((r) => r.isCurrent)).toMatchObject({ id: two.id, fields: { departmentId: finalOrg.id } });
    expect(departmentBefore(await w.session.record(two.id, '2026-10-10'))).toBe(w.to.id);
  },
);

it('P3：区间内记录超过上限时仍按 REBUILD_REQUIRED 表达，blockers 截断并标记 truncated', async () => {
  const w = await activationWorld(database().db, 'org32r2trunc');
  const person = await w.hired();
  const late = await lateDirect(w, person.employee.id, w.to.id);
  const drafts = [];
  for (const day of ['06', '07', '08']) drafts.push(await application(w, person.employee.id, `2026-10-${day}`, 'draft'));
  const business = { id: late.id, employeeId: person.employee.id };
  const ctx = context(w, 0, '2026-10-10T01:00:00Z');
  const truncated = await withTenant(w.db, w.session.tenant.id, (tx) =>
    lateWindowBlockers(tx, ctx, business, '2026-10-05', '2026-10-10', 2),
  );
  expect(truncated).toMatchObject({ truncated: true });
  expect(truncated.blockers.map((item) => item.id)).toEqual(drafts.slice(0, 2).map((item) => item.id));
  const all = await withTenant(w.db, w.session.tenant.id, (tx) =>
    lateWindowBlockers(tx, ctx, business, '2026-10-05', '2026-10-10'),
  );
  expect(all).toMatchObject({ truncated: false });
  expect(all.blockers.map((item) => item.id).sort()).toEqual(drafts.map((item) => item.id).sort());
});
