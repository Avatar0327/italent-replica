/** F-007 / F-008：强制组织联动与调动同时等待同一员工锁，验证锁后重查与整体回滚。 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
async function waitForBoth(db: Db) {
  for (let i = 0; i < 200; i++) {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%employment_employees%'`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    if (rows[0]!.n >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('组织联动和调动未同时进入员工锁等待');
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-ORG-34 真实 PG 交错', () => {
  it.each([false, true])('组织调整与调动串行，失败方回滚且不死锁（导入=%s）', async (viaImport) => {
    const w = await activationWorld(database().db, 'org34pg');
    const person = await w.hired();
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    let pending: Promise<Response>[] = [];
    await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.session.tenant.id} AND id=${person.employee.id}::uuid FOR UPDATE`);
      pending = [
        api.request(
          viaImport ? 'POST' : 'PATCH',
          viaImport ? '/api/tenant/org/import' : `/api/tenant/org/organizations/${w.from.id}`,
          {
            user: w.session.user.id,
            tenant: w.session.tenant.id,
            ifMatch: viaImport ? 0 : w.from.revision,
            body: viaImport
              ? {
                  rows: [
                    {
                      sourceCode: w.from.id,
                      orgId: w.from.id,
                      code: 'INTERLEAVE',
                      name: '交错改名',
                      parentId: w.session.tenant.id,
                      expectedRevision: w.from.revision,
                      startDate: '2026-10-09',
                      addEmployment: true,
                    },
                  ],
                }
              : { name: '交错改名', effectiveDate: '2026-10-09', addEmployment: true },
          },
        ),
        w.session.request('POST', `/employees/${person.employee.id}/businesses`, {
          ifMatch: person.hire.employeeRevision,
          body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
        }),
      ];
      await waitForBoth(w.db);
    });
    const [org, transfer] = await Promise.all(pending);
    const records = await w.session.records(person.employee.id, '2026-10-09');
    expect(records).toHaveLength(2);
    if (org!.status === 200) {
      expect(transfer!.status).toBe(409);
      expect(records.find((r) => r.isCurrent)).toMatchObject({
        kind: 'org_adjustment',
        fields: { departmentId: w.from.id },
      });
    } else {
      expect(org!.status, await org!.clone().text()).toBe(409);
      expect(transfer!.status, await transfer!.clone().text()).toBe(201);
      expect(await org!.json()).toMatchObject({ error: { details: { reason: 'ORG_EMPLOYMENT_PLAN_CHANGED' } } });
      expect(records.find((r) => r.isCurrent)).toMatchObject({ kind: 'transfer', fields: { departmentId: w.to.id } });
      const loaded = await api.request('GET', `/api/tenant/org/organizations/${w.from.id}?asOf=2026-10-09`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
      });
      expect(await loaded.json()).toMatchObject({ name: w.from.name, revision: w.from.revision });
    }
  });
});
