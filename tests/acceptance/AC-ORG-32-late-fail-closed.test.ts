/**
 * DEC-278③：F-036 完成迟到重建前，迟到执行按窄口径 fail-closed——[计划日, 实际执行日) 内同一员工另有其他任职版本或
 * 业务（组织调整、其他调动、离职、未落地申请）时拒绝执行，记“生效失败：需重建，待 HR 处理”（REBUILD_REQUIRED）、
 * 写审计并进入 HR 待办；区间内没有其他记录的简单迟到照常顺延到实际执行日（DEC-186）。
 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { versions } from './AC-JOB-sequence-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const REBUILD_REQUIRED = 'REBUILD_REQUIRED';
const departmentBefore = (record: { readonly before?: unknown }) =>
  (record.before as { fields: { departmentId: string | null } } | null)?.fields.departmentId;

async function rename(w: ActivationWorld, org: { id: string; revision: number; name: string }, effectiveDate: string) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const response = await api.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: org.revision,
    body: { name: `${org.name}改名`, effectiveDate, addEmployment: true },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function lateTransfer(
  w: ActivationWorld,
  employeeId: string,
  departmentId: string,
  effectiveDate = '2026-10-05',
) {
  const employee = await w.session.getEmployee(employeeId);
  return w.session.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId, place: '新地点' } },
    employee.revision,
  );
}

/** 时间轴（含区间与 revision）与载荷版本数：失败不得写入任何任职数据。 */
async function snapshot(w: ActivationWorld, employeeId: string) {
  return {
    records: await w.session.records(employeeId, '2026-10-10'),
    versions: await versions(w.db, w.session.tenant.id, employeeId),
  };
}

async function expectRebuildRequired(w: ActivationWorld, late: { id: string }, blockerIds: string[]) {
  expect((await w.business(late.id)).activation).toMatchObject({ status: 'failed', failureReason: REBUILD_REQUIRED });
  expect((await w.todos()).find((item) => item.id === late.id)?.activation).toMatchObject({
    status: 'failed',
    failureReason: REBUILD_REQUIRED,
  });
  const events = await w.auditEvents(late.id);
  const failed = events.filter((event) => event.action === 'employment.activation.failed');
  expect(failed).toHaveLength(1);
  expect(failed[0]!.after).toMatchObject({
    reason: REBUILD_REQUIRED,
    detail: { plannedEffectiveDate: '2026-10-05', executionDate: '2026-10-10' },
  });
  const blockers = (failed[0]!.after!.detail as { blockers: { id: string }[] }).blockers.map((item) => item.id);
  expect(blockers.sort()).toEqual([...blockerIds].sort());
  expect(events.some((event) => event.action === 'employment.transfer.rescheduled')).toBe(false);
}

it('AC-ORG-32 区间内有组织调整：拒绝执行并记需重建待 HR，任职不变，HR 重试仍失败', async () => {
  const w = await activationWorld(database().db, 'org32fcadj');
  const person = await w.hired();
  const late = await lateTransfer(w, person.employee.id, w.to.id);
  await rename(w, w.to, '2026-10-09');
  const adjustment = (await w.session.records(person.employee.id, '2026-10-09')).find(
    (r) => r.kind === 'org_adjustment',
  )!;
  const before = await snapshot(w, person.employee.id);
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [late.id], errors: [] });
  await expectRebuildRequired(w, late, [adjustment.id]);
  expect(await snapshot(w, person.employee.id)).toEqual(before);
  const retried = await w.retry(late, '2026-10-11T01:00:00Z');
  expect(retried.status, await retried.clone().text()).toBe(200);
  expect((await w.business(late.id)).activation).toMatchObject({
    status: 'failed',
    failureReason: REBUILD_REQUIRED,
    failureCount: 2,
  });
  expect(await snapshot(w, person.employee.id)).toEqual(before);
});

it.each(['draft', 'in_review'] as const)(
  'AC-ORG-32 区间内有未落地的调动申请（%s）：拒绝执行并记需重建',
  async (state) => {
    const w = await activationWorld(database().db, `org32fc${state}`);
    const person = await w.hired();
    const late = await lateTransfer(w, person.employee.id, w.to.id);
    const application =
      state === 'draft'
        ? await w.session.business(
            person.employee.id,
            { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-08', fields: { place: '申请地点' } },
            (await w.session.getEmployee(person.employee.id)).revision,
          )
        : await w.apply(person.employee.id, '2026-10-08', { place: '申请地点' });
    expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [late.id], errors: [] });
    await expectRebuildRequired(w, late, [application.id]);
    expect((await w.business(application.id)).status).toBe(state);
  },
);

