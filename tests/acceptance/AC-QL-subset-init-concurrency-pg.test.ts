/**
 * AC-QL-subset-init 真 PostgreSQL 交错（设计 §4.1，拆分方案 §5 C1-5）。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * - 同一员工两个批次同时初始化：先取员工锁者生成，后者等锁后看到已有行 → ALREADY_EXISTS，行数不重复；
 * - 两个批次员工顺序相反（[A, B] 与 [B, A]）同时跑：按员工 ID 升序取锁，不会互相等待成环（不死锁），各员工只生成一份。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { rowsOf, syncWorld } from './AC-QL-sync-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const PATH = '/api/tenant/qualification/subsets/initialize';
const CLOCK = () => new Date('2026-10-10T05:00:00Z');

interface Receipts {
  items: { employeeId: string; outcome: string; created?: number; records?: { outcome: string; reason?: string }[] }[];
}

async function waitForLockWaiters(db: Db, count: number, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('请求没有真实等待数据库锁');
    const [waiting] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (waiting!.n >= count) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到真实锁等待');
}

async function scene(label: string) {
  const w = await syncWorld(database().db, label);
  const sequenceId = await w.sequence('同步序列');
  const jobLevelId = await w.jobLevel();
  await w.category({ type: 'sequence', jobObjectId: sequenceId });
  await w.level({ type: 'level', jobObjectId: jobLevelId });
  await w.settleBaseline();
  const fields = { sequenceId, levelId: jobLevelId };
  const api = tenantApi(w.db, { clock: CLOCK });
  const init = async (employeeIds: string[]) => {
    const response = await api.request('POST', PATH, { ...w.as, body: { employeeIds }, idempotencyKey: randomUUID() });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Receipts;
  };
  return { w, fields, init };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-QL-subset-init 真 PG：并发批次', () => {
  it('同一员工两个批次同时初始化：员工锁串行，只生成一份，后到的看到 ALREADY_EXISTS（AC-QL-subset-init）', async () => {
    const { w, fields, init } = await scene('qlinit-pg-same');
    await w.transferWith('2026-09-10', fields);
    const employeeId = w.subject.employee.id;
    // 持员工锁，让两个批次都真实排队
    let release!: () => void;
    const hold = new Promise<void>((done) => {
      release = done;
    });
    let held!: () => void;
    const locked = new Promise<void>((done) => {
      held = done;
    });
    const holder = withTenant(w.db, w.tenantId, async (tx) => {
      await lockEmploymentEmployee(tx, w.context('2026-10-10T01:00:00Z'), employeeId);
      held();
      await hold;
    });
    await locked;
    let finished = false;
    const both = Promise.all([init([employeeId]), init([employeeId])]).then((value) => {
      finished = true;
      return value;
    });
    await waitForLockWaiters(w.db, 2, () => finished);
    release();
    await holder;
    const results = await both;
    const outcomes = results.flatMap((result) =>
      result.items[0]!.records!.map((record) => record.reason ?? record.outcome),
    );
    expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'ALREADY_EXISTS')).toHaveLength(1);
    expect(await w.subsets()).toHaveLength(1);
  });

  it('两个批次员工顺序相反同时跑：不死锁，每名员工只生成一份（AC-QL-subset-init）', async () => {
    const { w, fields, init } = await scene('qlinit-pg-order');
    const other = await w.session.employee('顺序对照员工');
    await w.session.business(
      other.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.from.id } },
      other.revision,
    );
    await w.transferWith('2026-09-10', fields);
    await w.transferWith('2026-09-10', fields, other.id);
    const a = w.subject.employee.id;
    const b = other.id;
    const [first, second] = await Promise.all([init([a, b]), init([b, a])]);
    expect(first.items.map((item) => item.employeeId)).toEqual([a, b]);
    expect(second.items.map((item) => item.employeeId)).toEqual([b, a]);
    const created = [...first.items, ...second.items].reduce((sum, item) => sum + (item.created ?? 0), 0);
    expect(created).toBe(2);
    expect(await w.subsets(a)).toHaveLength(1);
    expect(await w.subsets(b)).toHaveLength(1);
  });
});
