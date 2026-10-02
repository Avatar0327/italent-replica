import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, type EmploymentBusiness } from './AC-EMP-support.js';

const testDb = useTestDb();

function resultRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

describe('任职命令并发与当前任职唯一', () => {
  it('同员工同 revision 的并发调动只有一个成功，记录和当前投影仍只有一个胜者', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'empconcurrent');
    const employee = await session.employee('并发合成员工');
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { employType: 'internal' } },
      employee.revision,
    );
    const responses = await Promise.all(
      ['2026-09-15', '2026-09-20'].map((effectiveDate) =>
        session.request('POST', `/employees/${employee.id}/businesses`, {
          ifMatch: hire.employeeRevision,
          body: { kind: 'transfer', mode: 'direct', effectiveDate, fields: { place: `合成地点${effectiveDate}` } },
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const succeeded = (await responses.find((response) => response.status === 201)!.json()) as EmploymentBusiness;
    const records = await session.records(employee.id);
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([succeeded.record!.id]);
    expect((await session.getEmployee(employee.id)).revision).toBe(hire.employeeRevision + 1);
    const currentProjection = await withTenant(db, session.tenant.id, (tx) =>
      tx.execute(sql`SELECT record_id FROM employment_timeline
        WHERE tenant_id = ${session.tenant.id} AND employee_id = ${employee.id}
          AND valid_during @> '2026-10-01'::date`),
    );
    expect(resultRows<{ record_id: string }>(currentProjection)).toEqual([{ record_id: succeeded.record!.id }]);
  });

  it('同命令同内容并发重放只追加一次，员工 revision 不重复增长', async () => {
    const session = await employmentSession(testDb().db, 'empconcurrentreplay');
    const employee = await session.employee('并发重放合成员工');
    const request = {
      ifMatch: employee.revision,
      idempotencyKey: randomUUID(),
      body: { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { employType: 'internal' } },
    };
    const responses = await Promise.all([
      session.request('POST', `/employees/${employee.id}/businesses`, request),
      session.request('POST', `/employees/${employee.id}/businesses`, request),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const first = (await responses[0]!.json()) as EmploymentBusiness;
    const second = (await responses[1]!.json()) as EmploymentBusiness;
    expect(second).toEqual(first);
    expect(await session.records(employee.id)).toHaveLength(1);
    expect((await session.getEmployee(employee.id)).revision).toBe(employee.revision + 1);
  });
});
