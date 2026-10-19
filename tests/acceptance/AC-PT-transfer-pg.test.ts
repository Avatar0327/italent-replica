/**
 * AC-PT-transfer-pg（BE-7 PT-6，docs/08_设计/R2-T05_兼职设计.md §4.7 / §7.1 / §7.5，§9 PB-54）：真 PostgreSQL 16、普通角色
 * （非超级用户、无 BYPASSRLS，租户表 FORCE RLS）下，结束申请的末节点同意落地 vs 调动联动结束同一兼职 —— 恰一方生效，
 * 另一方作废或幂等。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * - 调动先拿到员工行锁（未提交；F-270：先停在只持员工锁的屏障上断言审批方被阻塞）：末节点同意在适配器 lock 的员工行锁上真实等待；调动提交后申请已被作废（transfer），
 *   审批命令得到明确的业务错误，期限链只有调动追加的一期；
 * - 同意先落地：结束申请生效；之后调动联动结束发现当前结束日已不晚于失效日 → 幂等成功，不追加。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { transferPartTimePort } from '../../apps/api/src/modules/transfer/linkage/part-time.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
/** 并发败者不得是死锁 / 序列化失败 / 锁超时转出来的并发冲突码。 */
const CONCURRENT_CODES = /CONCURRENT|DEADLOCK|SERIALIZ|LOCK_TIMEOUT/;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 在租户事务里执行 work，停在提交之前直到 release；返回提交结果（成功 undefined，失败为错误）。 */
function holdThen(w: RequestWorld, work: Parameters<RequestWorld['run']>[0]) {
  const held = signal();
  const release = signal();
  const done = w
    .run(async (tx) => {
      await work(tx);
      held.resolve();
      await release.promise;
    })
    .then(
      () => undefined,
      (error: unknown) => {
        held.resolve();
        return error;
      },
    );
  return { held: held.promise, release: release.resolve, done };
}

/**
 * 调动联动执行里的端口调用：先取员工行锁（调用方职责，§7.1），再结束兼职。
 * afterEmployeeLock 在“只持员工锁”的时点执行（此时还没碰兼职记录头），供测试设屏障（F-270）。
 */
const transferEnd =
  (
    w: RequestWorld,
    recordId: string,
    endDate: string,
    itemId = randomUUID(),
    afterEmployeeLock?: () => Promise<void>,
  ) =>
  async (tx: Parameters<Parameters<RequestWorld['run']>[0]>[0]) => {
    const ctx = w.context();
    await lockEmploymentEmployee(tx, ctx, w.worker.employeeId);
    await afterEmployeeLock?.();
    await transferPartTimePort().end(tx, ctx, { employeeId: w.worker.employeeId, recordId, endDate, itemId });
  };

/** 建一张结束申请并推进到只差最后一个节点同意。 */
async function endRequestAtLastNode(w: RequestWorld, recordId: string, endDate: string) {
  const created = await w.end(recordId, endDate);
  await w.send(created.id, created.revision);
  await w.approveInOrder(created.id, w.order.end, 3);
  const view = await w.instance(created.id);
  const last = w.order.end[3]!;
  const task = w.pending(view).find((item) => item.assigneeUserId === last.userId)!;
  return { created, view, task, last };
}

describe.skipIf(!realPostgres)('AC-PT-transfer-pg 结束申请落地 vs 调动联动结束（真 PG、普通角色）', () => {
  it('PB-54：调动先持员工行锁 → 末节点同意在锁上等待；放行后申请已作废（transfer），期限只有调动追加的一期', async () => {
    const w = await requestWorld(database().db, 'pt6-pg-transfer-first');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const { created, view, task, last } = await endRequestAtLastNode(w, record, '2026-09-20');

    // F-270：先停在“只持员工行锁”（兼职记录头、申请头都还没被任何人持有），此时审批方被阻塞 = 等的就是员工锁；
    // 再放行到持有记录头的完整联动，审批方仍须阻塞。删掉审批适配器 lock 里的员工锁语句后，落地层会再次取员工锁，
    // 所以第一个屏障仍通过，整例在第二次 waitForBlocked 超时判红（#451 第 1 轮 P3）。
    // 失败时 finally 也放行屏障并等联动事务结束，避免挂起的事务拖垮清理钩子。
    const itemId = randomUUID();
    const employeeLocked = signal();
    const proceed = signal();
    const transfer = holdThen(
      w,
      transferEnd(w, record, '2026-09-30', itemId, async () => {
        employeeLocked.resolve();
        await proceed.promise;
      }),
    );
    let approve: ReturnType<typeof w.taskAction> | undefined;
    try {
      await employeeLocked.promise;
      approve = w.taskAction(last.userId, task.id, 'approve', view.revision, { comment: '合成意见' });
      await waitForBlocked(w.db, 1);
      proceed.resolve();
      await transfer.held;
      await waitForBlocked(w.db, 1);
    } finally {
      proceed.resolve();
      transfer.release();
    }
    expect(await transfer.done).toBeUndefined();

    const response = await approve!;
    expect(response.status, '申请已被联动作废，末节点同意不得再成功').toBeGreaterThanOrEqual(400);
    const failure = JSON.stringify(await response.json());
    expect(failure).not.toMatch(CONCURRENT_CODES);
    expect((await w.states(created.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'transfer' });
    expect((await w.detail(view.id)).status).toBe('cancelled');
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-09-30', source: 'transfer', source_id: itemId },
    ]);
  });

  it('PB-54：末节点同意先落地 → 申请生效；调动联动结束随后发现结束日已更早，幂等成功不追加', async () => {
    const w = await requestWorld(database().db, 'pt6-pg-approve-first');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const { created, last } = await endRequestAtLastNode(w, record, '2026-09-20');
    await w.decide(created.id, last, 'approve');
    expect((await w.states(created.id)).at(-1)).toMatchObject({ state: 'effective' });

    await w.run(transferEnd(w, record, '2026-09-30'));
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-09-20', source: 'end', source_id: created.id },
    ]);
  });

  it('PB-54：同意先落地、结束日晚于联动失效日 → 联动再追加一期缩短（链上两方都留痕，最终结束日 = 失效日）', async () => {
    const w = await requestWorld(database().db, 'pt6-pg-approve-then-shorten');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const { created, last } = await endRequestAtLastNode(w, record, '2026-09-28');
    await w.decide(created.id, last, 'approve');
    const itemId = randomUUID();
    await w.run(transferEnd(w, record, '2026-09-20', itemId));
    expect((await w.terms(record)).map((term) => [term.end_date, term.source])).toEqual([
      ['2026-10-31', 'create'],
      ['2026-09-28', 'end'],
      ['2026-09-20', 'transfer'],
    ]);
  });
});
