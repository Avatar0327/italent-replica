/**
 * BE-15a 自动转正幂等的真 PG 并发（AC-PB-14，DEC-539①）：两次“立即执行”与每日批次同时运行，同一任职同一规则只发起一次。
 * 立即执行在员工锁上等待、每日批次 SKIP LOCKED 跳过；取到锁后都按发起台账复核，台账主键（租户 × 规则 × 本任职）兜底。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as regularization from '../../apps/api/src/modules/employment/regularization.js';
import { hire, pbWorld } from './AC-PB-support.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const SCHEDULER = '../../apps/api/src/modules/employment/auto-regularization-scheduler.js';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface SchedulerModule {
  runAutoRegularizations(
    db: Parameters<typeof withTenant>[0],
    meta: { actorUserId: null; commandId: string },
    input?: { tenantId?: string },
    options?: { clock?: () => Date },
  ): Promise<{ runs: { launched: unknown[] }[] }>;
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-PB-14 立即执行与每日批次并发不重复发起（真 PG）', () => {
  it('两次立即执行 + 每日批次同时运行：每名到期员工只有一张转正业务、一条发起台账', async () => {
    const w = await pbWorld(testDb().db, 'auto-reg-race', { approval: true });
    const settings = tenantApi(w.db);
    const as = { tenant: w.session.tenant.id, user: w.session.user.id };
    const put = await settings.request('PUT', '/api/tenant/settings/probation.auto_regularization_enabled', {
      ...as,
      ifMatch: 0,
      body: { value: true },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const rule = await w.session.request('POST', '/auto-regularization-rules', {
      ifMatch: 0,
      body: {
        name: '并发规则',
        priority: 1,
        orgIds: [w.org.id],
        mode: 'application',
        daysBefore: 0,
        initiatorType: 'rule_operator',
      },
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
    const employees: string[] = [];
    for (let i = 0; i < 4; i += 1)
      employees.push((await hire(w, { date: '2026-09-01', months: 1, name: `并发员工${i}` })).employee.id);

    const module = (await import(SCHEDULER)) as SchedulerModule;
    const runNow = () => w.session.request('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    const [first, second, scheduled] = await Promise.all([
      runNow(),
      runNow(),
      module.runAutoRegularizations(
        w.db,
        { actorUserId: null, commandId: randomUUID() },
        { tenantId: w.session.tenant.id },
        { clock: () => new Date('2026-10-01T01:00:00.000Z') },
      ),
    ]);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(second.status, await second.clone().text()).toBe(200);
    const launched =
      ((await first.json()) as { launched: unknown[] }).launched.length +
      ((await second.json()) as { launched: unknown[] }).launched.length +
      scheduled.runs.reduce((sum, run) => sum + run.launched.length, 0);
    expect(launched).toBe(employees.length);

    const counts = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ employee_id: string; businesses: number; launches: number }>(
        await tx.execute(sql`SELECT e.id::text AS employee_id,
            (SELECT count(*)::int FROM employment_business_objects b
              JOIN LATERAL (SELECT kind FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
                AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
              WHERE b.tenant_id=e.tenant_id AND b.employee_id=e.id AND p.kind='regularization') AS businesses,
            (SELECT count(*)::int FROM employment_auto_regularization_launches l
              WHERE l.tenant_id=e.tenant_id AND l.employee_id=e.id AND l.state='launched') AS launches
          FROM employment_employees e WHERE e.tenant_id=${w.session.tenant.id}
            AND e.id = ANY(${`{${employees.join(',')}}`}::uuid[]) ORDER BY e.id`),
      ),
    );
    expect(counts.map((row) => [row.businesses, row.launches])).toEqual(employees.map(() => [1, 1]));
  });

  afterEach(() => vi.restoreAllMocks());

  it('屏障交错：第一次立即执行在发起途中暂停，第二次在员工锁上等待，放行后不重复发起（第 1 轮 P3）', async () => {
    const w = await pbWorld(testDb().db, 'auto-reg-barrier', { approval: true });
    const settings = tenantApi(w.db);
    const as = { tenant: w.session.tenant.id, user: w.session.user.id };
    const put = await settings.request('PUT', '/api/tenant/settings/probation.auto_regularization_enabled', {
      ...as,
      ifMatch: 0,
      body: { value: true },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const rule = await w.session.request('POST', '/auto-regularization-rules', {
      ifMatch: 0,
      body: {
        name: '屏障规则',
        priority: 1,
        orgIds: [w.org.id],
        mode: 'application',
        daysBefore: 0,
        initiatorType: 'rule_operator',
      },
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
    const employees: string[] = [];
    for (let i = 0; i < 2; i += 1)
      employees.push((await hire(w, { date: '2026-09-01', months: 1, name: `屏障员工${i}` })).employee.id);

    let entered!: () => void;
    let resume!: () => void;
    const enteredOnce = new Promise<void>((done) => (entered = done));
    const released = new Promise<void>((done) => (resume = done));
    const original = regularization.launchRegularization;
    let paused = false;
    vi.spyOn(regularization, 'launchRegularization').mockImplementation(async (...args) => {
      if (!paused) {
        paused = true;
        entered();
        await released;
      }
      return original(...args);
    });
    const runNow = () => w.session.request('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    // 门在被 mock 的 launchRegularization 里（第一次执行自己持员工锁）：等待失败时也要放门并收束两个请求（F-282）
    const pending = await withRelease(resume, async (run) => {
      const first = run.track(runNow());
      await enteredOnce;
      const second = run.track(runNow());
      // 第二次立即执行在第一次持有的员工锁上等待（不跳过、不报错）
      await waitForBlocked(w.db, 1);
      return [first, second] as const;
    });
    const [a, b] = await Promise.all(pending);
    expect(a.status, await a.clone().text()).toBe(200);
    expect(b.status, await b.clone().text()).toBe(200);
    expect(((await a.json()) as { launched: unknown[] }).launched).toHaveLength(employees.length);
    expect((await b.json()) as { launched: unknown[]; failed: unknown[] }).toMatchObject({ launched: [], failed: [] });
    const counts = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM employment_auto_regularization_launches
          WHERE tenant_id=${w.session.tenant.id} AND state='launched'`),
      ),
    );
    expect(counts[0]!.n).toBe(employees.length);
  });
});
