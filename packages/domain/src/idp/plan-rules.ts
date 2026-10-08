/**
 * 发展计划执行规则（纯函数，docs/02_业务建模/28 §2.1 / §2.3；Q-M0-115①②；DEC-296⑤ / DEC-056）。
 */
import { addDays } from '../contracts/rules.js';
import { AUTO_START_HOUR, IMPROVING_STAGE_NAME, type PlanStatus, type StageStatus } from './catalog.js';
import type { StartRule } from './rules.js';

/** 计算阶段到期日所需的参照日期（未知为 null）。 */
export interface ReferenceDates {
  readonly planStart: string;
  readonly planEnd: string;
  /** 上一阶段的结束日（租户业务日）；第一段或上一段未结束为 null。 */
  readonly previousEnd: string | null;
  /** 员工最新一条已生效主职任职记录的生效日（🟡 K-07）。 */
  readonly employmentEffective: string | null;
}

/**
 * 自动开启阶段的到期日（IDP-R2）：手动开启没有到期日；无规则 = 第一段计划开始日、之后各段上一阶段结束日（K-06，
 * 由结束时直接开启，到期日仅作展示）；固定时间 = 固定日期；相对时间 = 参照日 ± N 天。参照日未知时为 null。
 */
export function stageDueDate(rule: StartRule, index: number, refs: ReferenceDates): string | null {
  if (rule.startMode === 'manual') return null;
  if (rule.startTimeType === null) return index === 0 ? refs.planStart : refs.previousEnd;
  if (rule.startTimeType === 'fixed') return rule.fixedDate;
  const base = {
    plan_start: refs.planStart,
    plan_end: refs.planEnd,
    previous_end: refs.previousEnd,
    employment_effective: refs.employmentEffective,
  }[rule.referencePoint!];
  if (!base) return null;
  if (rule.startFrom === 'same_day') return base;
  return addDays(base, rule.startFrom === 'before' ? -rule.days! : rule.days!);
}

/**
 * 调度在某一瞬时可以开启的最晚到期日（DEC-296⑤：租户时区凌晨 2 点开启）：本地时间已过 2 点时为今天，否则为昨天。
 * @param local 租户本地的日期与小时
 */
export function autoStartCutoff(local: { readonly date: string; readonly hour: number }): string {
  return local.hour >= AUTO_START_HOUR ? local.date : addDays(local.date, -1);
}

/** 计划区间与记录区间（含两端，结束为空 = 至今）是否有交集（IDP-R7，AC-IDP-07）。 */
export function periodsIntersect(
  plan: { readonly startDate: string; readonly endDate: string },
  record: { readonly startDate: string; readonly endDate: string | null },
): boolean {
  return record.startDate <= plan.endDate && (record.endDate === null || record.endDate >= plan.startDate);
}

export interface StageState {
  readonly name: string;
  readonly status: StageStatus;
}

/**
 * 当前阶段的显示值（IDP-R4，🟡 K-03）：进行中的计划取运行中的阶段名；没有运行中的阶段但仍有未结束的阶段时为
 * “努力提升中”；未开始、已结束、已终止的计划为空。
 */
export function currentStageName(status: PlanStatus, stages: readonly StageState[]): string | null {
  if (status !== 'running') return null;
  const running = stages.find((stage) => stage.status === 'running');
  if (running) return running.name;
  return stages.some((stage) => stage.status === 'pending' || stage.status === 'failed') ? IMPROVING_STAGE_NAME : null;
}

/** 下一个待开启的阶段（按顺序第一个“待开启 / 开启失败”的），没有则为 undefined。 */
export function nextOpenableStage<T extends StageState & { readonly seq: number }>(
  stages: readonly T[],
): T | undefined {
  return [...stages].sort((a, b) => a.seq - b.seq).find((s) => s.status === 'pending' || s.status === 'failed');
}
