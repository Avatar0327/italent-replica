/**
 * BE-7 PT-1 兼职数据层的真 PostgreSQL 交错（docs/08_设计/R2-T05_兼职设计.md §1.1 / §1.2，§13.3 PT-1 行）。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行：
 * - 同一兼职记录两个事务同时追加同一期号：后到者在唯一索引上真实等待，先到者提交后失败（23505），期限链不分叉；
 * - 持员工行锁写主职业务时插兼职记录：兼职事务在员工行锁上真实等待（外键检查 / 提交时的覆盖触发器），放行后两边都成功，
 *   覆盖触发器只数主职记录，主职链与插入前逐项相等（PB-01 的并发版本）。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { failure, partTimeWorld, type PartTimeWorld } from './AC-PT-support.js';

const database = useTestDb();

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForLock(w: PartTimeWorld, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('第二个事务没有真实等待数据库锁');
    const [waiting] = rowsOf<{ n: number }>(
      await w.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`),
    );
    if (waiting!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到真实锁等待');
}

/** 在租户事务里执行 work，停在提交之前，直到 release；返回提交结果（失败为错误文本）。 */
function holdThen(w: PartTimeWorld, work: (tx: Tx) => Promise<unknown>) {
  const held = signal();
  const release = signal();
  const done = withTenant(w.db, w.tenantId, async (tx) => {
    await work(tx);
    held.resolve();
    await release.promise;
  }).then(
    () => undefined,
    (error: unknown) => {
      held.resolve();
      return failure(error);
    },
  );
  return { held: held.promise, release: release.resolve, done };
}

async function terms(w: PartTimeWorld, recordId: string) {
  return withTenant(w.db, w.tenantId, async (tx) =>
    rowsOf<{ term_no: number; end_date: string | null; source: string }>(
      await tx.execute(sql`SELECT term_no, end_date::text, source FROM employment_part_time_terms
        WHERE tenant_id = ${w.tenantId} AND record_id = ${recordId} ORDER BY term_no`),
    ),
  );
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-PT-schema-pg BE-7 PT-1 真 PG：兼职数据层交错', () => {
  it('同一兼职记录并发追加同一期号：后到者在唯一索引上等待，先到者提交后失败 23505，期限链不分叉', async () => {
    const w = await partTimeWorld(database().db, 'pg-term');
    let recordId = '';
    expect(
      await w.attempt(async (tx) => {
        recordId = await w.insertPartTime(tx);
        await tx.execute(w.term(recordId, 1, '2026-12-31', 'create'));
      }),
    ).toBeUndefined();
    const first = holdThen(w, (tx) => tx.execute(w.term(recordId, 2, '2026-10-15', 'end')));
    await first.held;
    let finished = false;
    const second = w
      .attempt((tx) => tx.execute(w.term(recordId, 2, '2027-03-31', 'extend')))
      .then((result) => {
        finished = true;
        return result;
      });
    await waitForLock(w, () => finished);
    first.release();
    expect(await first.done).toBeUndefined();
    expect(await second).toMatch(/^23505 .*employment_part_time_terms_record_term/);
    expect(await terms(w, recordId)).toEqual([
      { term_no: 1, end_date: '2026-12-31', source: 'create' },
      { term_no: 2, end_date: '2026-10-15', source: 'end' },
    ]);
  });

  it('持员工行锁写主职时插兼职记录：兼职事务在员工锁上等待，放行后两边都成功、主职链不变', async () => {
    const w = await partTimeWorld(database().db, 'pg-coverage');
    const before = await w.primaryView();
    // 主职侧：先持员工行锁（与任职写入口同一把锁），停在提交前
    const primary = holdThen(w, (tx) =>
      tx.execute(sql`SELECT 1 FROM employment_employees
        WHERE tenant_id = ${w.tenantId} AND id = ${w.employeeId} FOR UPDATE`),
    );
    await primary.held;
    let finished = false;
    let recordId = '';
    const partTime = w
      .attempt(async (tx) => {
        recordId = await w.insertPartTime(tx);
        await tx.execute(w.term(recordId, 1, null, 'create'));
      })
      .then((result) => {
        finished = true;
        return result;
      });
    await waitForLock(w, () => finished);
    primary.release();
    expect(await primary.done).toBeUndefined();
    expect(await partTime).toBeUndefined();
    expect(await w.primaryView()).toEqual(before);
    expect(await terms(w, recordId)).toEqual([{ term_no: 1, end_date: null, source: 'create' }]);
  });
});
