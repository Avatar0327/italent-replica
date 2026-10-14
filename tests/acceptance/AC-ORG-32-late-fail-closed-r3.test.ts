/**
 * 第 3 轮（S2-P2-01 / S2-P2-02，拆分后第 2 轮审查）：
 * - 已顺延但尚未落地的申请（批准当天因前序未落地留在队列）同日再执行时，必须先按原计划日复核 [原计划日, 执行日) 的
 *   blockers，再决定要不要追加改期版本；期间补入的组织调整要让它记 REBUILD_REQUIRED，任职不变（定时生效与 HR 重试）。
 * - REBUILD_REQUIRED 的 blockers 豁免只在前后两笔没有跨对象联动依赖时成立：两笔触及同一个下属（新增下属 / 职责转交）
 *   时维持 DEC-112 门禁，后笔挂起、不生效，下属的经理不被倒序执行覆盖；按期执行的对照组最终经理为接收人。
 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { versions } from './AC-JOB-sequence-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const REBUILD_REQUIRED = 'REBUILD_REQUIRED';
const revisionOf = async (w: ActivationWorld, employeeId: string) => (await w.session.getEmployee(employeeId)).revision;
const managerOf = async (w: ActivationWorld, hireId: string) => (await w.business(hireId)).fields.directManagerId;

/** F-007：改名选是 → 该组织在职员工在生效日各追加一条组织调整。 */
async function rename(w: ActivationWorld, org: { id: string; name: string; revision: number }, effectiveDate: string) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const response = await api.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: org.revision,
    body: { name: `${org.name}改名`, effectiveDate, addEmployment: true },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function snapshot(w: ActivationWorld, employeeId: string) {
  return {
    records: await w.session.records(employeeId, '2026-10-12'),
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
  expect((await w.todos()).find((item) => item.id === late.id)?.activation).toMatchObject({
    status: 'failed',
    failureReason: REBUILD_REQUIRED,
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

it('S2-P2-01 已顺延未落地的申请同日再执行：按原计划日复核区间，补入的组织调整 → 记需重建，任职不变；HR 重试同样', async () => {
  const w = await activationWorld(database().db, 'org32r3deferred');
  const person = await w.hired();
  const t1 = await w.approve(await w.apply(person.employee.id, '2026-10-05', { place: 'T1' }), '2026-10-01T02:00:00Z');
  // T1 尚未落地：T2 在 10-10 批准时只顺延到批准日、仍为审批通过（DEC-195②）。
  const t2 = await w.approve(
    await w.apply(person.employee.id, '2026-10-07', { departmentId: w.to.id, place: 'T2' }),
    '2026-10-10T01:00:00Z',
  );
  expect(t2).toMatchObject({ status: 'approved', effectiveDate: '2026-10-10' });
  await rename(w, w.from, '2026-10-08');
  const adjustment = (await w.session.records(person.employee.id, '2026-10-08')).find(
    (r) => r.kind === 'org_adjustment',
  )!;
  const before = await snapshot(w, person.employee.id);
  expect(before.records.map((r) => r.kind)).toEqual(['hire', 'org_adjustment']);
  // 同日调度：T1 的区间含 T2 与组织调整 → 需重建；T2 是 T1 的 blocker、不挂起，但它自己的原计划区间 [10-07, 10-10)
  // 含补入的组织调整 → 同样需重建，不得因最新载荷已是当天而跳过复核。
  expect(await w.runScheduler('2026-10-10T02:00:00Z')).toMatchObject({
    activated: [],
    failed: [t1.id, t2.id],
    errors: [],
  });
  await expectRebuildRequired(w, t2, [adjustment.id], { planned: '2026-10-07', execution: '2026-10-10' });
  await expectRebuildRequired(w, t1, [t2.id, adjustment.id], { planned: '2026-10-05', execution: '2026-10-10' });
  expect(await snapshot(w, person.employee.id)).toEqual(before);
  // HR 重试两类入口同一口径：T2 仍按原计划日复核，T1 仍被 T2 与组织调整挡住。
  const retriedT2 = await w.retry(t2, '2026-10-10T03:00:00Z');
  expect(retriedT2.status, await retriedT2.clone().text()).toBe(200);
  await expectRebuildRequired(w, t2, [adjustment.id], { planned: '2026-10-07', execution: '2026-10-10' }, 2);
  const retriedT1 = await w.retry(t1, '2026-10-10T04:00:00Z');
  expect(retriedT1.status, await retriedT1.clone().text()).toBe(200);
  await expectRebuildRequired(w, t1, [t2.id, adjustment.id], { planned: '2026-10-05', execution: '2026-10-10' }, 2);
  expect(await snapshot(w, person.employee.id)).toEqual(before);
});

/** 主管 M、接收人 R 入职；下属 S 入职并汇报给 M。 */
async function managerScene(label: string) {
  const w = await activationWorld(database().db, label);
  const finalOrg = await w.session.org('最终部门', { establishedOn: '2026-01-01' });
  const m = await w.hired('调动主管 M');
  const r = await w.hired('接收人 R');
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
  // T1：M 调入“调入部门”，新增下属 S（生效时把 S 的经理写为 M）；T2：M 再调入最终部门，把 S 的职责转交给 R。
  const t1 = await w.session.business(
    m.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { departmentId: w.to.id, addedSubordinateIds: [s.employee.id], place: 'T1' },
    },
    await revisionOf(w, m.employee.id),
  );
  const t2 = await w.session.business(
    m.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-07',
      fields: { departmentId: finalOrg.id, place: 'T2' },
    },
    await revisionOf(w, m.employee.id),
  );
  const linkage = await w.session.request('PUT', `/transfers/${t2.id}/linkage`, {
    ifMatch: t2.revision,
    body: {
      dutyTransfer: { subordinates: [{ employeeId: s.employee.id, receiverId: r.employee.id, relation: 'direct' }] },
    },
  });
  expect(linkage.status, await linkage.clone().text()).toBe(200);
  return { w, finalOrg, m, r, s, t1, t2 };
}

it('对照组：按期执行时 T1 先把 S 的经理写为 M，T2 再把 S 转交给 R，最终经理为 R', async () => {
  const { w, r, s, t1, t2 } = await managerScene('org32r3ontime');
  expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect((await w.business(t1.id)).activation).toMatchObject({ status: 'effective' });
  expect(await w.runScheduler('2026-10-07T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect((await w.business(t2.id)).activation).toMatchObject({ status: 'effective' });
  expect(await managerOf(w, s.hire.id)).toBe(r.employee.id);
});

it('S2-P2-02 两笔触及同一下属：有跨对象联动依赖，后笔不豁免、维持前序门禁挂起；S 的经理不被倒序执行覆盖', async () => {
  const { w, m, s, t1, t2 } = await managerScene('org32r3dependent');
  const run = await w.runScheduler('2026-10-10T01:00:00Z');
  expect(run).toMatchObject({ activated: [], failed: [t1.id], suspended: [t2.id], errors: [] });
  await expectRebuildRequired(w, t1, [t2.id], { planned: '2026-10-05', execution: '2026-10-10' });
  expect((await w.business(t2.id)).activation).toMatchObject({
    status: 'suspended',
    failureReason: 'PREDECESSOR_FAILED',
    blockedByBusinessId: t1.id,
  });
  expect(await managerOf(w, s.hire.id)).toBe(m.employee.id);
  // 被挂起的后笔不能越过失败的前序单独重试；前序重试仍因后笔在区间内记需重建，交 HR 处理（F-036 前）。
  expect((await w.retry(t2, '2026-10-10T02:00:00Z')).status).toBe(409);
  const retried = await w.retry(t1, '2026-10-10T03:00:00Z');
  expect(retried.status, await retried.clone().text()).toBe(200);
  await expectRebuildRequired(w, t1, [t2.id], { planned: '2026-10-05', execution: '2026-10-10' }, 2);
  expect((await w.business(t2.id)).activation).toMatchObject({ status: 'suspended' });
  expect(await managerOf(w, s.hire.id)).toBe(m.employee.id);
  expect((await w.todos()).map((item) => item.id)).toEqual([t1.id]);
});
