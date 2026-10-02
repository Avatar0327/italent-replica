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
  'employment_record_tombstones',
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

describe('AC-EMP-11 周期和时间轴未取证边界的保守处理', () => {
  it('Q-M0-19 早于指定周期起始日返回 503，业务、审计、outbox、台账与员工 revision 都不变', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'empbeforecyclestart');
    const employee = await session.employee('周期开始前合成员工');
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { place: '初始地点' } },
      employee.revision,
    );
    const beforeEmployee = await session.getEmployee(employee.id);
    const beforeRecords = await session.records(employee.id);
    const beforeEffects = await effects(db, session);
    const rejected = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      idempotencyKey: randomUUID(),
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-08-31',
        staffId: hire.record!.staffId,
        fields: { place: '不得写入的地点' },
      },
    });
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ error: { code: 'EMPLOYMENT_CYCLE_START_UNRESOLVED' } });
    expect(await session.getEmployee(employee.id)).toEqual(beforeEmployee);
    expect(await session.records(employee.id)).toEqual(beforeRecords);
    expect(await effects(db, session)).toEqual(beforeEffects);
  });

  it('Q-M0-20 同日第二条主职业务返回 409，原任职及同事务数据保持不变', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'empsamedaybusiness');
    const employee = await session.employee('同日业务合成员工');
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { remarks: '原记录' } },
      employee.revision,
    );
    const beforeEmployee = await session.getEmployee(employee.id);
    const beforeRecords = await session.records(employee.id);
    const beforeEffects = await effects(db, session);
    const rejected = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      idempotencyKey: randomUUID(),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-01', fields: { remarks: '不得替换原记录' } },
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: 'EMPLOYMENT_SAME_DATE_UNRESOLVED' } });
    expect(await session.getEmployee(employee.id)).toEqual(beforeEmployee);
    expect(await session.records(employee.id)).toEqual(beforeRecords);
    expect(await effects(db, session)).toEqual(beforeEffects);
  });

  it('Q-M0-21 首次入职在未来时今天没有当前记录，到生效日恰有一条且无需再写业务', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'empfirstfuturehire');
    const employee = await session.employee('未来首次入职合成员工');
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-11-01' },
      employee.revision,
    );
    expect(hire.status).toBe('effective');
    expect(hire.record).toMatchObject({ isCurrent: false, isLatest: true });
    expect((await session.records(employee.id)).filter((record) => record.isCurrent)).toEqual([]);
    expect(await session.getEmployee(employee.id)).toMatchObject({
      status: 'pending',
      revision: hire.employeeRevision,
    });
    const beforeEffects = await effects(db, session);
    session.setNow('2026-10-31T16:00:00.000Z');
    const reached = await session.records(employee.id, '2026-11-01');
    expect(reached.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([hire.record!.id]);
    expect(await session.getEmployee(employee.id)).toMatchObject({
      status: 'employed',
      revision: hire.employeeRevision,
    });
    const projected = await withTenant(db, session.tenant.id, (tx) =>
      tx.execute(sql`
        SELECT record_id FROM employment_timeline
        WHERE tenant_id = ${session.tenant.id} AND employee_id = ${employee.id}
          AND valid_during @> '2026-11-01'::date LIMIT 2
      `),
    );
    const rows = Array.isArray(projected) ? projected : (projected as { rows: unknown[] }).rows;
    expect(rows).toEqual([{ record_id: hire.record!.id }]);
    expect(await effects(db, session)).toEqual(beforeEffects);
  });
});
