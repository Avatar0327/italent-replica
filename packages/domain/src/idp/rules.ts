/**
 * IDP 配置规则（纯函数，docs/02_业务建模/28 §2.1、§2.2；Q-M0-115 ②④；DEC-296④⑤）。
 */
import {
  AUTO_START_HOUR,
  CONTENT_NODE_BUTTONS,
  GOAL_NODE_BUTTONS,
  type ModuleType,
  type NodeButton,
  type ReferencePoint,
  type StartFrom,
  type StartMode,
  type StartTimeType,
} from './catalog.js';

/** 一个流程最多的子流程段数（批量上限，AGENTS §10；原站样本最多 3 段）。 */
export const MAX_SUB_PROCESSES = 10;
/** 相对时间“前 / 后 N 天”的上限（约十年）。 */
export const MAX_START_DAYS = 3650;

export interface StartRule {
  readonly startMode: StartMode;
  readonly startTimeType: StartTimeType | null;
  readonly fixedDate: string | null;
  readonly referencePoint: ReferencePoint | null;
  readonly startFrom: StartFrom | null;
  readonly days: number | null;
}

/**
 * 开启规则自洽性（IDP-R2，Q-M0-115②）：手动开启不带规则；自动开启无规则 = 上一阶段结束（第一段 = 计划开始）即开启；
 * 固定时间要日期；相对时间要参照点与始于，前 / 后 N 天要 1..3650 天，当天不带天数；第一段没有“上一阶段结束时间”。
 * 返回违规说明，自洽时返回 null。
 */
export function startRuleViolation(rule: StartRule, index: number): string | null {
  const extras = [rule.startTimeType, rule.fixedDate, rule.referencePoint, rule.startFrom, rule.days];
  if (rule.startMode === 'manual') {
    return extras.some((value) => value !== null) ? '手动开启的子流程不能设置开启规则' : null;
  }
  if (rule.startTimeType === null) {
    return extras.some((value) => value !== null) ? '未选择发起时间类型时不能设置开启规则' : null;
  }
  if (rule.startTimeType === 'fixed') {
    if (!rule.fixedDate) return '固定时间开启须填写日期';
    if (rule.referencePoint !== null || rule.startFrom !== null || rule.days !== null) {
      return '固定时间开启不能设置参照时间点与天数';
    }
    return null;
  }
  if (rule.fixedDate !== null) return '相对时间开启不能填写固定日期';
  if (!rule.referencePoint || !rule.startFrom) return '相对时间开启须选择参照时间点与始于';
  if (rule.referencePoint === 'previous_end' && index === 0)
    return '第一个子流程没有上一阶段，不能以上一阶段结束时间为参照';
  if (rule.startFrom === 'same_day') return rule.days === null ? null : '“当天”开启不能填写天数';
  if (rule.days === null || !Number.isInteger(rule.days) || rule.days < 1 || rule.days > MAX_START_DAYS) {
    return `前 / 后 N 天须为 1～${MAX_START_DAYS} 的整数`;
  }
  return null;
}

const REFERENCE_LABELS: Readonly<Record<ReferencePoint, string>> = {
  plan_start: '发展计划开始时间',
  plan_end: '发展计划结束时间',
  previous_end: '上一阶段结束时间',
  employment_effective: '任职记录生效时间',
};

/**
 * 开启规则说明文本（Q-M0-115② 原站样本：“上一流程结束后自动开启”“于〈参照时间点〉当天 / 前 5 天的凌晨 2 点自动开启”）。
 * 第一段无规则的文案原站未见，复刻自定为“发展计划开始后自动开启”（🟡 K-06）。
 */
export function startRuleText(rule: StartRule, index: number): string {
  if (rule.startMode === 'manual') return '手动开启';
  const hour = `凌晨${AUTO_START_HOUR}点`;
  if (rule.startTimeType === null) return index === 0 ? '发展计划开始后自动开启' : '上一流程结束后自动开启';
  if (rule.startTimeType === 'fixed') return `于${rule.fixedDate}的${hour}自动开启`;
  const offset = rule.startFrom === 'same_day' ? '当天' : `${rule.startFrom === 'before' ? '前' : '后'}${rule.days}天`;
  return `于${REFERENCE_LABELS[rule.referencePoint!]}${offset}的${hour}自动开启`;
}

/**
 * IDP-R5：被模板引用的流程不能改子流程顺序和开启方式。增删子流程同样改变顺序，一并拒绝（🟡 K-24）。
 * before / after 按流程内顺序排列；after 中没有 id 的是新增段。
 */
export function referencedProcessChangeViolation(
  before: readonly { readonly id: string; readonly startMode: StartMode }[],
  after: readonly { readonly id?: string | undefined; readonly startMode: StartMode }[],
): string | null {
  if (before.length !== after.length || after.some((sub, i) => sub.id !== before[i]!.id)) {
    return '流程已被模板引用，不能调整子流程顺序或增删子流程';
  }
  if (after.some((sub, i) => sub.startMode !== before[i]!.startMode)) {
    return '流程已被模板引用，不能修改子流程的开启方式';
  }
  return null;
}

/** 每个模板只能有一个的模块：基本信息（固定、不可删，IDP-R7）、关键信息。 */
export const SINGLETON_MODULES: ReadonlySet<ModuleType> = new Set(['basic', 'key_info']);

/** IDP-R12：模板被计划引用后，只能改这些模块的设置；不能增删任何模块。 */
export const EDITABLE_AFTER_REFERENCED: ReadonlySet<ModuleType> = new Set(['basic', 'key_info', 'goal']);

/** 可以按流程节点配置按钮的模块类型及其候选按钮（DEC-296④；内容类模块 🟡 K-12）。 */
export function nodeButtonsOf(moduleType: ModuleType): readonly NodeButton[] | null {
  if (moduleType === 'goal') return GOAL_NODE_BUTTONS;
  if (moduleType === 'analysis' || moduleType === 'review' || moduleType === 'summary') return CONTENT_NODE_BUTTONS;
  return null;
}