it('AC-ORG-32 区间内有离职：不再按 DEC-252① 兜底失败，而是记需重建待 HR，离职不变', async () => {
  const w = await activationWorld(database().db, 'org32fcleave');
  const person = await w.hired();
  const late = await lateTransfer(w, person.employee.id, w.to.id);
  const leave = await w.session.business(
    person.employee.id,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-07', fields: {} },
    (await w.session.getEmployee(person.employee.id)).revision,
  );
  const before = await snapshot(w, person.employee.id);
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [late.id], errors: [] });
  await expectRebuildRequired(w, late, [leave.id]);
  expect(await snapshot(w, person.employee.id)).toEqual(before);
  expect((await w.session.records(person.employee.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: leave.id,
    kind: 'leave',
  });
});

it('AC-ORG-32 多笔迟到：前一笔区间内含后一笔 → 需重建；后一笔区间为空照常顺延；HR 重试前一笔后按原计划日排序', async () => {
  const w = await activationWorld(database().db, 'org32fcmulti');
  const finalOrg = await w.session.org('最终部门', { establishedOn: '2026-01-01' });
  const person = await w.hired();
  const first = await lateTransfer(w, person.employee.id, w.to.id, '2026-10-05');
  const second = await lateTransfer(w, person.employee.id, finalOrg.id, '2026-10-07');
  // 已落地的直接调动按 DEC-173 只提醒：成功的不进入 activated，失败的仍记 failed。
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [first.id], errors: [] });
  expect((await w.business(second.id)).activation).toMatchObject({ status: 'effective' });
  await expectRebuildRequired(w, first, [second.id]);
  expect((await w.session.records(person.employee.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: second.id,
    effectiveDate: '2026-10-10',
  });
  // 后一笔离开区间后，前一笔成为简单迟到：HR 重试成功，同日按原计划日排在后一笔之前（DEC-195①）。
  const retried = await w.retry(first, '2026-10-10T02:00:00Z');
  expect(retried.status, await retried.clone().text()).toBe(200);
  const sameDay = (await w.session.records(person.employee.id, '2026-10-10')).filter(
    (r) => r.effectiveDate === '2026-10-10',
  );
  expect(sameDay.map((r) => r.id)).toEqual([first.id, second.id]);
  expect(sameDay.find((r) => r.isCurrent)).toMatchObject({ id: second.id, fields: { departmentId: finalOrg.id } });
  expect(departmentBefore(await w.session.record(second.id, '2026-10-10'))).toBe(w.to.id);
  expect((await w.business(first.id)).activation).toMatchObject({ status: 'effective' });
});

it('AC-ORG-32 区间内没有其他记录：简单迟到照常顺延到实际执行日', async () => {
  const w = await activationWorld(database().db, 'org32fcsimple');
  const person = await w.hired();
  const late = await lateTransfer(w, person.employee.id, w.to.id);
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect((await w.session.records(person.employee.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: late.id,
    effectiveDate: '2026-10-10',
    fields: { departmentId: w.to.id, place: '新地点' },
  });
  const events = await w.auditEvents(late.id);
  expect(events.filter((event) => event.action === 'employment.transfer.rescheduled')).toHaveLength(1);
  expect(events.some((event) => event.action === 'employment.activation.failed')).toBe(false);
  expect((await w.business(late.id)).activation).toMatchObject({ status: 'effective' });
});

it('AC-ORG-32 实际执行日之后的组织调整与申请不在区间内，不拦截简单迟到', async () => {
  const w = await activationWorld(database().db, 'org32fcoutside');
  const person = await w.hired();
  const late = await lateTransfer(w, person.employee.id, w.to.id);
  await rename(w, w.to, '2026-10-12');
  const adjustment = (await w.session.records(person.employee.id, '2026-10-12')).find(
    (r) => r.kind === 'org_adjustment',
  )!;
  const draft = await w.session.business(
    person.employee.id,
    { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-15', fields: { place: '申请地点' } },
    (await w.session.getEmployee(person.employee.id)).revision,
  );
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect((await w.session.records(person.employee.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: late.id,
    effectiveDate: '2026-10-10',
  });
  expect(await w.session.record(adjustment.id, '2026-10-12')).toMatchObject({
    effectiveDate: '2026-10-12',
    isCurrent: true,
    fields: { departmentId: w.to.id },
  });
  expect((await w.business(draft.id)).status).toBe('draft');
});
