import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { rowsOf } from '../../apps/api/src/modules/establishment/store.js';
const database = useTestDb();
it.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EST-25 PG 交错保存等待后读取未来重叠并要求确认', async () => {
  const w = await carriedWorld(database().db, 'overlap-pg');
  await configure(w, false);
  const first = await w.hired('甲');
  const second = await w.hired('乙');
  async function blocked(count: number) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = rowsOf<{ n: number }>(
        await w.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
      );
      if (row?.n === count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`未观察到 ${count} 个锁等待者`);
  }
  const requests = await withTenant(w.db, w.session.tenant.id, async (barrier) => {
    await barrier.execute(sql`SELECT tenant_id FROM establishment_settings
      WHERE tenant_id=${w.session.tenant.id} FOR UPDATE`);
    const a = w.save(first, { withEstablishment: false, effectiveDate: '2026-10-20' });
    await blocked(1);
    const b = w.save(second, { withEstablishment: false, effectiveDate: '2026-10-05' });
    await blocked(2);
    return [a, b];
  });
  const [a, b] = await Promise.all(requests);
  expect(a!.status, await a!.clone().text()).toBe(201);
  await warning(b!);
  expect((await w.session.getEmployee(second.employee.id)).revision).toBe(second.hire.employeeRevision);
  expect((await w.save(second, { withEstablishment: false, confirmed: true })).status).toBe(201);
});
