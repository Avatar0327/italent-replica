import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_TODAY, SC_NOW } from './AC-SC-support.js';
import { enableStatsRunner } from './AC-SC-stats-support.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { dispatchCalcJobs } from '../../apps/api/src/modules/succession/calc-jobs.js';

const testDb = useTestDb();
describe('AC-SC-07 组织健康度', () => {
  it('计算冻结全部授权组织、原命令重放保留集合；缓存取数、手工保留、重置冲突逐对象拒绝', async () => {
    const w = await successionWorld(testDb().db, 'health');
    const root = await w.org('健康根'),
      child = await w.org('健康下级', root.id);
    await enableStatsRunner(w);
    const levelResponse = await w.request('POST', '/health-levels', {
      ifMatch: 0,
      body: {
        code: 'HEALTH',
        name: '满星',
        color: '#336699',
        enabled: true,
        rules: {
          expression: '1',
          rows: [
            {
              rowNo: 1,
              population: 'all',
              fieldSource: 'org',
              fieldCode: 'on_duty_count',
              measure: 'average',
              comparator: 'between',
              threshold: 7,
              thresholdHigh: 7,
            },
          ],
        },
      },
    });
    expect(levelResponse.status, await levelResponse.clone().text()).toBe(201);
    const level = (await levelResponse.json()) as { id: string };
    const assign = (org: string, revision: number, id = level.id) =>
      w.request('PUT', `/health-results/${org}`, {
        ifMatch: revision,
        body: { levelId: id },
      });
    expect((await assign(child.id, 0)).status).toBe(200);
    const options = { ifMatch: 0, body: {}, idempotencyKey: randomUUID() };
    const compute = await w.request('POST', '/maps/org/compute-health', options);
    expect(compute.status, await compute.clone().text()).toBe(202);
    const { runId } = (await compute.json()) as { runId: string };
    await w.asTenant(async (tx) => {
      await tx.execute(sql`INSERT INTO succession_org_stats
        (tenant_id,org_id,stat_date,on_duty_count,slot_key,computed_at,run_id)
        VALUES (${w.tenant.id}::uuid,${root.id}::uuid,${SC_TODAY}::date,7,'cached',${SC_NOW.toISOString()}::timestamptz,${runId}::uuid)`);
    });
    await w.org('排队后新组织');
    expect(await (await w.request('POST', '/maps/org/compute-health', options)).json()).toEqual({ runId });
    const frozen = await w.asTenant(async (tx) =>
      rowsOf<{ object_id: string }>(
        await tx.execute(sql`SELECT object_id FROM succession_calc_run_objects WHERE run_id=${runId}::uuid`),
      ),
    );
    expect(frozen.map((r) => r.object_id).sort()).toEqual([root.id, child.id].sort());
    const { createHealthHandler } = await import('../../apps/api/src/modules/succession/health-worker.js');
    const port = createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id });
    expect(await runCalcPage(w.db, w.tenant.id, runId, [createHealthHandler('org_health', port)], SC_NOW)).toBe(
      'succeeded',
    );
    const read = async () =>
      (await (await w.request('GET', '/health-results')).json()) as {
        items: { orgId: string; levelId: string | null; method: string; revision: number }[];
      };
    const before = await read();
    expect(before.items.find((r) => r.orgId === root.id)).toMatchObject({
      levelId: level.id,
      method: 'computed',
      revision: 1,
    });
    expect(before.items.find((r) => r.orgId === child.id)).toMatchObject({
      levelId: level.id,
      method: 'manual',
      revision: 1,
    });
    const reset = await w.request('POST', '/health-results/reset', {
      body: {
        items: [
          { orgId: root.id, expectedRevision: 1 },
          { orgId: child.id, expectedRevision: 1 },
        ],
      },
    });
    expect(reset.status, await reset.clone().text()).toBe(202);
    const resetId = ((await reset.json()) as { runId: string }).runId;
    expect((await assign(child.id, 1)).status).toBe(200);
    expect(await runCalcPage(w.db, w.tenant.id, resetId, [createHealthHandler('org_health_reset', port)], SC_NOW)).toBe(
      'partial',
    );
    expect((await read()).items.find((r) => r.orgId === child.id)).toMatchObject({ method: 'manual', revision: 2 });
    expect((await read()).items.find((r) => r.orgId === root.id)).toMatchObject({ method: 'computed', revision: 2 });
    const failures = await w.asTenant(async (tx) =>
      rowsOf(await tx.execute(sql`SELECT code FROM succession_calc_run_failures WHERE run_id=${resetId}::uuid`)),
    );
    expect(failures).toEqual([{ code: 'REVISION_CONFLICT' }]);
    const count = await w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`)));
    await dispatchCalcJobs({ db: w.db, clock: () => SC_NOW }, { kind: 'org_health' });
    expect(
      await w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`))),
    ).toHaveLength(count.length);
  });
});
