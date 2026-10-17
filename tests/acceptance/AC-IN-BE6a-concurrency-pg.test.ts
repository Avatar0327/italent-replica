/**
 * BE-6a 真 PostgreSQL：同一实习生并发两次直接实习转正（同一员工 revision）只有一次落地，另一次 409，
 * 不会出现两条实习转正任职或两份试用期信息（员工行锁 + revision，DEC-067 并发约定）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { internWorld } from './AC-IN-BE6a-support.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-IN-BE6a-07 并发直接实习转正（真 PG）', () => {
  it('同 revision 并发两次：一次 201、一次 409；只有一条实习转正与一份试用期信息', async () => {
    const w = await internWorld(testDb().db, 'be6a-pg-race');
    const intern = await w.hire('并发转正合成实习生', 'intern');
    const revision = await w.revision(intern.employee.id);
    const body = { effectiveDate: '2026-10-16', departmentId: w.org.id, probation: true, probationMonths: 2 };
    const responses = await Promise.all([
      w.regularize(intern.employee.id, body, revision),
      w.regularize(intern.employee.id, { ...body, probationMonths: 3 }, revision),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const counts = await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const [row] = rowsOf<{ records: number; periods: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::integer FROM employment_records WHERE tenant_id=${w.session.tenant.id}
            AND employee_id=${intern.employee.id}::uuid AND kind='intern_regularization') AS records,
          (SELECT count(*)::integer FROM employment_record_probation WHERE tenant_id=${w.session.tenant.id}
            AND employee_id=${intern.employee.id}::uuid) AS periods`),
      );
      return row;
    });
    expect(counts).toEqual({ records: 1, periods: 1 });
  });
});
