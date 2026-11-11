/**
 * 计算 run 的对外入口：enqueueCalcRun / changeCalcRun / runCalcPageInTransaction 原样再导出，
 * runCalcPage 在执行内核（calc-runner）上注入默认登记表 SUCCESSION_CALC_KINDS（F-512 拆分原因见 calc-runner.ts 头注释）。
 */
import type { Db } from '@italent/db';
import { SUCCESSION_CALC_KINDS } from './calc-contract.js';
import type { CalcHandler, CalcRun } from './calc-contract-core.js';
import { runCalcPageWith } from './calc-runner.js';

export { enqueueCalcRun } from './calc-enqueue.js';
export { changeCalcRun, runCalcPageInTransaction } from './calc-runner.js';

/** 一次调用最多提交一页；返回 running 时调用方继续调本函数。崩溃回滚当前页，已提交对象不再执行。
 * 页事务结果未知时，独立事务重新取 run 锁并检查 revision；已提交/另一 worker 已推进时不覆盖结果。 */
export function runCalcPage(
  db: Db,
  tenant: string,
  id: string,
  handlers: readonly CalcHandler[] = SUCCESSION_CALC_KINDS,
  now = new Date(),
): Promise<CalcRun['status']> {
  return runCalcPageWith(db, tenant, id, handlers, now);
}
