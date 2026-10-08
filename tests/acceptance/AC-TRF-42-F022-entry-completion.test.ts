/**
 * F-022 契约（DEC-278①，#83 本体范围）：完成入职（待入职 → 试用 / 正式）必须传播到同周期、位置在后、仍为待入职的
 * 生效版本与申请载荷（草稿 / 审批中 / 已批准 / 已驳回），目标 entryStatus 保留自身值；状态已不同或 StaffID 不同不动；
 * 取消 / 延期 / 改期恢复只改本记录的入职状态，不传播。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { EMPLOYEE_STATUS, ENTRY_STATUS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import {
  changePendingEntryStatus,
  completePendingEntry,
  type EntryTarget,
} from '../../apps/api/src/modules/employment/employee-status.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
const TARGET_STATES = ['effective', 'draft', 'in_review', 'approved', 'rejected'] as const;
type TargetState = (typeof TARGET_STATES)[number];
const PENDING = { employeeStatus: EMPLOYEE_STATUS.pendingEntry, entryStatus: ENTRY_STATUS.normal };

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

/** 添加待入职（入职写入端口，R2-T01 接线）：9-01 入职、人员状态待入职、入职状态正常。 */
async function pendingHire(w: ActivationWorld, name: string, effectiveDate = '2026-09-01') {
  const employee = await w.session.employee(name);
  const hire = await withTenant(w.db, w.session.tenant.id, (tx) =>
    createEmploymentBusiness(
      tx,
      context(w, employee.revision),
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate,
        fields: { departmentId: w.from.id, employType: 'internal', place: '原地点' },
      },
      { entry: { pendingEntry: true } },
    ),
  );
  return { employee, hire };
}

async function latestStatus(w: ActivationWorld, businessId: string) {
  return withTenant(
    w.db,
    w.session.tenant.id,
    async (tx) =>
      resultRows<{ employeeStatus: number; entryStatus: number | null }>(
        await tx.execute(sql`SELECT employee_status AS "employeeStatus", entry_status AS "entryStatus"
        FROM employment_payload_versions WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid
        ORDER BY version_no DESC LIMIT 1`),
      )[0]!,
  );
}

async function target(w: ActivationWorld, employeeId: string, state: TargetState) {
  const revision = async () => (await w.session.getEmployee(employeeId)).revision;
  if (state === 'effective')
    return w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-15', fields: { departmentId: w.to.id } },
      await revision(),
    );
  if (state === 'draft')
    return w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-20', fields: { departmentId: w.to.id } },
      await revision(),
    );
  const applied = await w.apply(employeeId, '2026-10-20', { departmentId: w.to.id });
  if (state === 'in_review') return applied;
  if (state === 'approved') return w.approve(applied, '2026-10-01T02:00:00Z');
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    transitionEmployment(tx, context(w, applied.revision), { id: applied.id, action: 'reject' }),
  );
  return applied;
}

async function complete(w: ActivationWorld, hireId: string, probation: boolean) {
  const business = await w.business(hireId);
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    completePendingEntry(tx, context(w, business.revision), hireId, { probation }),
  );
}

async function flow(w: ActivationWorld, hireId: string, entry: EntryTarget) {
  const business = await w.business(hireId);
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    changePendingEntryStatus(tx, context(w, business.revision), hireId, entry),
  );
}

it.each(TARGET_STATES.flatMap((state) => [true, false].map((probation) => ({ state, probation }))))(
  'AC-TRF-42 完成入职传播到后续待入职版本 / 目标=$state / 有试用期=$probation',
  async ({ state, probation }) => {
    const w = await activationWorld(database().db, `f022c${state}${probation}`);
    const { employee, hire } = await pendingHire(w, `待入职-${state}`);
    const later = await target(w, employee.id, state);
    expect(await latestStatus(w, later.id)).toEqual(PENDING);
    await complete(w, hire.id, probation);
    const employeeStatus = probation ? EMPLOYEE_STATUS.probation : EMPLOYEE_STATUS.regular;
    expect(await latestStatus(w, hire.id)).toEqual({ employeeStatus, entryStatus: ENTRY_STATUS.normal });
    expect(await latestStatus(w, later.id)).toEqual({ employeeStatus, entryStatus: ENTRY_STATUS.normal });
    if (state === 'effective')
      expect(await w.session.record(later.id, '2026-10-15')).toMatchObject({ employeeStatus, isCurrent: true });
    else expect((await w.business(later.id)).status).toBe(state);
    expect((await w.auditEvents(later.id)).filter((e) => e.action === 'employment.forward-update')).toHaveLength(1);
  },
);

it('AC-TRF-42 对照：状态已不同（离职 8）与 StaffID 不同（重聘周期）的后续版本不传播', async () => {
  const w = await activationWorld(database().db, 'f022controls');
  const { employee, hire } = await pendingHire(w, '对照员工');
  const leave = await w.session.business(
    employee.id,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-31', fields: {} },
    (await w.session.getEmployee(employee.id)).revision,
  );
  const afterLeave = await w.session.getEmployee(employee.id);
  const rehire = await withTenant(w.db, w.session.tenant.id, (tx) =>
    createEmploymentBusiness(
      tx,
      context(w, afterLeave.revision),
      employee.id,
      {
        kind: 'rehire',
        mode: 'direct',
        effectiveDate: '2026-12-15',
        fields: { departmentId: w.from.id, employType: 'internal' },
      },
      { entry: { pendingEntry: true } },
    ),
  );
  const leaveBefore = await latestStatus(w, leave.id);
  expect(leaveBefore.employeeStatus).not.toBe(EMPLOYEE_STATUS.pendingEntry);
  expect(await latestStatus(w, rehire.id)).toEqual(PENDING);
  await complete(w, hire.id, true);
  expect(await latestStatus(w, hire.id)).toEqual({
    employeeStatus: EMPLOYEE_STATUS.probation,
    entryStatus: ENTRY_STATUS.normal,
  });
  expect(await latestStatus(w, leave.id)).toEqual(leaveBefore);
  expect(await latestStatus(w, rehire.id)).toEqual(PENDING);
  for (const id of [leave.id, rehire.id])
    expect((await w.auditEvents(id)).some((e) => e.action === 'employment.forward-update')).toBe(false);
});

it('AC-TRF-42 取消 / 延期 / 改期恢复只改本记录入职状态，不传播；之后完成入职照常传播', async () => {
  const w = await activationWorld(database().db, 'f022flow');
  const { employee, hire } = await pendingHire(w, '延期员工');
  const later = await target(w, employee.id, 'effective');
  for (const [entry, entryStatus] of [
    ['postponed', ENTRY_STATUS.postponed],
    ['cancelled', ENTRY_STATUS.cancelled],
    ['normal', ENTRY_STATUS.normal],
  ] as const) {
    await flow(w, hire.id, entry);
    expect(await latestStatus(w, hire.id)).toEqual({ employeeStatus: EMPLOYEE_STATUS.pendingEntry, entryStatus });
    expect(await latestStatus(w, later.id)).toEqual(PENDING);
  }
  expect((await w.auditEvents(later.id)).some((e) => e.action === 'employment.forward-update')).toBe(false);
  await complete(w, hire.id, false);
  expect(await latestStatus(w, later.id)).toEqual({
    employeeStatus: EMPLOYEE_STATUS.regular,
    entryStatus: ENTRY_STATUS.normal,
  });
});
