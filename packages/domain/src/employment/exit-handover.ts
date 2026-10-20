/**
 * R2 BE-8b1 离职交接设置（B64 交接事项、B65 交接发起规则；DEC-266③、DEC-632；差距表“补证结论 R2c / R2f”）。纯规则，不碰 IO。
 * - 交接事项：事项类别、序号、待办类别（工作交接 / 其他）、待办事项、事项办理表单、备注；没有适用人群与负责人（办理人由交接流程会签节点决定）。
 * - 发起规则：只实现已验证的“离职申请审批通过后自动发起”，发起人只有员工本人；其他发起方式（提交 / 节点同意时、审批通过且距最后工作日 N 天）
 *   与其他发起人未验证，校验直接拒绝并提示“未验证、后补”（交接执行归 BE-8b2）。
 */

/** 待办类别。 */
export const HANDOVER_TODO_TYPES = { work_handover: '工作交接', other: '其他' } as const;
export type HandoverTodoType = keyof typeof HANDOVER_TODO_TYPES;
export const HANDOVER_TODO_TYPE_CODES = Object.keys(HANDOVER_TODO_TYPES) as [HandoverTodoType, ...HandoverTodoType[]];

export const HANDOVER_ITEM_LIMIT = 200;
export const HANDOVER_CATEGORY_MAX = 50;
export const HANDOVER_TITLE_MAX = 200;
export const HANDOVER_FORM_REF_MAX = 200;
export const HANDOVER_REMARK_MAX = 500;

/** 交接发起规则（租户设置项，两层配置）。 */
export const EXIT_HANDOVER_TRIGGER_KEY = 'exit.handover_trigger';

/** 已验证的发起方式 / 发起人；其余取值在 UNVERIFIED_* 里，校验时给出“未验证、后补”。 */
export const HANDOVER_VERIFIED_METHOD = 'on_approval_passed';
export const HANDOVER_VERIFIED_INITIATOR = 'self';
const UNVERIFIED_METHODS = ['on_submit', 'on_node_approved', 'days_before_last_work_date'] as const;
const UNVERIFIED_INITIATORS = ['role'] as const;
export const HANDOVER_REMIND_DAYS_MAX = 365;

export interface HandoverTriggerSetting {
  readonly enabled: boolean;
  readonly method: typeof HANDOVER_VERIFIED_METHOD;
  /** 包含最后工作日早于审批通过日的人员。 */
  readonly includePastLastWorkDate: boolean;
  readonly initiator: typeof HANDOVER_VERIFIED_INITIATOR;
  readonly remind: {
    readonly enabled: boolean;
    readonly daysBeforeLastWorkDate: number;
    readonly daysAfterLastWorkDate: number;
  };
}

/** 系统默认值（与迁移种子一致）：启用、审批通过后自动发起、包含已过人员、员工本人、催办前 5 天 / 后 15 天。 */
export const HANDOVER_TRIGGER_DEFAULT: HandoverTriggerSetting = {
  enabled: true,
  method: HANDOVER_VERIFIED_METHOD,
  includePastLastWorkDate: true,
  initiator: HANDOVER_VERIFIED_INITIATOR,
  remind: { enabled: true, daysBeforeLastWorkDate: 5, daysAfterLastWorkDate: 15 },
};

