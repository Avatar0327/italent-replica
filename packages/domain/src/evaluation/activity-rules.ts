/**
 * 评定活动的纯规则（R3-T02 设计 §3.2；规格 24 EV-R12～R14；DEC-370② Q-T02-09；拆分方案 B5）。无 I/O：
 * - 环节：apply 与 result 必有且 apply 在首、result 在末（🟢 首尾不可删），每类至多 1 个；环节日期在活动起止内 🟡；
 *   答辩评审后紧接结果发布只能手动转入（EV-R13）；apply 的资格审批流程必填（配置时拦截，取代提交时 409）；
 *   各环节字段的适用性：评价表仅 material / defense，审批流程仅 apply / material，材料模板仅 material，强控截止与破格仅 apply 🟡；
 * - 编辑锁 EV-R14 / AC-EV-05：已有报名后只许改规格列出的字段，其余内容变化 → 锁定（`activityLockedChange`）。
 * 日期一律 `YYYY-MM-DD` 字符串（租户时区的业务日期，字典序即时间序）。
 */
export const CHAIN_TYPES = ['apply', 'material', 'defense', 'result'] as const;
export type ChainType = (typeof CHAIN_TYPES)[number];
export const TRANSFER_MODES = ['auto', 'manual'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];
export const APPLICANT_MODES = ['self', 'others', 'both'] as const;
export type ApplicantMode = (typeof APPLICANT_MODES)[number];
export const ACTIVITY_STATUSES = ['draft', 'published', 'completed'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export interface ChainDraft {
  readonly type: ChainType;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly formId: string | null;
  readonly approvalProcessCode: string | null;
  readonly materialTemplate: string | null;
  readonly hardDeadline: boolean;
  readonly allowException: boolean;
  readonly exceptionRoles: readonly string[];
  readonly transferMode: TransferMode;
  readonly noticeTemplateCode: string | null;
}

export interface ChainViolation {
  readonly reason: string;
  readonly message: string;
}
const violation = (reason: string, message: string): ChainViolation => ({ reason, message });

/** 活动起止日期：开始不晚于结束。 */
export function checkActivityDates(startDate: string, endDate: string): ChainViolation | null {
  return startDate <= endDate ? null : violation('ACTIVITY_DATE_RANGE_INVALID', '活动开始日期不能晚于结束日期');
}

/** 各环节类型上不适用的字段（传了值 → 400，不静默忽略）。 */
function inapplicable(chain: ChainDraft): string | null {
  const onlyIn = (allowed: readonly ChainType[]) => allowed.includes(chain.type);
  if (chain.formId !== null && !onlyIn(['material', 'defense'])) return '评价表';
  if (chain.approvalProcessCode !== null && !onlyIn(['apply', 'material'])) return '审批流程';
  if (chain.materialTemplate !== null && !onlyIn(['material'])) return '材料提交模板';
  if (chain.hardDeadline && !onlyIn(['apply'])) return '强控报名截止';
  if ((chain.allowException || chain.exceptionRoles.length) && !onlyIn(['apply'])) return '破格提名';
  // 结果发布是最后一个环节，没有“转入下一环节”
  if (chain.type === 'result' && chain.transferMode !== 'manual') return '转入方式';
  return null;
}

/** 整份环节的规则，返回第一条违反的规则；null = 通过。`chains` 为提交顺序。 */
export function checkActivityChains(
  activity: { readonly startDate: string; readonly endDate: string },
  chains: readonly ChainDraft[],
): ChainViolation | null {
  const types = chains.map((chain) => chain.type);
  if (new Set(types).size !== types.length) {
    return violation('ACTIVITY_CHAIN_TYPE_DUPLICATE', '同一类型的环节最多一个');
  }
  if (!types.includes('apply')) return violation('ACTIVITY_CHAIN_APPLY_REQUIRED', '活动必须有资格申报环节');
  if (!types.includes('result')) return violation('ACTIVITY_CHAIN_RESULT_REQUIRED', '活动必须有结果发布环节');
  if (types[0] !== 'apply' || types[types.length - 1] !== 'result') {
    return violation('ACTIVITY_CHAIN_ORDER_INVALID', '资格申报须为第一个环节，结果发布须为最后一个环节');
  }
  for (const [index, chain] of chains.entries()) {
    const field = inapplicable(chain);
    if (field) return violation('ACTIVITY_CHAIN_FIELD_NOT_ALLOWED', `${chain.name}环节不能设置${field}`);
    if (chain.type === 'apply' && !chain.approvalProcessCode) {
      return violation('APPROVAL_PROCESS_REQUIRED', '资格申报环节须选择资格审批流程');
    }
    if (chain.startDate > chain.endDate) {
      return violation('ACTIVITY_CHAIN_DATE_INVALID', `${chain.name}环节开始日期不能晚于结束日期`);
    }
    if (chain.startDate < activity.startDate || chain.endDate > activity.endDate) {
      return violation('ACTIVITY_CHAIN_DATE_OUT_OF_RANGE', `${chain.name}环节日期须在活动起止日期之内`);
    }
    // EV-R13：答辩评审 → 结果发布只能手动转入
    if (chain.type === 'defense' && chains[index + 1]?.type === 'result' && chain.transferMode !== 'manual') {
      return violation('ACTIVITY_CHAIN_DEFENSE_TRANSFER_MANUAL', '答辩评审转入结果发布只能手动转入');
    }
  }
  return null;
}

export interface ActivityLockInput {
  readonly code: string;
  readonly typeId: string;
  readonly orgRange: readonly string[];
  readonly categoryIds: readonly string[];
  readonly levelIds: readonly string[];
  readonly effectiveDate: string | null;
  readonly noticeOrgRange: readonly string[];
  readonly chains: readonly ChainDraft[];
}

const sorted = (list: readonly string[]) => [...list].sort();

/**
 * 编辑锁（EV-R14 / AC-EV-05）：已有报名后不可改的内容的规范形。可改的字段（名称、所属组织、年度、周期、负责人、起止日期、申请人、
 * 可申报级别、参评条件，环节的名称 / 日期 / 顺序 / 流程 / 转入方式 / 通知）不在其中。环节按类型对应，增删环节与改评价表 / 材料模板 /
 * 强控截止 / 破格都会改变它；列表型字段与顺序无关。
 */
export function activityLockedContent(activity: ActivityLockInput): string {
  const chains = [...activity.chains]
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((chain) => [
      chain.type,
      chain.formId,
      chain.materialTemplate,
      chain.hardDeadline,
      chain.allowException,
      sorted(chain.exceptionRoles),
    ]);
  return JSON.stringify([
    activity.code,
    activity.typeId,
    sorted(activity.orgRange),
    sorted(activity.categoryIds),
    sorted(activity.levelIds),
    activity.effectiveDate,
    sorted(activity.noticeOrgRange),
    chains,
  ]);
}

/** 已有报名时，`after` 相对 `before` 是否改了被锁定的内容。 */
export const activityLockedChange = (before: ActivityLockInput, after: ActivityLockInput): boolean =>
  activityLockedContent(before) !== activityLockedContent(after);
