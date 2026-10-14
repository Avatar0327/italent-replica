/**
 * 评定活动的纯规则（R3-T02 设计 §3.2；规格 24 EV-R12～R14 与 Q-M0-174 补充；DEC-370② Q-T02-09、DEC-412；拆分方案 B5）。无 I/O：
 * - 环节：资格申报、结果发布各 1 个且分别在首、末；材料举证、答辩评审各最多 3 个、先后不限；评价表只在答辩评审上且必填；审批流程
 *   仅 apply（必填，配置时拦截）/ material（可空）；材料模板仅 material；强控截止与破格仅 apply；转入方式缺省 apply / material 自动、
 *   答辩评审只有手动（也就不存在“答辩 → 结果发布必须手动”的单独规则）；环节日期在活动起止内 🟡（活动起止日期非必填，没填不约束）；
 * - 环节按 ID（没带 ID 的按同类型顺序）与库里已有环节对应，就地更新、保留稳定 ID（`matchChains`）；
 * - 编辑锁 EV-R14 / AC-EV-05：已有报名后只许改规格列出的字段，其余内容变化 → 锁定（`activityLockedChange`）。
 * 日期一律 `YYYY-MM-DD` 字符串（租户时区的业务日期，字典序即时间序）。
 */
export const CHAIN_TYPES = ['apply', 'material', 'defense', 'result'] as const;
export type ChainType = (typeof CHAIN_TYPES)[number];
export const TRANSFER_MODES = ['auto', 'manual'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];
/** 申请人：员工本人可自主申报；非员工本人（直线上级、部门负责人、HRBP 等）可提名。多选，两个都勾就是都可以。 */
export const APPLICANTS = ['self', 'others'] as const;
export type Applicant = (typeof APPLICANTS)[number];
export const ACTIVITY_STATUSES = ['draft', 'published', 'completed'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
/** 材料举证、答辩评审各最多 3 个（Q-M0-174 第 6 点）；活动适用组织范围最多 100 个。 */
export const MAX_REPEATABLE_CHAINS = 3;
export const MAX_ACTIVITY_ORG_RANGE = 100;

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

/** 转入下一环节的缺省：资格申报 / 材料举证“完成后自动转入”，答辩评审只有手动，结果发布没有下一环节（记手动）。 */
export const defaultTransferMode = (type: ChainType): TransferMode =>
  type === 'apply' || type === 'material' ? 'auto' : 'manual';

/**
 * `message` 是不带环节名称的通用提示；涉及某个环节时另给 `named`（带名称的提示）。环节名称只能披露给对 `chains` 字段有查看权的人，
 * 所以由调用方按当前字段权决定用哪一个——修改活动日期时校验的是库里已有的环节，操作人可能根本看不到它们（#226 第 1 轮 P2-1）。
 */
export interface ChainViolation {
  readonly reason: string;
  readonly message: string;
  readonly named?: string;
}
const violation = (reason: string, message: string, named?: string): ChainViolation => ({
  reason,
  message,
  ...(named ? { named } : {}),
});

/** 活动起止日期（都非必填）：两个都填时开始不晚于结束。 */
export function checkActivityDates(startDate: string | null, endDate: string | null): ChainViolation | null {
  if (startDate === null || endDate === null || startDate <= endDate) return null;
  return violation('ACTIVITY_DATE_RANGE_INVALID', '活动开始日期不能晚于结束日期');
}

/** 各环节类型上不适用的字段（传了值 → 400，不静默忽略）；评价表缺失由 `checkActivityChains` 单独报必填。 */
function inapplicable(chain: ChainDraft): string | null {
  const onlyIn = (allowed: readonly ChainType[]) => allowed.includes(chain.type);
  if (chain.formId !== null && !onlyIn(['defense'])) return '评价表';
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
  activity: { readonly startDate: string | null; readonly endDate: string | null },
  chains: readonly ChainDraft[],
): ChainViolation | null {
  const count = (type: ChainType) => chains.filter((chain) => chain.type === type).length;
  if (count('apply') > 1 || count('result') > 1) {
    return violation('ACTIVITY_CHAIN_TYPE_DUPLICATE', '资格申报、结果发布各只能有一个');
  }
  if (count('material') > MAX_REPEATABLE_CHAINS || count('defense') > MAX_REPEATABLE_CHAINS) {
    return violation('ACTIVITY_CHAIN_COUNT_EXCEEDED', `材料举证、答辩评审各最多 ${MAX_REPEATABLE_CHAINS} 个`);
  }
  if (!count('apply')) return violation('ACTIVITY_CHAIN_APPLY_REQUIRED', '活动必须有资格申报环节');
  if (!count('result')) return violation('ACTIVITY_CHAIN_RESULT_REQUIRED', '活动必须有结果发布环节');
  if (chains[0]!.type !== 'apply' || chains[chains.length - 1]!.type !== 'result') {
    return violation('ACTIVITY_CHAIN_ORDER_INVALID', '资格申报须为第一个环节，结果发布须为最后一个环节');
  }
  for (const chain of chains) {
    const field = inapplicable(chain);
    if (field) {
      return violation('ACTIVITY_CHAIN_FIELD_NOT_ALLOWED', `环节不能设置${field}`, `${chain.name}环节不能设置${field}`);
    }
    if (chain.type === 'defense' && chain.formId === null) {
      return violation('ACTIVITY_CHAIN_FORM_REQUIRED', '答辩评审环节须选择评价表', `${chain.name}环节须选择评价表`);
    }
    if (chain.type === 'apply' && !chain.approvalProcessCode) {
      return violation('APPROVAL_PROCESS_REQUIRED', '资格申报环节须选择资格审批流程');
    }
    // EV-R13 / Q-M0-174：答辩评审转入下一环节只有“手动转入”
    if (chain.type === 'defense' && chain.transferMode !== 'manual') {
      return violation(
        'ACTIVITY_CHAIN_DEFENSE_TRANSFER_MANUAL',
        '答辩评审只能手动转入下一环节',
        `${chain.name}环节只能手动转入下一环节`,
      );
    }
    if (chain.startDate > chain.endDate) {
      return violation(
        'ACTIVITY_CHAIN_DATE_INVALID',
        '环节开始日期不能晚于结束日期',
        `${chain.name}环节开始日期不能晚于结束日期`,
      );
    }
    const outside =
      (activity.startDate !== null && chain.startDate < activity.startDate) ||
      (activity.endDate !== null && chain.endDate > activity.endDate);
    if (outside) {
      return violation(
        'ACTIVITY_CHAIN_DATE_OUT_OF_RANGE',
        '环节日期须在活动起止日期之内',
        `${chain.name}环节日期须在活动起止日期之内`,
      );
    }
  }
  return null;
}

export type ChainMatch<
  B extends { readonly id: string; readonly type: ChainType },
  A extends { readonly type: ChainType },
> =
  | {
      readonly ok: true;
      readonly pairs: readonly (readonly [B, A])[];
      readonly added: readonly A[];
      readonly removed: readonly B[];
    }
  | { readonly ok: false; readonly reason: 'ACTIVITY_CHAIN_ID_UNKNOWN' };

/**
 * 提交的环节与库里已有环节对应：带 `id` 的按 ID（必须是本活动已有的环节、类型一致、不重复）；没带 `id` 的按同类型已有环节的顺序
 * 依次对应；对应不上的提交环节是新增，没被对应的已有环节是移除。就地更新保留稳定 ID（C2 的指标明细按环节 ID 引用）。
 */
export function matchChains<
  B extends { readonly id: string; readonly type: ChainType },
  A extends { readonly type: ChainType; readonly id?: string | undefined },
>(existing: readonly B[], submitted: readonly A[]): ChainMatch<B, A> {
  const claimed = new Map<string, A>();
  const byId = new Map(existing.map((chain) => [chain.id, chain]));
  for (const chain of submitted) {
    if (chain.id === undefined) continue;
    const found = byId.get(chain.id);
    if (!found || found.type !== chain.type || claimed.has(chain.id)) {
      return { ok: false, reason: 'ACTIVITY_CHAIN_ID_UNKNOWN' };
    }
    claimed.set(chain.id, chain);
  }
  const pairs: (readonly [B, A])[] = [];
  const added: A[] = [];
  for (const chain of submitted) {
    const target =
      chain.id !== undefined
        ? byId.get(chain.id)
        : existing.find((candidate) => candidate.type === chain.type && !claimed.has(candidate.id));
    if (!target) {
      added.push(chain);
      continue;
    }
    claimed.set(target.id, chain);
    pairs.push([target, chain]);
  }
  return { ok: true, pairs, added, removed: existing.filter((chain) => !claimed.has(chain.id)) };
}

export interface OrgRangeEntry {
  readonly orgId: string;
  readonly includeDescendants: boolean;
}
export interface ActivityLockInput {
  readonly typeId: string;
  readonly orgRange: readonly OrgRangeEntry[];
  readonly categoryIds: readonly string[];
  readonly levelIds: readonly string[];
  readonly effectiveDate: string | null;
  readonly noticeOrgRange: readonly string[];
}

const sorted = (list: readonly string[]) => [...list].sort();
const lockedChainFields = (chain: ChainDraft) =>
  JSON.stringify([
    chain.formId,
    chain.materialTemplate,
    chain.hardDeadline,
    chain.allowException,
    sorted(chain.exceptionRoles),
  ]);

/**
 * 编辑锁（EV-R14 / AC-EV-05）：已有报名后不可改的内容。可改的字段（名称、所属组织、年度、周期、负责人、起止日期、申请人、可申报级别、
 * 参评条件，环节的名称 / 日期 / 顺序 / 流程 / 转入方式 / 通知）不在其中。增删环节、改适用范围 / 类型 / 类别 / 级别 / 生效日期 /
 * 通知范围、改环节的评价表 / 材料模板 / 强控截止 / 破格都算改动；列表型字段与顺序无关。
 */
export function activityLockedChange(
  before: ActivityLockInput,
  after: ActivityLockInput,
  chains: {
    readonly pairs: readonly (readonly [ChainDraft, ChainDraft])[];
    readonly added: number;
    readonly removed: number;
  },
): boolean {
  const content = (activity: ActivityLockInput) =>
    JSON.stringify([
      activity.typeId,
      [...activity.orgRange].map((entry) => `${entry.orgId}:${entry.includeDescendants}`).sort(),
      sorted(activity.categoryIds),
      sorted(activity.levelIds),
      activity.effectiveDate,
      sorted(activity.noticeOrgRange),
    ]);
  if (content(before) !== content(after)) return true;
  if (chains.added > 0 || chains.removed > 0) return true;
  return chains.pairs.some(([was, now]) => lockedChainFields(was) !== lockedChainFields(now));
}
