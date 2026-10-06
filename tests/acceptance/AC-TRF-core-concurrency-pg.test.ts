/** PR-A 真 PostgreSQL 强制交错：员工 → 业务 → 实例（F-008）；只在真 PG 上逐个观察锁等待后放行。 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import type { EmploymentBusiness } from './AC-EMP-support.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

async function waitForBlocked(db: Db, expected: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row?.n === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

describe.runIf(realPostgres)('AC-TRF 核心真 PG 交错', () => {
  it('同员工两笔调动在员工行排队，同 revision 只有第一笔成功，链和审计只追加一次', async () => {
    const w = await activationWorld(testDb().db, 'trf-core-pg-two');
    const { employee, hire } = await w.hired();
    const requests = await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      const rows = await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.session.tenant.id} AND id=${employee.id}::uuid FOR UPDATE`);
      expect(rowsOf(rows)).toHaveLength(1);
      const request = (place: string) =>
        w.session.request('POST', `/employees/${employee.id}/businesses`, {
          ifMatch: hire.employeeRevision,
          body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place } },
        });
      const first = request('先排队调动');
      await waitForBlocked(w.db, 1);
      const second = request('后排队调动');
      await waitForBlocked(w.db, 2);
      return [first, second];
    });
    const [first, second] = await Promise.all(requests);
    expect(first!.status).toBe(201);
    expect(second!.status).toBe(409);
    expect(await second!.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const saved = (await first!.json()) as EmploymentBusiness;
    expect((await w.session.records(employee.id)).map((record) => record.id)).toEqual([hire.id, saved.id]);
    expect((await w.auditEvents(saved.id)).filter((event) => event.action === 'employment.record.create')).toHaveLength(
      1,
    );
  });

  it('定时生效持员工锁时新调动排队；放行后旧 revision 拒绝，显式刷新重提得到完整链', async () => {
    const w = await activationWorld(testDb().db, 'trf-core-pg-scheduler-first');
    const { employee, hire } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    w.session.setNow('2026-10-05T02:00:00Z');
    const revision = (await w.session.getEmployee(employee.id)).revision;
    const body = { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { place: '之后调动' } };
    const [scheduled, direct] = await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      const rows = await barrier.execute(sql`SELECT id FROM employment_business_objects
        WHERE tenant_id=${w.session.tenant.id} AND id=${approved.id}::uuid FOR UPDATE`);
      expect(rowsOf(rows)).toHaveLength(1);
      const scheduler = w.runScheduler('2026-10-05T02:00:00Z');
      await waitForBlocked(w.db, 1);
      const create = w.session.request('POST', `/employees/${employee.id}/businesses`, { ifMatch: revision, body });
      await waitForBlocked(w.db, 2);
      return [scheduler, create] as const;
    });
    expect(await scheduled).toMatchObject({ activated: [approved.id], failed: [] });
    expect((await direct).status).toBe(409);
    const saved = await w.session.business(employee.id, body, (await w.session.getEmployee(employee.id)).revision);
    expect((await w.session.records(employee.id, '2026-10-05')).map((record) => record.id)).toEqual([
      hire.id,
      approved.id,
      saved.id,
    ]);
    expect((await w.runScheduler('2026-10-05T02:10:00Z')).activated).toEqual([]);
  });

  it('直接转正持员工锁时调度跳过；下轮落地较早申请并插入直接转正之前，不重复生效', async () => {
    const w = await activationWorld(testDb().db, 'trf-core-pg-direct-first');
    const { employee, hire } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    w.session.setNow('2026-10-05T02:00:00Z');
    const revision = (await w.session.getEmployee(employee.id)).revision;
    const [request, scheduled] = await w.db.transaction(async (barrier) => {
      // SHARE 允许调度读取候选，阻塞直接转正持员工锁后的业务 INSERT。
      await barrier.execute(sql`LOCK TABLE employment_business_objects IN SHARE MODE`);
      const direct = w.session.request('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: revision,
        body: {
          kind: 'regularization',
          mode: 'direct',
          effectiveDate: '2026-10-05',
          fields: { place: '直接转正地点' },
        },
      });
      await waitForBlocked(w.db, 1);
      const run = await w.runScheduler('2026-10-05T02:00:00Z');
      return [direct, run] as const;
    });
    expect(scheduled).toMatchObject({ activated: [], skippedLocked: 1 });
    const response = await request;
    expect(response.status).toBe(201);
    const direct = (await response.json()) as EmploymentBusiness;
    expect((await w.runScheduler('2026-10-05T02:10:00Z')).activated).toEqual([approved.id]);
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id)).toEqual([hire.id, approved.id, direct.id]);
    expect(records.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: direct.id })]);
    expect(
      (await w.auditEvents(approved.id)).filter((event) => event.action === 'employment.record.create'),
    ).toHaveLength(1);
  });
});
