/**
 * F-350（DEC-052、F-336 收尾）：交接补发的异常分支，同因连续失败不再逐轮追加回执；失败原因变化时仍记新回执，
 * 成功回执照常办结。F-336 只给 NO_INITIATOR_ACCOUNT 去重，其余原因（失败结果与抛错）每轮都在追加。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as handovers from '../../apps/api/src/modules/employment/exit-handover.js';
import { AppError, type ErrorCode } from '../../apps/api/src/errors.js';
import { f310World, replacedSuccessor, retryReceipts, round } from './AC-EXIT-F310-support.js';

const database = useTestDb();
afterEach(() => vi.restoreAllMocks());

/** 补发的两种异常形态：返回失败结果（原因 = reason），抛业务拒绝（回执原因 = 错误码）。 */
const VARIANTS = {
  失败结果: {
    first: 'SERVICE_UNAVAILABLE',
    second: 'PROCESS_BUSY',
    fail: (reason: string) => ({ outcome: 'failed' as const, reason }),
  },
  抛出业务拒绝: {
    first: 'CONFLICT',
    second: 'FORBIDDEN',
    fail: (reason: string) => {
      throw new AppError(reason as ErrorCode, '合成补发拒绝');
    },
  },
};

const real = handovers.launchExitHandover;
/** 补发入口按“当前原因”失败（调度一轮内可能消费多次，所以不按次数脚本）；原因为空时放行真实补发。 */
function failing(fail: (reason: string) => { outcome: 'failed'; reason: string }) {
  const state: { reason: string | null } = { reason: null };
  vi.spyOn(handovers, 'launchExitHandover').mockImplementation(async (...args) =>
    state.reason ? fail(state.reason) : real(...args),
  );
  return state;
}

describe('F-350 补发异常分支的同因失败回执去重', () => {
  it.each(Object.entries(VARIANTS))(
    '%s：同因连续失败只记一条，换因再记，成功办结后不再追加',
    async (label, variant) => {
      const x = await f310World(database().db, `dedupe-${label}`);
      const { first, second, fail } = variant;
      // 账号在改期请求内恢复，补发立刻开始：首轮（请求内）加两轮调度同因失败
      const mode = failing(fail);
      mode.reason = first;
      const exitId = await replacedSuccessor(x, false);
      const counts = [(await retryReceipts(x, exitId)).length];
      for (const minute of [5, 10]) {
        await x.runScheduler(round(minute));
        counts.push((await retryReceipts(x, exitId)).length);
      }
      expect(counts, '同因失败只留一条回执').toEqual([1, 1, 1]);
      expect(await retryReceipts(x, exitId)).toEqual([{ state: 'failed', reason: first }]);
      // 原因变化：记新回执，次数递增
      mode.reason = second;
      await x.runScheduler(round(15));
      await x.runScheduler(round(20));
      expect(await retryReceipts(x, exitId)).toEqual([
        { state: 'failed', reason: first },
        { state: 'failed', reason: second },
      ]);
      // 原因变回旧原因，也是新的一次
      mode.reason = first;
      await x.runScheduler(round(25));
      expect(await retryReceipts(x, exitId)).toHaveLength(3);
      mode.reason = null;
      // 放行真实补发：成功办结，只多一条 sent；再调度不追加
      await x.runScheduler(round(30));
      const closed = await retryReceipts(x, exitId);
      expect(closed).toHaveLength(4);
      expect(closed.at(-1)).toEqual({ state: 'sent', reason: null });
      expect(await x.requestRows(exitId)).toEqual([expect.objectContaining({ state: 'in_progress' })]);
      await x.runScheduler(round(35));
      expect(await retryReceipts(x, exitId)).toEqual(closed);
    },
  );
});
