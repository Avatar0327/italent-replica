import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
import { rowsOf } from '../../apps/api/src/modules/establishment/store.js';

const database = useTestDb();
async function blocked(db: Db, count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row?.n === count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未观察到 ${count} 个 PostgreSQL 锁等待者`);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EST-12 带编增减与占编校验使用同一把 PG 锁', () => {
  it('带编调入先持编制锁，普通调动等待提交后重读容量与占用，拒绝超编', async () => {
    const w = await carriedWorld(database().db, 'carried-lock-check');
    const first = await w.hired('合成带编员工');
    const second = await w.hired('合成普通调动员工');
    const requests = await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT tenant_id FROM establishment_settings
        WHERE tenant_id=${w.session.tenant.id} FOR UPDATE`);
      const carried = w.save(first);
      await blocked(w.db, 1);
      const ordinary = w.save(second, { withEstablishment: false });
      await blocked(w.db, 2);
      return [carried, ordinary];
    });
    const [carried, ordinary] = await Promise.all(requests);
    expect(carried!.status, await carried!.clone().text()).toBe(201);
    expect(ordinary!.status).toBe(409);
    expect(await ordinary!.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect((await w.capacities())[1]).toMatchObject({ localCapacity: 1 });
    expect(await w.history()).toHaveLength(2);
  });

  it('两名员工并发从最后一份预留扣减：仅一笔成功，无负数或丢失更新', async () => {
    const w = await carriedWorld(database().db, 'carried-lock-reserve', { matched: false, reserve: 1 });
    const first = await w.hired('合成先调动');
    const second = await w.hired('合成后调动');
    const requests = await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT tenant_id FROM establishment_settings
        WHERE tenant_id=${w.session.tenant.id} FOR UPDATE`);
      const a = w.save(first);
      await blocked(w.db, 1);
      const b = w.save(second);
      await blocked(w.db, 2);
      return [a, b];
    });
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual([201, 409]);
    expect((await w.capacities())[0]).toMatchObject({ localCapacity: 2, reservedLocal: 0 });
    expect(await w.history()).toHaveLength(2);
  });
});
