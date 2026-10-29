import { randomUUID } from 'node:crypto';
import { sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { successionWorld } from './AC-SC-support.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-map-stats 真 PG 并发', () => {
  it.each([true, false])('偏好行锁交错：同键=%s，重放或 revision 冲突，统计一次', async (sameKey) => {
    const w = await successionWorld(testDb().db, `sc-prefs-pg-${sameKey}`);
    const root = await w.org('并发根');
    const body = {
      rootOrgId: root.id,
      depth: 3,
      hiddenOrgIds: [],
      showKeyPositions: false,
      showPositionsWithoutSuccessor: true,
    };
    expect((await w.request('PUT', '/maps/position/preferences', { ifMatch: 0, body })).status).toBe(200);
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      ready = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocker = w.asTenant(async (tx) => {
      await tx.execute(sql`SELECT * FROM succession_map_preferences WHERE user_id=${w.user.id}::uuid FOR UPDATE`);
      ready();
      await gate;
    });
    await entered;
    const key = randomUUID();
    const send = (idempotencyKey: string) =>
      w.request('PUT', '/maps/position/preferences', {
        ifMatch: 1,
        body: { ...body, showPositionsWithoutSuccessor: false },
        idempotencyKey,
      });
    const requests = [send(key), send(sameKey ? key : randomUUID())];
    await withRelease(
      release,
      async (cleanup) => {
        [...requests, blocker].forEach((request) => cleanup.track<unknown>(request));
        await waitForBlocked(w.db, 2);
      },
      [blocker],
    );
    await blocker;
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status).sort()).toEqual(sameKey ? [200, 200] : [200, 409]);
    const rows = await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT revision,
      show_positions_without_successor FROM succession_map_preferences WHERE map_kind='position'`),
      ),
    );
    expect(rows).toEqual([{ revision: 2, show_positions_without_successor: false }]);
    const runs = await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT id
      FROM succession_calc_runs WHERE trigger='preferences_change'`),
      ),
    );
    expect(runs).toHaveLength(2);
  });

  it('compute-stats 两并发同命令只冻结一次；失去连接回查保留同一 run', async () => {
    const w = await successionWorld(testDb().db, 'sc-compute-pg');
    await w.org('并发统计');
    const options = { ifMatch: 0, idempotencyKey: randomUUID(), body: {} };
    const responses = await Promise.all([
      w.request('POST', '/maps/org/compute-stats', options),
      w.request('POST', '/maps/org/compute-stats', options),
    ]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    const runs = await w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`)));
    expect(runs).toHaveLength(1);
    let unknown = true;
    const transaction: Db['transaction'] = async (callback, config) => {
      const result = await w.db.transaction(callback, config);
      if (unknown && result && typeof result === 'object' && 'status' in result && result.status === 202) {
        unknown = false;
        throw new Error('模拟已提交但连接回包丢失');
      }
      return result;
    };
    const wrapped = new Proxy(w.db, {
      get(target, key, receiver) {
        return key === 'transaction' ? transaction : Reflect.get(target, key, receiver);
      },
    });
    const api = tenantApi(wrapped);
    const recovered = await api.request('POST', '/api/tenant/succession/maps/org/compute-stats', {
      ...options,
      idempotencyKey: randomUUID(),
      user: w.user.id,
      tenant: w.tenant.id,
    });
    expect(unknown).toBe(false);
    expect(recovered.status, await recovered.clone().text()).toBe(202);
    expect(
      await w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`))),
    ).toHaveLength(2);
  });
});
