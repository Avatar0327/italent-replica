import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';

const database = useTestDb();
describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EMP-16 真 PG 持锁屏障', () => {
  it('配置锁争用在 5 秒超时、事务回滚；MVCC 读取可用，释放屏障后同键可重试', async () => {
    const db = database().db;
    const { tenant, user } = await seedTenantWithMember(db, 'oc-lock-timeout');
    const api = tenantApi(db);
    const as = { tenant: tenant.id, user: user.id };
    expect(
      (
        await api.request('PUT', '/api/tenant/personnel/order-code/settings', {
          ...as,
          ifMatch: 0,
          body: { enabled: true, items: [{ field: 'code', direction: 'asc', enabled: true }] },
        })
      ).status,
    ).toBe(200);
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = withTenant(db, tenant.id, async (tx) => {
      await tx.execute(sql`SELECT tenant_id FROM personnel_order_settings WHERE tenant_id=${tenant.id} FOR UPDATE`);
      signalHeld();
      await barrier;
    });
    await held;
    const request = () =>
      api.request('POST', '/api/tenant/personnel/order-code/recompute', {
        ...as,
        ifMatch: 1,
        body: {},
        idempotencyKey: 'timeout-then-retry',
      });
    const blocked = request();
    try {
      await expect
        .poll(async () => {
          const [row] = rows<{ n: number }>(
            await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'`),
          );
          return row?.n;
        })
        .toBe(1);
      const readable = await api.request('GET', '/api/tenant/personnel/order-code/settings', as);
      expect(readable.status).toBe(200);
      expect(await readable.json()).toMatchObject({ revision: 1 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timed = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('重算没有按锁等待上限退出')), 8000);
        });
        expect((await Promise.race([blocked, timed])).status).toBe(503);
      } finally {
        clearTimeout(timer);
      }
      await withTenant(db, tenant.id, async (tx) => {
        expect(rows(await tx.execute(sql`SELECT * FROM personnel_order_runs`))).toEqual([]);
        expect(rows(await tx.execute(sql`SELECT * FROM audit_events WHERE action='personnel.order.run'`))).toEqual([]);
      });
    } finally {
      release();
      await blocker;
      await blocked;
    }
    expect((await request()).status).toBe(200);
  });
});
