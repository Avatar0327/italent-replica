import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';
import { waitHealthLock } from './AC-SC-07-health-lock-support.js';
import { lockHealthTarget } from '../../apps/api/src/modules/succession/health-results.js';
import { enqueueCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { createHealthHandler } from '../../apps/api/src/modules/succession/health-worker.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { withRelease } from './support/pg-interleave.js';

const testDb = useHealthDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-07 真 PG 健康度交错', () => {
  it.each([
    ['org_health', false],
    ['org_health_reset', false],
    ['org_health', true],
    ['org_health_reset', true],
  ] as const)('%s 先持设置与目标锁，非空值=%s 的赋值等待后 revision 冲突', async (kind, nonempty) => {
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
    const levelId = (await response.json()).id;
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
    let entered!: () => void,
      release!: () => void,
      blocker = 0;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const port = createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id });
    const reads = Object.assign(Object.create(port) as typeof port, {
      greenRate: async (tx: Tx) => {
        const [backend] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
        blocker = backend!.pid;
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
    const assign = w.request('PUT', `/health-results/${org.id}`, {
      ifMatch: 0,
      body: { levelId: nonempty ? levelId : null },
    });
    await withRelease(release, async (cleanup) => {
      [worker, assign].forEach(cleanup.track);
      const waiting = await waitHealthLock(w.db, blocker, 'org_settings');
      expect(waiting.query).toContain('org_settings');
      expect(waiting.locktype).toBe('transactionid');
    });
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
  it.each([false, true])('非空值=%s：两个手动赋值同 revision 只一个成功；同键并发只写一次', async (nonempty) => {
    const w = await successionWorld(testDb().db, 'health-assign-pg'),
      org = await w.org('赋值并发');
    let levelId: string | null = null;
    if (nonempty) {
      const saved = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: 'H',
          name: '健康赋值',
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
      expect(saved.status).toBe(201);
      levelId = (await saved.json()).id;
    }
    const send = (key: string, revision: number) =>
      w.request('PUT', `/health-results/${org.id}`, {
        ifMatch: revision,
        body: { levelId },
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
      SELECT level_id,method,revision FROM succession_health_results WHERE org_id=${org.id}::uuid`),
        ),
      ),
    ).toEqual([{ level_id: levelId, method: nonempty ? 'manual' : 'computed', revision: 2 }]);
  });
});

// 与上组反向：HTTP 赋值先进入目标锁，worker 在组织设置锁等待；目标锁证据用独立持锁者排除设置锁混淆。
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-07 P3 非空赋值反向交错', () => {
  it.each(['org_health', 'org_health_reset'] as const)(
    '%s 等待先进入的非空 HTTP 赋值，保留手工值或逐对象冲突',
    async (kind) => {
      const w = await successionWorld(testDb().db, `health-reverse-${kind}`),
        org = await w.org('反向交错组织');
      await enableHealthRunner(w);
      const saved = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: 'MANUAL',
          name: '手工健康',
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
      expect(saved.status).toBe(201);
      const levelId = (await saved.json()).id;
      const runId = await w.asTenant((tx) =>
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
      await w.asTenant((tx) => lockHealthTarget(tx, w.tenant.id, org.id));
      let entered!: (pid: number) => void, release!: () => void;
      const ready = new Promise<number>((r) => {
          entered = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      const holder = w.asTenant(async (tx) => {
        await lockHealthTarget(tx, w.tenant.id, org.id);
        const [backend] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
        entered(backend!.pid);
        await gate;
      });
      const blocker = await ready;
      const assign = w.request('PUT', `/health-results/${org.id}`, { ifMatch: 0, body: { levelId } });
      let worker: ReturnType<typeof runCalcPage> | undefined;
      await withRelease(
        release,
        async (cleanup) => {
          [assign, holder].forEach(cleanup.track);
          const targetWait = await waitHealthLock(w.db, blocker, 'succession_target_locks');
          expect(targetWait.query).toContain('FOR UPDATE');
          expect(targetWait.locktype).toBe('transactionid');
          worker = cleanup.track(runCalcPage(w.db, w.tenant.id, runId, [createHealthHandler(kind)], SC_NOW));
          const settingsWait = await waitHealthLock(w.db, targetWait.pid, 'org_settings');
          expect(settingsWait.query).toContain('org_settings');
          expect(settingsWait.pid).not.toBe(targetWait.pid);
        },
        [holder],
      );
      const assigned = await assign;
      expect(assigned.status).toBe(200);
      expect(await assigned.json()).toMatchObject({ levelId, levelName: '手工健康', method: 'manual', revision: 1 });
      expect(await worker).toBe(kind === 'org_health' ? 'succeeded' : 'partial');
      const stored = await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT level_id,method,revision FROM succession_health_results WHERE org_id=${org.id}::uuid`),
        ),
      );
      expect(stored).toEqual([{ level_id: levelId, method: 'manual', revision: 1 }]);
      const outcome = await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT o.outcome,f.code FROM succession_calc_run_objects o LEFT JOIN succession_calc_run_failures f
      ON f.tenant_id=o.tenant_id AND f.run_id=o.run_id AND f.object_id=o.object_id
      WHERE o.run_id=${runId}::uuid`),
        ),
      );
      expect(outcome).toEqual([
        {
          outcome: kind === 'org_health' ? 'manual_kept' : 'revision_conflict',
          code: kind === 'org_health' ? null : 'REVISION_CONFLICT',
        },
      ]);
    },
  );
});
