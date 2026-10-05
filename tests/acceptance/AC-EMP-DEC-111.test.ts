import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';

const testDb = useTestDb();
const EFFECT_TABLES = [
  'employment_cycles',
  'employment_business_objects',
  'employment_payload_versions',
  'employment_state_events',
  'employment_records',
  'employment_timeline',
  'employment_outbox',
  'command_ledger',
  'audit_events',
] as const;

async function effects(db: Db, session: EmploymentSession): Promise<unknown> {
  return withTenant(db, session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`
      SELECT ${sql.join(
        EFFECT_TABLES.map(
          (table) => sql`(SELECT count(*) FROM ${sql.identifier(table)}
            WHERE tenant_id = ${session.tenant.id}) AS ${sql.identifier(table)}`,
        ),
        sql`, `,
      )}
    `);
    return Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  });
}

/** 照搬原站 W-410～W-412：9-01 入职，最后工作日 9-24 离职，9-28 重聘开启当前周期。 */
async function rehiredFixture(label: string) {
  const { db } = testDb();
  const session = await employmentSession(db, label);
  const employee = await session.employee('重聘合成员工');
  const org = await session.org('合成重聘部门', { startDate: '2026-01-01' });
  const hire = await session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: org.id, place: '旧周期地点' },
    },
    employee.revision,
  );
  const leave = await session.business(
    employee.id,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-24' },
    hire.employeeRevision,
  );
  const rehire = await session.business(
    employee.id,
    {
      kind: 'rehire',
      mode: 'direct',
      effectiveDate: '2026-09-28',
      fields: { departmentId: org.id, place: '新周期地点' },
    },
    leave.employeeRevision,
  );
  return { db, session, employee, hire, leave, rehire };
}

async function expectBeforeEntry(response: Response, label: string, entryDate: string) {
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: 'EMPLOYMENT_BEFORE_CYCLE_ENTRY',
      message: `${label}不能早于入职生效日期（${entryDate}）`,
      details: { entryDate },
    },
  });
}

describe('DEC-111 早于当前任职周期入职生效日的业务一律拒绝', () => {
  it('重聘后往旧周期补录调动被拒，提示照搬原站，且不产生任何写入（W-412）', async () => {
    const { db, session, employee, rehire } = await rehiredFixture('dec111-old-cycle');
    const beforeEffects = await effects(db, session);
    const beforeRecords = await session.records(employee.id);
    const rejected = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: rehire.employeeRevision,
      idempotencyKey: randomUUID(),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-05', fields: { place: '旧周期更正' } },
    });
    await expectBeforeEntry(rejected, '调动日期', '2026-09-28');
    expect(await effects(db, session)).toEqual(beforeEffects);
    expect(await session.records(employee.id)).toEqual(beforeRecords);
    expect((await session.getEmployee(employee.id)).revision).toBe(rehire.employeeRevision);
  });

  it('离职生效后、重聘前的日期同样按当前周期入职日拒绝，而不是报在职状态冲突', async () => {
    const { session, employee, rehire } = await rehiredFixture('dec111-gap');
    const rejected = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: rehire.employeeRevision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-26', fields: { place: '空档期' } },
    });
    await expectBeforeEntry(rejected, '调动日期', '2026-09-28');
  });

  it('首次入职前的业务按入职生效日拒绝；非调动业务只有原站调动文案的日期名称不同', async () => {
    const session = await employmentSession(testDb().db, 'dec111-before-first-hire');
    const employee = await session.employee('入职前合成员工');
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01' },
      employee.revision,
    );
    const transfer = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-08-31', fields: { place: '入职前' } },
    });
    await expectBeforeEntry(transfer, '调动日期', '2026-09-01');
    const regularization = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: { kind: 'regularization', mode: 'direct', effectiveDate: '2026-08-31' },
    });
    await expectBeforeEntry(regularization, '生效日期', '2026-09-01');
  });

  it('不再接受指定任职周期 staffId（去掉旧周期补录入口）', async () => {
    const { session, employee, hire, rehire } = await rehiredFixture('dec111-staff-id');
    const response = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: rehire.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-30',
        staffId: hire.record!.staffId,
        fields: { place: '指定旧周期' },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('向后更新预览与草稿改期同样拒绝早于当前周期的日期', async () => {
    const { session, employee, rehire } = await rehiredFixture('dec111-preview-patch');
    const preview = await session.request('POST', `/employees/${employee.id}/forward-update-preview`, {
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-05', fields: { place: '预览旧周期' } },
    });
    await expectBeforeEntry(preview, '调动日期', '2026-09-28');
    const draft = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { place: '申请地点' } },
      rehire.employeeRevision,
    );
    const patched = await session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { effectiveDate: '2026-09-05' },
    });
    await expectBeforeEntry(patched, '调动日期', '2026-09-28');
  });

  it('当前周期入职日当天及之后的补录照常保存，并只在当前周期内向后更新', async () => {
    const { session, employee, leave, rehire } = await rehiredFixture('dec111-current-cycle');
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-30' },
      rehire.employeeRevision,
    );
    const sameDay = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-28', fields: { place: '入职当天调动' } },
      later.employeeRevision,
    );
    expect(sameDay.record).toMatchObject({ staffId: rehire.record!.staffId, previousRecordId: rehire.id });
    expect((await session.record(later.id)).fields.place).toBe('入职当天调动');
    expect((await session.record(leave.id)).fields.place).toBe('旧周期地点');
  });
});
