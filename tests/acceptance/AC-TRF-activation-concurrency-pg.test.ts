/**
 * R1-T08 真 PostgreSQL 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 * 屏障事务先锁住业务头行，逐个确认参与方已阻塞在锁上再放行，保证它们真正重叠：
 * - 多实例：一个实例持员工锁生效到一半时，另一实例对同一员工 SKIP LOCKED 跳过，不重复生效；
 * - HR 重试并发：两次重试排队在同一员工锁上，先到者生效，后到者按 revision 409，不重复生效；
 * - DEC-112 挂起顺序：定时任务先拿到员工锁记下“因前序业务失败挂起”，同时排队的 HR 重试随后让 A、B 按序生效；
 *   反向交错时定时任务跳过被重试持有的员工，B 由重试紧接着生效，两种顺序版本链都是 A → B。
 */
import { registerEmploymentActivationChecks, runEmploymentActivations } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { cmd } from './support/tenant-api.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

let fullDepartments = new Set<string>();
registerEmploymentActivationChecks({
  establishmentExceeded: async (_tx, _ctx, target) => fullDepartments.has(target.departmentId ?? ''),
});
afterEach(() => {
  fullDepartments = new Set();
});

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

async function lockWaiters(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  return Number(row?.n);
}

async function waitForBlocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    if ((await lockWaiters(db)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

/** 屏障：在租户上下文里锁住业务头行（行受 RLS 保护），在锁内启动参与方并等它们排队后放行。 */
async function withBusinessBarrier<T>(w: ActivationWorld, businessId: string, inside: () => Promise<T>): Promise<T> {
  return withTenant(w.db, w.session.tenant.id, async (barrier) => {
    const locked = await barrier.execute(sql`SELECT id FROM employment_business_objects
      WHERE tenant_id=${w.session.tenant.id} AND id=${businessId}::uuid FOR UPDATE`);
    expect(rowsOf(locked)).toHaveLength(1);
    return inside();
  });
}

function sweep(w: ActivationWorld, at: string) {
  return runEmploymentActivations(w.db, cmd(), { tenantId: w.session.tenant.id }, { clock: () => new Date(at) }).then(
    (result) => result.runs[0]!,
  );
}

async function effectiveEvents(w: ActivationWorld, businessId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const [row] = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM employment_state_events
        WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid AND state='effective'`),
    );
    return Number(row?.n);
  });
}

describe.runIf(realPostgres)('R1-T08 真 PostgreSQL 强制交错', () => {
  it('多实例：实例一持员工锁生效到一半，实例二跳过该员工；放行后只生效一次', async () => {
    const w = await activationWorld(testDb().db, 'trf-pg-instances');
    const { employee } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const [first, second] = await withBusinessBarrier(w, approved.id, async () => {
      const one = sweep(w, '2026-10-04T17:15:00Z');
      await waitForBlocked(w.db, 1);
      const two = await sweep(w, '2026-10-04T17:15:01Z');
      expect(await lockWaiters(w.db)).toBe(1);
      return [one, two] as const;
    });
    expect(second).toMatchObject({ activated: [], skippedLocked: 1 });
    expect(await first).toMatchObject({ activated: [approved.id], skippedLocked: 0 });
    expect(await effectiveEvents(w, approved.id)).toBe(1);
    expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(2);
    expect((await sweep(w, '2026-10-04T17:20:00Z')).activated).toEqual([]);
  });

  it('两次 HR 重试排队在同一员工锁上：一次生效，另一次 409，不重复生效', async () => {
    const w = await activationWorld(testDb().db, 'trf-pg-retry');
    const { employee } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    fullDepartments.add(w.to.id);
    expect((await sweep(w, '2026-10-04T17:15:00Z')).failed).toEqual([approved.id]);
    fullDepartments.delete(w.to.id);
    const failed = await w.business(approved.id);
    w.session.setNow('2026-10-05T02:00:00Z');
    const retry = () =>
      w.session.request('POST', `/businesses/${approved.id}/activation/retry`, { ifMatch: failed.revision, body: {} });
    const responses = await withBusinessBarrier(w, approved.id, async () => {
      const one = retry();
      await waitForBlocked(w.db, 1);
      const two = retry();
      await waitForBlocked(w.db, 2);
      return [one, two];
    });
    const statuses = (await Promise.all(responses)).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await effectiveEvents(w, approved.id)).toBe(1);
    expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(2);
  });

  async function suspendedScene(label: string) {
    const w = await activationWorld(testDb().db, label);
    const { employee, hire } = await w.hired();
    const a = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const b = await w.approve(await w.apply(employee.id, '2026-10-10', { place: 'B 地点' }), '2026-10-02T03:00:00Z');
    fullDepartments.add(w.to.id);
    expect((await sweep(w, '2026-10-04T17:15:00Z')).failed).toEqual([a.id]);
    fullDepartments.delete(w.to.id);
    w.session.setNow('2026-10-10T02:00:00Z');
    const failed = await w.business(a.id);
    const retry = () =>
      w.session.request('POST', `/businesses/${a.id}/activation/retry`, { ifMatch: failed.revision, body: {} });
    return { w, employee, hire, a, b, retry };
  }

  it('DEC-112：定时任务先记 B 挂起，排队的重试随后让 A、B 依次生效', async () => {
    const { w, employee, hire, a, b, retry } = await suspendedScene('trf-pg-suspend-first');
    // 屏障锁 B：定时任务持员工锁、记挂起时阻塞在 B 的头行上；重试排队等员工锁。
    const [run, retried] = await withBusinessBarrier(w, b.id, async () => {
      const scheduled = sweep(w, '2026-10-09T17:15:00Z');
      await waitForBlocked(w.db, 1);
      const queued = retry();
      await waitForBlocked(w.db, 2);
      return [scheduled, queued] as const;
    });
    expect(await run).toMatchObject({ suspended: [b.id], activated: [] });
    expect((await retried).status).toBe(200);
    const chain = await w.session.records(employee.id, '2026-10-10');
    expect(chain.map((record) => record.id)).toEqual([hire.record!.id, a.id, b.id]);
    expect(await w.business(b.id)).toMatchObject({ status: 'effective', record: { previousRecordId: a.id } });
  });

  it('DEC-112 反向交错：重试持员工锁时定时任务跳过该员工，B 由重试紧接着生效', async () => {
    const { w, employee, hire, a, b, retry } = await suspendedScene('trf-pg-retry-first');
    // 屏障锁 A：重试持员工锁后阻塞在 A 的头行上；定时任务对该员工 SKIP LOCKED，不记挂起、不越过 A 生效 B。
    const [retried, run] = await withBusinessBarrier(w, a.id, async () => {
      const queued = retry();
      await waitForBlocked(w.db, 1);
      const scheduled = await sweep(w, '2026-10-09T17:15:00Z');
      return [queued, scheduled] as const;
    });
    expect(run).toMatchObject({ activated: [], suspended: [], skippedLocked: 1 });
    expect((await retried).status).toBe(200);
    const chain = await w.session.records(employee.id, '2026-10-10');
    expect(chain.map((record) => record.id)).toEqual([hire.record!.id, a.id, b.id]);
    expect((await w.business(b.id)).activation).toMatchObject({ status: 'effective', failureCount: 0 });
  });
});
