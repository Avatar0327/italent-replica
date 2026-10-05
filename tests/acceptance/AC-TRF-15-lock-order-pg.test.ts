/** F-008：两笔调动互选新增下属，按同一组员工 UUID 取锁，不能在源员工锁后反向等待。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
async function waitForBoth(db: Db) {
  for (let i = 0; i < 200; i++) {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%employment_employees%'`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    if (rows[0]!.n >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('两笔调动没有同时进入员工锁等待');
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TRF-15 / F-008 真实 PG 锁顺序', () => {
  it('相反的新增下属选择串行完成，循环汇报拒绝且不死锁', async () => {
    const w = await activationWorld(database().db, 'link-lock-pg');
    const people = [await w.hired('交错甲'), await w.hired('交错乙')].sort((a, b) =>
      a.employee.id.localeCompare(b.employee.id),
    );
    let pending: Promise<Response>[] = [];
    await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.session.tenant.id} AND id=${people[0]!.employee.id}::uuid FOR UPDATE`);
      pending = people.map((person, index) =>
        w.session.request('POST', `/employees/${person.employee.id}/businesses`, {
          ifMatch: person.hire.employeeRevision,
          idempotencyKey: randomUUID(),
          body: {
            kind: 'transfer',
            mode: 'direct',
            effectiveDate: '2026-10-01',
            fields: { departmentId: w.to.id, addedSubordinateIds: [people[1 - index]!.employee.id] },
          },
        }),
      );
      await waitForBoth(w.db);
    });
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    // 胜出者更新另一人的任职和 revision；失败者必须刷新后重提，不能盲重试。
    const failure = responses.find((r) => r.status === 409)!;
    expect(await failure.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  });
});
