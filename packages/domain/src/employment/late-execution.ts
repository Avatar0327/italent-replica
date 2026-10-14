/**
 * 迟到判定的唯一实现（DEC-272；DEC-186 / DEC-195② 的调动口径，DEC-263① 经 DEC-272 澄清的离职口径）。
 * #83 F-007 与 #100 R2-T03 共用：只有实际执行日晚于原定生效日才算迟到，原定生效日当天执行属正常、不顺延。
 * SQL 侧的投影 `greatest(effective_date, 执行日)`（activation-store.ts / forward-update.ts）与本函数同义，
 * 验收测试断言两者等价。日期一律是租户业务日（YYYY-MM-DD），比较即字典序。
 */
import { addDays } from '../contracts/rules.js';

export interface LateExecutionInput {
  /** 原定生效日：调动为载荷生效日，离职为最后工作日 + 1。 */
  readonly plannedEffectiveDate: string;
  /** 实际执行日（租户业务日）：定时调度、HR 重试或审批通过落地的当天。 */
  readonly executionDate: string;
}

export interface LateExecution {
  readonly late: boolean;
  /** 迟到时为实际执行日，否则为原定生效日。 */
  readonly effectiveDate: string;
}

export function resolveLateExecution(input: LateExecutionInput): LateExecution {
  const late = input.executionDate > input.plannedEffectiveDate;
  return { late, effectiveDate: late ? input.executionDate : input.plannedEffectiveDate };
}

export interface LateLeaveInput {
  readonly lastWorkDate: string;
  readonly executionDate: string;
}

export interface LateLeave extends LateExecution {
  /** 迟到时改为实际执行日前一天，否则保持原最后工作日。 */
  readonly lastWorkDate: string;
}

/** 离职生效日 = 最后工作日次日；迟到时最后工作日 = 实际执行日 − 1、生效日 = 实际执行日（DEC-272 例：5 日 / 6 日 / 7 日）。 */
export function resolveLateLeave(input: LateLeaveInput): LateLeave {
  const resolved = resolveLateExecution({
    plannedEffectiveDate: addDays(input.lastWorkDate, 1),
    executionDate: input.executionDate,
  });
  return { ...resolved, lastWorkDate: resolved.late ? addDays(input.executionDate, -1) : input.lastWorkDate };
}
