/**
 * BE-7 PT-3c 真 PostgreSQL 交错（docs/08_设计/R2-T05_兼职设计.md §7.1 / §7.5 ⑥，§4.4 批量结束）。PGlite 单连接无法并发，
 * 只在设了 TEST_DATABASE_URL 时运行：批量结束与单条编辑同一兼职 —— 后到者在员工行锁上真实等待，先到者提交后锁内比对
 * revision 失败，恰一方成功、失败方整批无写入；两个批量结束以相反条目顺序交错也不死锁（同一员工两条记录，以及跨两名员工，F-235②）。
 */
import type * as Crypto from 'node:crypto';
import { withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { batchEndPartTimes, editPartTime } from '../../apps/api/src/modules/employment/part-time/service.js';
import { readPartTimeRecords } from '../../apps/api/src/modules/employment/part-time/store.js';
import { httpWorld } from './AC-PT-http-support.js';
import { waitForBlocked, withHeldLock } from './support/pg-interleave.js';
import { orderedEmployeePair } from './support/ordered-employee-pair.js';

// F-334：仅在造兼职记录期间固定前缀，保留其余随机位，保证读取顺序与员工锁序相反。
const uuidPrefix = vi.hoisted(() => ({ value: '' }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>();
  return {
    ...actual,
    randomUUID: () => {
      const id = actual.randomUUID();
      return uuidPrefix.value ? uuidPrefix.value + id.slice(8) : id;
    },
  };
});

const database = useTestDb();

const endDate = '2026-12-31';

/** 租户事务里执行 take 后停在提交之前，直到 withHeldLock 放行；take 失败（含死锁）会让 withHeldLock 直接抛出。 */
const holding = (
  w: { db: Db; tenantId: string },
  take: (tx: Tx) => Promise<unknown>,
  afterRelease?: (tx: Tx) => Promise<void>,
) => ({ run: <R>(fn: (tx: Tx) => Promise<R>) => withTenant(w.db, w.tenantId, fn), take, afterRelease });

async function setup(label: string) {
  const w = await httpWorld(database().db, label);
  const a = await w.make({ endDate: '2026-12-31' });
  const b = await w.make({ startDate: '2026-09-10', endDate: '2026-12-31' });
  const items = [a, b].map((record) => ({ recordId: record.id, revision: record.revision }));
  return { w, a, b, items };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-PT-batch-pg 批量结束 vs 单条编辑真 PG 交错', () => {
  it('编辑先持锁、批量结束（旧 revision）后到：等员工行锁，编辑提交后锁内比对失败 → 409，整批无写入', async () => {
    const { w, a, b, items } = await setup('batch-pg-edit-first');
    const { batch } = await withHeldLock(
      holding(w, (tx) => editPartTime(tx, w.context(a.revision), a.id, { endDate: '2026-10-20' })),
      async (lock) => {
        const pending = lock.track(w.batchEnd(items, '2026-10-15'));
        await waitForBlocked(w.db, 1);
        return { batch: pending };
      },
    );
    const response = await batch;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'REVISION_CONFLICT', details: { items: [{ recordId: a.id, expected: 1, actual: 2 }] } },
    });
    expect((await w.terms(a.id)).map((term) => term.source)).toEqual(['create', 'edit']);
    expect(await w.terms(b.id)).toHaveLength(1);
  });

  it('批量结束先持锁、单条编辑（旧 revision）后到：编辑 409，只有批量一方写入', async () => {
    const { w, a, b, items } = await setup('batch-pg-batch-first');
    const { edit } = await withHeldLock(
      holding(w, (tx) => batchEndPartTimes(tx, w.context(), { items, endDate: '2026-10-15' })),
      async (lock) => {
        const pending = lock.track(w.edit(a.id, { endDate: '2026-10-10' }, a.revision));
        await waitForBlocked(w.db, 1);
        return { edit: pending };
      },
    );
    const response = await edit;
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    expect((await w.terms(a.id)).map((term) => term.source)).toEqual(['create', 'batch_end']);
    expect((await w.terms(b.id)).map((term) => term.source)).toEqual(['create', 'batch_end']);
  });

  it('两个批量结束以相反条目顺序交错：不死锁，后到者 409，用新 revision 重提成功', async () => {
    const { w, a, b, items } = await setup('batch-pg-opposite-order');
    const { second } = await withHeldLock(
      holding(w, (tx) => batchEndPartTimes(tx, w.context(), { items, endDate: '2026-10-15' })),
      async (lock) => {
        const pending = lock.track(w.batchEnd([...items].reverse(), '2026-10-10'));
        await waitForBlocked(w.db, 1);
        return { second: pending };
      },
    );
    expect((await second).status).toBe(409);
    const fresh = [a, b].map((record) => ({ recordId: record.id, revision: 2 }));
    expect((await w.batchEnd(fresh.reverse(), '2026-10-10')).status).toBe(200);
    expect((await w.terms(b.id)).map((term) => term.end_date)).toEqual(['2026-12-31', '2026-10-15', '2026-10-10']);
  });

  /**
   * F-235②：员工锁序只有跨员工才有区分力 —— 同一员工的两条记录只有一把员工锁，排序改坏也不会死锁。
   * 第一个连接先锁住 UUID 较小的员工 A，第二个批量结束按“较大员工的记录在前”的相反顺序到达（夹具保证读取顺序也是员工降序）：
   * 按序加锁时它在 A 上空手等待；若改成按请求顺序加锁，它会先持较大员工的锁再等 A，第一个连接随后要锁较大员工 → 死锁（40P01）。
   */
  it('两个批量结束跨两名员工、相反顺序交错：首个员工锁后交错，无 40P01，后到者 409 REVISION_CONFLICT', async () => {
    const w = await httpWorld(database().db, 'batch-pg-cross-employee');
    const { worker, subordinate } = await orderedEmployeePair(
      await w.getEmployee(w.employeeId),
      () => w.colleague('跨员工兼职'),
      (person) => person.id,
      'above',
    );
    const [lowEmployee, highEmployee] = [worker.id, subordinate.id];
    const make = async (employeeId: string, prefix: string) => {
      uuidPrefix.value = prefix;
      try {
        return await w.create({ employeeId, endDate });
      } finally {
        uuidPrefix.value = '';
      }
    };
    // partTimeRows 按记录 ID 升序读取：大员工对应小记录，恰好反转员工锁序，无需重试。
    const low = await make(lowEmployee, 'eeeeeeee');
    const high = await make(highEmployee, '11111111');
    expect(lowEmployee < highEmployee && high.id < low.id).toBe(true);
    // 前提：本请求的真实读取结果按员工 UUID 降序（读取顺序 ≠ 锁序），“仅删 .sort()”才会改变加锁顺序
    const readOrder = await withTenant(w.db, w.tenantId, async (tx) =>
      (await readPartTimeRecords(tx, w.context(), [low.id, high.id])).map((row) => row.employeeId),
    );
    expect(readOrder).toEqual([highEmployee, lowEmployee]);
    const item = (record: { id: string; revision: number }) => ({ recordId: record.id, revision: record.revision });
    // 首个连接若被死锁（40P01），其错误由 withHeldLock 抛出，用例判红
    const { second } = await withHeldLock(
      holding(
        w,
        (tx) => lockEmploymentEmployee(tx, w.context(), low.employeeId),
        async (tx) => {
          await batchEndPartTimes(tx, w.context(), { items: [item(low), item(high)], endDate: '2026-10-15' });
        },
      ),
      async (lock) => {
        const pending = lock.track(w.batchEnd([item(high), item(low)], '2026-10-10'));
        await waitForBlocked(w.db, 1);
        return { second: pending };
      },
    );
    const response = await second;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'REVISION_CONFLICT',
        details: {
          items: expect.arrayContaining([
            { recordId: low.id, expected: 1, actual: 2 },
            { recordId: high.id, expected: 1, actual: 2 },
          ]),
        },
      },
    });
    for (const record of [low, high])
      expect((await w.terms(record.id)).map((term) => [term.end_date, term.source])).toEqual([
        ['2026-12-31', 'create'],
        ['2026-10-15', 'batch_end'],
      ]);
  });
});
