/**
 * F-022：人员状态 / 入职状态的写入时机（docs/02_业务建模/15 §9，Q-M0-96～99；DEC-125 / DEC-215）。
 * 状态随承载它的任职版本生效而切换，不在审批通过时切换，也不随试用期日期推算。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  changePendingEntryStatus,
  completePendingEntry,
} from '../../apps/api/src/modules/employment/employee-status.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface StatusRecord {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly employeeStatus: number;
  readonly entryStatus: number | null;
  readonly isCurrent: boolean;
  readonly revision: number;
}

function context(session: EmploymentSession, expectedRevision: number, at = '2026-10-01T01:00:00Z') {
  return {
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date(at),
    commandId: randomUUID(),
    expectedRevision,
  } satisfies EmploymentContext;
}

async function statusRecords(session: EmploymentSession, employeeId: string, asOf = '2026-10-01') {
  return (await session.records(employeeId, asOf)) as unknown as StatusRecord[];
}

async function employeeStatus(session: EmploymentSession, employeeId: string, asOf = '2026-10-01') {
  const response = await session.request('GET', `/employees/${employeeId}?asOf=${asOf}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; employeeStatus: number | null; entryStatus: number | null };
}

/** 入职的写入端口（R2-T01 接线）：待入职、是否有试用期都由业务入口传入，不开放给请求体。 */
async function hireThroughPort(
  session: EmploymentSession,
  entry: { pendingEntry?: boolean; probation?: boolean },
  effectiveDate = '2026-09-01',
) {
  const org = await session.org(`状态部门${randomUUID().slice(0, 6)}`, { establishedOn: '2026-01-01' });
  const employee = await session.employee();
  const business = await withTenant(testDb().db, session.tenant.id, (tx) =>
    createEmploymentBusiness(
      tx,
      context(session, employee.revision),
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate, fields: { employType: 'internal', departmentId: org.id } },
      { entry },
    ),
  );
  return { org, employee, business };
}

