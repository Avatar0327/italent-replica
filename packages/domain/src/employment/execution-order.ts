/**
 * 待生效业务的执行顺序单一入口（docs/08_设计/R2-T03_离职管理设计.md §5.0 / §5.0A，DEC-496④）。
 * 排序与“迟到后实际写入哪一天”曾用过两套日期（第 5 轮 P2-01）；这里只有一个最终执行日期与一个同日先后规则，
 * 日期判定只调用 late-execution.ts 既有函数，不另写。SQL 镜像见 apps/api employment/activation-store.ts
 * `finalExecutionDateSql`，等价性由验收测试断言。日期一律是租户业务日（YYYY-MM-DD），比较即字典序。
 *
 * 计划生效日（§5.0A）只有一个来源：main 的 SQL `timeline.ts plannedEffectiveDate` 读载荷版本的人工计划列
 * （F-140 约束 1 / 2，DEC-499，迁移 0130），纯函数镜像是同包 planned-date.ts 的 `resolvePlannedEffectiveDate`；
 * 本文件的 `plannedEffectiveDate` 入参一律传它们的结果，不再有第二种日期来源。
 */
import { addDays } from '../contracts/rules.js';
import { resolveLateExecution, resolveLateLeave } from './late-execution.js';

/** 任职业务类型；与 apps/api employment/types.ts 的 `BusinessKind` 同一集合（调用处按类型互相赋值，漂移即编译失败）。 */
export const EXECUTION_KINDS = [
  'hire',
  'rehire',
  'retire_rehire',
  'regularization',
  'transfer',
  'org_adjustment',
  'leave',
  'retirement',
  'intern_regularization',
] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/** 开新任职周期的 kind：同日排在其余业务之后（DEC-077 保留部分，契约 C-3 ③）。 */
export const CYCLE_OPENING_KINDS: readonly ExecutionKind[] = ['hire', 'rehire', 'retire_rehire'];

export interface FinalExecutionInput {
  readonly kind: ExecutionKind;
  /** §5.0A 的计划生效日（调动为载荷日，离职为最后工作日 + 1）。 */
  readonly plannedEffectiveDate: string;
  /** 离职的最后工作日；缺省时按计划日 − 1 推出，其他 kind 忽略。 */
  readonly lastWorkDate: string | null;
  /** 执行日 a：命令事务开始时的租户日期，审批、调度、重试相同。 */
  readonly executionDate: string;
}

/**
 * 该业务若在执行日 a 落地，实际写入的生效日。
 * transfer → max(计划日, a)（DEC-186 / 195②）；leave / retirement → max(L + 1, a)（DEC-263① / 272，退休见 DEC-638 A-15）；
 * 其余 kind 按原生效日落地、不顺延。
 */
export function finalExecutionDate(input: FinalExecutionInput): string {
  switch (input.kind) {
    case 'transfer':
      return resolveLateExecution({
        plannedEffectiveDate: input.plannedEffectiveDate,
        executionDate: input.executionDate,
      }).effectiveDate;
    case 'leave':
    case 'retirement':
      // 退休沿用离职的迟到顺延（R2-T04 §4.2，DEC-638 A-15）：同为终止业务、同一编排器
      return resolveLateLeave({
        lastWorkDate: input.lastWorkDate ?? addDays(input.plannedEffectiveDate, -1),
        executionDate: input.executionDate,
      }).effectiveDate;
    default:
      return input.plannedEffectiveDate;
  }
}

export interface ExecutionKey {
  readonly finalDate: string;
  /** §5.0A 的计划生效日。 */
  readonly plannedDate: string;
  readonly opensCycle: boolean;
  /**
   * 操作序号（DEC-108）：申请取最近一次提交事件，直接业务取保存事件（timeline.ts `operationKey`）。
   * 正在落地、尚无序号的直接业务视为最新（null 排最后，与 SQL ORDER BY 默认的 NULLS LAST 一致）。
   */
  readonly operationKey: number | null;
}

const compareValue = <T extends string | number>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** 契约 C-3 唯一规则：① 最终执行日期 → ② 计划生效日 → ③ 开新周期的 kind 排后 → ④ 操作序号。 */
export function compareExecutionOrder(a: ExecutionKey, b: ExecutionKey): number {
  return (
    compareValue(a.finalDate, b.finalDate) ||
    compareValue(a.plannedDate, b.plannedDate) ||
    compareValue(Number(a.opensCycle), Number(b.opensCycle)) ||
    compareOperation(a.operationKey, b.operationKey)
  );
}

function compareOperation(a: number | null, b: number | null): number {
  if (a === null || b === null) return compareValue(Number(a === null), Number(b === null));
  return compareValue(a, b);
}
