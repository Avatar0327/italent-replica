import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { enableHealthRunner } from './AC-SC-07-health-support.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { enqueueCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { createHealthHandler } from '../../apps/api/src/modules/succession/health-worker.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';

const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-07 真 PG 健康度交错', () => {
  it.each(['org_health', 'org_health_reset'] as const)('%s 先持目标锁，手动赋值等待后 revision 冲突', async (kind) => {
    const w = await successionWorld(testDb().db, `health-pg-${kind}`),
      org = await w.org('健康并发');
    await enableHealthRunner(w);
    const response = await w.request('POST', '/health-levels', {
      ifMatch: 0,
      body: {
        code: 'H',
        name: '健康',
        color: '#336699',
        rules: {
          expression: '1',
          rows: [
            {
              rowNo: 1,
              population: 'all',
              fieldSource: 'org',
              measure: 'green_rate',
              comparator: 'ge',
              threshold: 0,
            },
          ],
        },
      },
    });
    expect(response.status).toBe(201);
    const id = await w.asTenant((tx) =>
      enqueueCalcRun(
        tx,
        {
          tenantId: w.tenant.id,
          kind,
          trigger: 'manual',
          commandId: randomUUID(),
          requestedBy: w.user.id,
          businessDate: SC_TODAY,
          objects: [{ objectType: 'org', objectId: org.id, expectedRevision: 0 }],
        },
        SC_NOW,
      ),
    );
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const port = createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id });
    const reads = Object.assign(Object.create(port) as typeof port, {
      greenRate: async () => {
        entered();
        await gate;
        return new Map([[org.id, { status: 'value' as const, rate: 0.5, placed: 2, green: 1, source: null }]]);
      },
    });
    const worker = runCalcPage(w.db, w.tenant.id, id, [createHealthHandler(kind, reads)], SC_NOW);
    await Promise.race([
      ready,
      worker.then((status) => {
        throw new Error(`worker 提前结束：${status}`);
      }),
    ]);
    const assign = w.request('PUT', `/health-results/${org.id}`, { ifMatch: 0, body: { levelId: null } });
    try {
      await waitForBlocked(w.db, 1);
    } finally {
      release();
    }
    expect(await worker).toBe('succeeded');
    const rejected = await assign;
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT method,revision FROM succession_health_results WHERE org_id=${org.id}::uuid`),
        ),
      ),
    ).toEqual([{ method: 'computed', revision: 1 }]);
  });
  it('两个手动赋值同 revision 只一个成功；同键并发只写一次', async () => {
    const w = await successionWorld(testDb().db, 'health-assign-pg'),
      org = await w.org('赋值并发');
    const send = (key: string, revision: number) =>
      w.request('PUT', `/health-results/${org.id}`, {
        ifMatch: revision,
        body: { levelId: null },
        idempotencyKey: key,
      });
    const responses = await Promise.all([send(randomUUID(), 0), send(randomUUID(), 0)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const key = randomUUID();
    expect((await Promise.all([send(key, 1), send(key, 1)])).map((r) => r.status)).toEqual([200, 200]);
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT method,revision FROM succession_health_results WHERE org_id=${org.id}::uuid`),
        ),
      ),
    ).toEqual([{ method: 'manual', revision: 2 }]);
  });
});