describe('AC-EMP-17 人员状态 / 入职状态的写入时机', () => {
  it('办理入职默认正式、入职状态为空；调动继承；员工当前状态取当前生效主职版本', async () => {
    const session = await employmentSession(testDb().db, 'empstatus01');
    const org = await session.org('状态部门A', { establishedOn: '2026-01-01' });
    const other = await session.org('状态部门B', { establishedOn: '2026-01-01' });
    const employee = await session.employee();
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', departmentId: org.id },
      },
      employee.revision,
    );
    await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-15', fields: { departmentId: other.id } },
      hire.employeeRevision,
    );
    const records = await statusRecords(session, employee.id);
    expect(records.map((record) => [record.kind, record.employeeStatus, record.entryStatus])).toEqual([
      ['hire', 3, null],
      ['transfer', 3, null],
    ]);
    expect(await employeeStatus(session, employee.id)).toMatchObject({
      status: 'employed',
      employeeStatus: 3,
      entryStatus: null,
    });
  });

  it('入职端口：有试用期为试用，且试用状态不随日期变化（十年后仍为试用）', async () => {
    const session = await employmentSession(testDb().db, 'empstatus02');
    const { employee } = await hireThroughPort(session, { probation: true });
    expect((await statusRecords(session, employee.id)).map((record) => record.employeeStatus)).toEqual([2]);
    expect((await employeeStatus(session, employee.id, '2036-10-01')).employeeStatus).toBe(2);
  });

  it('添加待入职：待入职 + 正常；延期、取消、改期恢复、办理入职生效均追加版本，不改写原值', async () => {
    const session = await employmentSession(testDb().db, 'empstatus03');
    const { employee, business } = await hireThroughPort(session, { pendingEntry: true }, '2026-09-20');
    const recordId = business.record!.id;
    expect(await employeeStatus(session, employee.id)).toMatchObject({
      status: 'pending',
      employeeStatus: 1,
      entryStatus: 0,
    });
    const steps: [number, 'postponed' | 'cancelled' | 'normal'][] = [
      [2, 'postponed'],
      [1, 'cancelled'],
      [2, 'postponed'],
    ];
    for (const [expected, target] of steps) {
      const current = (await statusRecords(session, employee.id))[0]!;
      await withTenant(testDb().db, session.tenant.id, (tx) =>
        changePendingEntryStatus(tx, context(session, current.revision), recordId, target),
      );
      expect((await statusRecords(session, employee.id))[0]).toMatchObject({
        employeeStatus: 1,
        entryStatus: expected,
      });
    }
    const current = (await statusRecords(session, employee.id))[0]!;
    await withTenant(testDb().db, session.tenant.id, (tx) =>
      completePendingEntry(tx, context(session, current.revision), recordId, { probation: true }),
    );
    expect((await statusRecords(session, employee.id))[0]).toMatchObject({ employeeStatus: 2, entryStatus: 2 });
    expect(await employeeStatus(session, employee.id)).toMatchObject({ status: 'employed', employeeStatus: 2 });
    const versions = await withTenant(testDb().db, session.tenant.id, async (tx) =>
      rows<{ s: number; e: number | null }>(
        await tx.execute(sql`
          SELECT employee_status AS s, entry_status AS e FROM employment_payload_versions
          WHERE tenant_id=${session.tenant.id} AND business_id=${recordId}::uuid ORDER BY version_no`),
      ),
    );
    expect(versions).toEqual([
      { s: 1, e: 0 },
      { s: 1, e: 2 },
      { s: 1, e: 1 },
      { s: 1, e: 2 },
      { s: 2, e: 2 },
    ]);
    const base = await withTenant(testDb().db, session.tenant.id, async (tx) =>
      rows<{ s: number }>(
        await tx.execute(sql`SELECT employee_status AS s FROM employment_records
          WHERE tenant_id=${session.tenant.id} AND id=${recordId}::uuid`),
      ),
    );
    expect(base).toEqual([{ s: 1 }]);
  });

  it('入职状态端口只接受待入职版本；已入职再改延期被拒', async () => {
    const session = await employmentSession(testDb().db, 'empstatus04');
    const { business } = await hireThroughPort(session, { probation: true });
    await expect(
      withTenant(testDb().db, session.tenant.id, (tx) =>
        changePendingEntryStatus(tx, context(session, business.revision), business.record!.id, 'postponed'),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'NOT_PENDING_ENTRY' } });
  });

  it('未来日期转正到期生效：之前为试用，转正日起为正式；晚于转正日的后续版本追加为正式', async () => {
    const session = await employmentSession(testDb().db, 'empstatus05');
    const { employee, org } = await hireThroughPort(session, { probation: true });
    const later = await session.org('转正后部门', { establishedOn: '2026-01-01' });
    const fresh = await session.getEmployee(employee.id);
    const transfer = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { departmentId: later.id } },
      fresh.revision,
    );
    expect(transfer.record).toBeTruthy();
    const regularization = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-11-01', fields: {} },
      transfer.employeeRevision,
    );
    const asOf = (date: string) => statusRecords(session, employee.id, date);
    expect((await asOf('2026-10-01')).map((record) => [record.kind, record.employeeStatus])).toEqual([
      ['hire', 2],
      ['regularization', 3],
      ['transfer', 3],
    ]);
    expect((await employeeStatus(session, employee.id, '2026-10-31')).employeeStatus).toBe(2);
    expect((await employeeStatus(session, employee.id, '2026-11-01')).employeeStatus).toBe(3);
    // 后续版本以追加快照改为正式，原底表行保持写入时的值（版本链只追加）
    const base = await withTenant(testDb().db, session.tenant.id, async (tx) =>
      rows<{ s: number }>(
        await tx.execute(sql`SELECT employee_status AS s FROM employment_records
          WHERE tenant_id=${session.tenant.id} AND id=${transfer.record!.id}::uuid`),
      ),
    );
    expect(base).toEqual([{ s: 2 }]);
    expect(regularization.record?.id).toBeTruthy();
    expect(org.id).toBeTruthy();
  });

  it('走审批的转正：审批通过但未到生效日不切换；到期落地后为正式（DEC-125）', async () => {
    const session = await employmentSession(testDb().db, 'empstatus06');
    const { employee } = await hireThroughPort(session, { probation: true });
    const fresh = await session.getEmployee(employee.id);
    const application = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'application', effectiveDate: '2026-11-01', fields: {} },
      fresh.revision,
    );
    let revision = application.revision;
    for (const action of ['submit', 'approve'] as const) {
      const saved = await withTenant(testDb().db, session.tenant.id, (tx) =>
        transitionEmployment(tx, context(session, revision), { id: application.id, action }),
      );
      revision = saved.revision;
      expect(saved.status).toBe(action === 'submit' ? 'in_review' : 'approved');
    }
    expect((await employeeStatus(session, employee.id, '2026-10-15')).employeeStatus).toBe(2);
    await withTenant(testDb().db, session.tenant.id, (tx) =>
      transitionEmployment(tx, context(session, revision, '2026-11-01T01:00:00Z'), {
        id: application.id,
        action: 'activate',
      }),
    );
    expect((await employeeStatus(session, employee.id, '2026-11-01')).employeeStatus).toBe(3);
  });

  it('离职 / 退休生效时写入离职 8 / 退休 6；审批中的离职不写版本链（DEC-215）', async () => {
    const session = await employmentSession(testDb().db, 'empstatus07');
    const { employee } = await hireThroughPort(session, { probation: true });
    const pendingLeave = await session.business(
      employee.id,
      { kind: 'leave', mode: 'application', lastWorkDate: '2026-11-30', fields: {} },
      (await session.getEmployee(employee.id)).revision,
    );
    expect(pendingLeave.record).toBeNull();
    expect((await employeeStatus(session, employee.id, '2026-12-15')).employeeStatus).toBe(2);
    const second = await hireThroughPort(session, {});
    const leave = await session.business(
      second.employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30', fields: {} },
      (await session.getEmployee(second.employee.id)).revision,
    );
    expect(leave.record).toMatchObject({ employeeStatus: 8 });
    expect(await employeeStatus(session, second.employee.id)).toMatchObject({ status: 'left', employeeStatus: 8 });
    const third = await hireThroughPort(session, {});
    const retirement = await session.business(
      third.employee.id,
      { kind: 'retirement', mode: 'direct', lastWorkDate: '2026-09-30', fields: {} },
      (await session.getEmployee(third.employee.id)).revision,
    );
    expect(retirement.record).toMatchObject({ employeeStatus: 6 });
    expect(await employeeStatus(session, third.employee.id)).toMatchObject({ status: 'retired', employeeStatus: 6 });
  });
});
