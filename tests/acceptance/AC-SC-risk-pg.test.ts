import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settledOrBlocked, withRelease } from './support/pg-interleave.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { riskWorld } from './AC-SC-risk-support.js';

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-risk 真 PG 清除 / 赋值 / 计算', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  }, 300000);
  afterAll(async () => handle?.close());
  it.each(['clear-compute', 'compute-clear', 'assign-compute', 'compute-assign', 'clear-assign', 'assign-clear'])(
    '%s：目标锁串行化，锁后读取 method 与 revision，无丢失更新',
    async (order) => {
      const w = await riskWorld(handle.db);
      const initial = await w.assign(0);
      expect(initial.status, await initial.clone().text()).toBe(200);
      if (order === 'compute-assign') expect((await w.assign(1, null)).status).toBe(200);
      const initialRevision = order === 'compute-assign' ? 2 : 1;
      const extra = await w.newPosition(w.org.id, '批量同行关键职位');
      const batch = await w.request('POST', '/maps/position/compute-risk', {
        ifMatch: 0,
        body: { showKeyPositions: true, showPositionsWithoutSuccessor: true },
      });
      expect(batch.status).toBe(202);
      const { runId } = (await batch.json()) as { runId: string };
      expect(
        await w.asTenant(async (tx) =>
          rowsOf(
            await tx.execute(sql`
        SELECT object_id FROM succession_calc_run_objects WHERE run_id=${runId}::uuid`),
          ),
        ),
      ).toEqual(expect.arrayContaining([{ object_id: w.position.id }, { object_id: extra.id }]));
      let release!: () => void, ready!: () => void;
      const acquired = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const blocker = w.asTenant(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM succession_target_locks WHERE target_id=${w.position.id}::uuid FOR UPDATE`);
        ready();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await acquired;
      const action = (name: string) =>
        name === 'compute' ? w.run(runId) : w.assign(initialRevision, name === 'clear' ? null : w.levelId);
      const [first, second] = order.split('-');
      let a: Promise<unknown> | undefined, b: Promise<unknown> | undefined;
      await withRelease(
        release,
        async (cleanup) => {
          cleanup.track(blocker);
          a = cleanup.track<unknown>(action(first!));
          expect(await settledOrBlocked(handle.db, a, 1)).toBe('blocked');
          b = cleanup.track<unknown>(action(second!));
          expect(await settledOrBlocked(handle.db, b, 2)).toBe('blocked');
        },
        [blocker],
      );
      const responses = await Promise.all([a!, b!]);
      const states: Record<string, { method: string; level_id: string | null; revision: number }> = {
        'clear-compute': { method: 'computed', level_id: w.levelId, revision: 3 },
        'compute-clear': { method: 'computed', level_id: null, revision: 2 },
        'assign-compute': { method: 'manual', level_id: w.levelId, revision: 2 },
        'compute-assign': { method: 'computed', level_id: w.levelId, revision: 3 },
        'clear-assign': { method: 'computed', level_id: null, revision: 2 },
        'assign-clear': { method: 'manual', level_id: w.levelId, revision: 2 },
      };
      expect(await w.result()).toEqual(states[order]);
      if (order.includes('compute'))
        expect(
          await w.asTenant(async (tx) =>
            rowsOf(
              await tx.execute(sql`
        SELECT level_id,method FROM succession_risk_results WHERE position_id=${extra.id}::uuid`),
            ),
          ),
        ).toEqual([{ level_id: null, method: 'computed' }]);
      const writes = responses.filter((r): r is Response => r instanceof Response);
      expect(writes.map((r) => r.status)).toEqual(
        ['clear-assign', 'assign-clear'].includes(order) ? [200, 409] : order === 'compute-assign' ? [409] : [200],
      );
    },
  );
});
