import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDER_CODE_INTERVAL_MS,
  runOrderCodeJobs,
  startOrderCodeScheduler,
} from '../../apps/api/src/modules/personnel/order-code-scheduler.js';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';

const database = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00Z');
async function setup(label: string, timezone = 'Asia/Shanghai', configured = true) {
  const db = database().db;
  const w = await employmentSession(db, label, { timezone });
  const e = await w.employee('合成人员', 'A');
  await w.business(e.id, { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: {} }, 1);
  if (configured) {
    const api = tenantApi(db, { clock });
    const response = await api.request('PUT', '/api/tenant/personnel/order-code/settings', {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: 0,
      body: { enabled: true, items: [{ field: 'code', direction: 'asc', enabled: true }] },
    });
    expect(response.status).toBe(200);
  }
  return { ...w, db };
}
describe('AC-EMP-16 周期重算', () => {
  it('DEC-171 定时任务不为未配置租户写入名次，也能清空先前默认规则遗留名次', async () => {
    const w = await setup('oc-no-config', 'Asia/Shanghai', false);
    await runOrderCodeJobs(w.db, { clock });
    await withTenant(w.db, w.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT * FROM personnel_employee_order_codes`))).toEqual([]);
      await tx.execute(sql`INSERT INTO personnel_employee_order_codes(tenant_id,employee_id,order_code)
        SELECT tenant_id,id,1 FROM employment_employees`);
    });
    await runOrderCodeJobs(w.db, { clock: () => new Date(clock().getTime() + DEFAULT_ORDER_CODE_INTERVAL_MS) });
    await withTenant(w.db, w.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT order_code FROM personnel_employee_order_codes`))).toEqual([
        { order_code: null },
      ]);
    });
  });

  it('失败回执也无法写入时报告错误，仍继续本轮其余租户', async () => {
    const pair = [await setup('oc-double-fail'), await setup('oc-after-fail')].sort((a, b) =>
      a.tenant.id.localeCompare(b.tenant.id),
    );
    const [bad, good] = pair;
    const db = bad!.db;
    await db.execute(sql`CREATE FUNCTION test_order_double_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic double failure'; END $$`);
    for (const table of ['personnel_employee_order_codes', 'personnel_order_runs']) {
      await db.execute(
        sql.raw(`CREATE TRIGGER test_order_double_failure BEFORE INSERT ON ${table}
        FOR EACH ROW WHEN (NEW.tenant_id = '${bad!.tenant.id}'::uuid) EXECUTE FUNCTION test_order_double_failure()`),
      );
    }
    const errors: unknown[] = [];
    try {
      const report = await runOrderCodeJobs(db, { clock, onError: (error: unknown) => errors.push(error) });
      expect(report.failures).toContainEqual({
        tenantId: bad!.tenant.id,
        state: 'unknown',
        error: 'SERVICE_UNAVAILABLE',
      });
      expect(errors).toHaveLength(1);
      await withTenant(db, good!.tenant.id, async (tx) => {
        expect(rows(await tx.execute(sql`SELECT order_code FROM personnel_employee_order_codes`))).toEqual([
          { order_code: 1 },
        ]);
      });
    } finally {
      for (const table of ['personnel_employee_order_codes', 'personnel_order_runs']) {
        await db.execute(sql.raw(`DROP TRIGGER test_order_double_failure ON ${table}`));
      }
    }
  });

  it('默认三小时、同周期不重复，下周期采用新规则；业务日期使用租户时区', async () => {
    expect(DEFAULT_ORDER_CODE_INTERVAL_MS).toBe(10_800_000);
    const w = await setup('oc-clock', 'America/Los_Angeles');
    expect((await runOrderCodeJobs(w.db, { clock })).failures).toEqual([]);
    const before = await withTenant(w.db, w.tenant.id, async (tx) =>
      rows(
        await tx.execute(sql`
      SELECT response_body FROM command_ledger WHERE command_id LIKE 'person-order:%'`),
      ),
    );
    expect(before[0]?.response_body).toMatchObject({ businessDate: '2026-09-30' });
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
      UPDATE personnel_order_settings SET enabled=false,revision=1 WHERE tenant_id=${w.tenant.id}`),
    );
    await runOrderCodeJobs(w.db, { clock });
    const ranks = () =>
      withTenant(w.db, w.tenant.id, async (tx) =>
        rows(
          await tx.execute(sql`
      SELECT order_code FROM personnel_employee_order_codes`),
        ),
      );
    expect(await ranks()).toEqual([{ order_code: 1 }]);
    await runOrderCodeJobs(w.db, { clock: () => new Date(clock().getTime() + DEFAULT_ORDER_CODE_INTERVAL_MS) });
    expect(await ranks()).toEqual([{ order_code: null }]);
  });

  it('失败事务不留下部分名次或审计，同周期重试可恢复且其他租户继续运行', async () => {
    const w = await setup('oc-failure');
    const other = await setup('oc-success');
    // 测试库属主安装故障触发器，业务路径仍为 app_user + RLS。
    await w.db.execute(sql`CREATE FUNCTION test_order_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic storage failure'; END $$`);
    await w.db.execute(
      sql.raw(`CREATE TRIGGER test_order_failure BEFORE INSERT ON personnel_employee_order_codes
      FOR EACH ROW WHEN (NEW.tenant_id = '${w.tenant.id}'::uuid) EXECUTE FUNCTION test_order_failure()`),
    );
    const first = await runOrderCodeJobs(w.db, { clock });
    expect(first.failures).toContainEqual({ tenantId: w.tenant.id, state: 'unknown', error: 'SERVICE_UNAVAILABLE' });
    await withTenant(w.db, w.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT * FROM personnel_employee_order_codes`))).toEqual([]);
      expect(rows(await tx.execute(sql`SELECT * FROM audit_events WHERE object_type='personnel-order-code'`))).toEqual(
        [],
      );
      expect(rows(await tx.execute(sql`SELECT state,attempts FROM personnel_order_runs`))).toEqual([
        { state: 'unknown', attempts: 1 },
      ]);
    });
    await withTenant(other.db, other.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT order_code FROM personnel_employee_order_codes`))).toEqual([
        { order_code: 1 },
      ]);
    });
    await w.db.execute(sql`DROP TRIGGER test_order_failure ON personnel_employee_order_codes`);
    expect((await runOrderCodeJobs(w.db, { clock })).failures).toEqual([]);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT state,attempts FROM personnel_order_runs`))).toEqual([
        { state: 'succeeded', attempts: 2 },
      ]);
    });
  });

  it('多实例同周期并发只提交一次名次、审计、outbox 与成功尝试', async () => {
    const w = await setup('oc-concurrent');
    const results = await Promise.all(Array.from({ length: 3 }, () => runOrderCodeJobs(w.db, { clock })));
    expect(results.flatMap((r) => r.failures)).toEqual([]);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT state,attempts FROM personnel_order_runs`))).toEqual([
        { state: 'succeeded', attempts: 1 },
      ]);
      expect(rows(await tx.execute(sql`SELECT revision,order_code FROM personnel_employee_order_codes`))).toEqual([
        { revision: 1, order_code: 1 },
      ]);
      expect(
        rows(
          await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
        WHERE object_type='personnel-order-code'`),
        ),
      ).toEqual([{ n: 1 }]);
      expect(
        rows(
          await tx.execute(sql`SELECT count(*)::int AS n FROM personnel_outbox
        WHERE object_type='personnel-order-code'`),
        ),
      ).toEqual([{ n: 1 }]);
    });
  });

  it('可配置周期且拒绝定时器溢出；启动立即跑一轮，stop 等待完成', async () => {
    const w = await setup('oc-start');
    expect(() => startOrderCodeScheduler(w.db, { intervalMs: 999 })).toThrow(RangeError);
    expect(() => startOrderCodeScheduler(w.db, { intervalMs: 2 ** 31 })).toThrow(RangeError);
    const errors: unknown[] = [];
    const scheduler = startOrderCodeScheduler(w.db, { intervalMs: 60_000, clock, onError: (e) => errors.push(e) });
    await scheduler.stop();
    expect(errors).toEqual([]);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT state FROM personnel_order_runs`))).toEqual([{ state: 'succeeded' }]);
    });
  });
});