export type HandoverTriggerCheck =
  { readonly ok: true; readonly value: HandoverTriggerSetting } | { readonly ok: false; readonly unverified: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isDays = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= HANDOVER_REMIND_DAYS_MAX;

/** 校验租户写入的发起规则：结构严格（不接受未知字段）；未验证的发起方式 / 发起人单独标出，供接口提示“未验证、后补”。 */
export function checkHandoverTrigger(value: unknown): HandoverTriggerCheck {
  const invalid = { ok: false, unverified: false } as const;
  if (!isRecord(value) || !hasExactKeys(value, ['enabled', 'method', 'includePastLastWorkDate', 'initiator', 'remind']))
    return invalid;
  const { enabled, method, includePastLastWorkDate, initiator, remind } = value;
  if (typeof enabled !== 'boolean' || typeof includePastLastWorkDate !== 'boolean') return invalid;
  if (
    !isRecord(remind) ||
    !hasExactKeys(remind, ['enabled', 'daysBeforeLastWorkDate', 'daysAfterLastWorkDate']) ||
    typeof remind.enabled !== 'boolean' ||
    !isDays(remind.daysBeforeLastWorkDate) ||
    !isDays(remind.daysAfterLastWorkDate)
  )
    return invalid;
  if ((UNVERIFIED_METHODS as readonly unknown[]).includes(method)) return { ok: false, unverified: true };
  if ((UNVERIFIED_INITIATORS as readonly unknown[]).includes(initiator)) return { ok: false, unverified: true };
  if (method !== HANDOVER_VERIFIED_METHOD || initiator !== HANDOVER_VERIFIED_INITIATOR) return invalid;
  return {
    ok: true,
    value: {
      enabled,
      method: HANDOVER_VERIFIED_METHOD,
      includePastLastWorkDate,
      initiator: HANDOVER_VERIFIED_INITIATOR,
      remind: {
        enabled: remind.enabled,
        daysBeforeLastWorkDate: remind.daysBeforeLastWorkDate,
        daysAfterLastWorkDate: remind.daysAfterLastWorkDate,
      },
    },
  };
}

// ---- BE-8b2 交接执行 ------------------------------------------------------------------------------------------------

/** 交接申请状态：进行中 / 已完成 / 已终止（不同意、撤销离职、驳回、撤回）。“未发起”是没有交接申请时的展示状态。 */
export const HANDOVER_REQUEST_STATES = ['in_progress', 'completed', 'terminated'] as const;
export type HandoverRequestState = (typeof HANDOVER_REQUEST_STATES)[number];
export type HandoverDisplayStatus = HandoverRequestState | 'not_started';

/** 终止原因（exit_handover_requests.end_reason）。 */
export const HANDOVER_END_REASONS = ['disapproved', 'rejected', 'withdrawn', 'exit_cancelled'] as const;
export type HandoverEndReason = (typeof HANDOVER_END_REASONS)[number];
/** 撤销离职终止交接的日志理由（B4 撤销端口）。 */
export const HANDOVER_CANCEL_REASON = '离职撤销终止交接';

/** 交接流程四个节点（R2c B64）：工作交接 → 其他事项交接 → 员工确认 → HRBP办离职证明。 */
export const HANDOVER_NODE_KEYS = {
  work: 'work_handover',
  other: 'other_handover',
  employee: 'employee_confirm',
  hrbp: 'hrbp_certificate',
} as const;

/** 事项由哪个节点办理：工作交接节点只办“工作交接”类，其他事项交接节点只办“其他”类（员工确认 / HRBP 节点没有事项）。 */
export const HANDOVER_NODE_OF_TODO: Readonly<Record<HandoverTodoType, string>> = {
  work_handover: HANDOVER_NODE_KEYS.work,
  other: HANDOVER_NODE_KEYS.other,
};

export type HandoverLaunchDecision = 'launch' | 'disabled' | 'past_last_work_date';

/**
 * 审批通过时是否自动发起（B65，DM-R13）：开关关 → 不发起；“包含最后工作日早于审批通过日期的人员”未勾选且最后工作日早于
 * 审批通过当天（租户日）→ 不发起。发起方式 / 发起人 b1 已限定为已验证的唯一取值。
 */
export function handoverLaunchDecision(
  setting: Pick<HandoverTriggerSetting, 'enabled' | 'includePastLastWorkDate'>,
  facts: { readonly lastWorkDate: string | null; readonly approvedOn: string },
): HandoverLaunchDecision {
  if (!setting.enabled) return 'disabled';
  if (!setting.includePastLastWorkDate && facts.lastWorkDate !== null && facts.lastWorkDate < facts.approvedOn)
    return 'past_last_work_date';
  return 'launch';
}
