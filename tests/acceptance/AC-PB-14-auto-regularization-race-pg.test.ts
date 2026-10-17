/**
 * BE-15a 自动转正幂等的真 PG 并发（AC-PB-14，DEC-539①）：两次“立即执行”与每日批次同时运行，同一任职同一规则只发起一次。
 * 立即执行在员工锁上等待、每日批次 SKIP LOCKED 跳过；取到锁后都按发起台账复核，台账主键（租户 × 规则 × 本任职）兜底。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { hire, pbWorld } from './AC-PB-support.js';
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
});
