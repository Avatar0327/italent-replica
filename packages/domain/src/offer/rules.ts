/**
 * Offer 对象的纯规则（R2 BE-14a，DEC-581；docs/02_业务建模/34 §2.1、OF-R1 / R3 / R7 / R12，DEC-527～537）。
 * C1：状态与审批子状态的取值、字段集、按类型必填、可编辑判定、两项转移按钮的编码与两个原因字典；
 * C2（BE-14a2）：状态转移、失效、OF-R3 发送前须审批的判定。社招与实习共用一套状态机（DEC-532⑤）。
 * 联动待入职（BE-14b3）：转已拒绝 / 已发退回待发时取消待入职，失效时删除待入职，待入职办理入职后联动为已入职（均在服务层
 * 经 pendingEntry 端口执行，这里只给判定）；已有待入职时不能手动转已入职（OFFER_ENTRY_LINKED）。审批类型在 BE-14a3。
 */
export const OFFER_OBJECT = 'TenantBase.Offer';

export const OFFER_STATUSES = ['pending', 'sent', 'accepted', 'rejected', 'onboarded', 'invalid'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** 待发 Offer 的审批子状态：未发起审批 / 审批中 / 审批通过 / 不通过（34 §2.1）。 */
export const OFFER_APPROVAL_STATUSES = ['unsubmitted', 'approving', 'approved', 'disapproved'] as const;
export type OfferApprovalStatus = (typeof OFFER_APPROVAL_STATUSES)[number];

/** 社招 / 校招 / 实习；类型为空按社招（OF-R12）。 */
export const OFFER_TYPES = ['social', 'campus', 'intern'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];
export const effectiveOfferType = (type: OfferType | null | undefined): OfferType => type ?? 'social';

/** 三个新建入口（DEC-527③）：新建 Offer / 新建实习生 / 校招生提前实习（须先选一份校招 Offer）。 */
export const OFFER_ENTRIES = ['offer', 'intern', 'campus_early_intern'] as const;
export type OfferEntry = (typeof OFFER_ENTRIES)[number];
/** 新建 Offer 的来源：新增人员 / 实习生转正（34 §1）。 */
export const OFFER_SOURCES = ['new_hire', 'intern_conversion'] as const;
export type OfferSource = (typeof OFFER_SOURCES)[number];

/** 转移状态的两项按钮权限（R2e5，DEC-533④ / 537③）：列表级在顶部工具栏，行级在行主按钮，两个入口各查各的。 */
export const OFFER_BUTTONS = {
  statusTransfer: { code: 'Offer.StatusTransfer', level: 'list' },
  lineStatusTransfer: { code: 'OfferLineOpStatusTransfer', level: 'list_row' },
} as const;

/** OF-R1 字段集，按 Offer 详情分区（A20）；薪资、社保只保存，不写档案（34 §5）。 */
export const OFFER_FIELD_SECTIONS = {
  basic: ['name', 'personalEmail', 'mobile', 'gender', 'idType', 'idNumber', 'birthDate', 'workStartDate'],
  recruitment: ['channelName', 'appliedPosition', 'recruitmentDemand'],
  employment: [
    'departmentId',
    'plannedEntryDate',
    'positionId',
    'postId',
    'levelId',
    'workPlace',
    'hasProbation',
    'probationMonths',
    'directManagerId',
    'dottedManagerId',
    'hrbpId',
    'costCenter',
  ],
  contract: ['contractCompanyId', 'contractTermType', 'contractMonths', 'contractEndDate'],
  salary: ['salaryBeforeRegular', 'salaryAfterRegular'],
  socialInsurance: ['socialInsuranceBase', 'housingFundBase'],
} as const;
export type OfferField = (typeof OFFER_FIELD_SECTIONS)[keyof typeof OFFER_FIELD_SECTIONS][number];
export const OFFER_FIELDS = Object.values(OFFER_FIELD_SECTIONS).flat() as OfferField[];

/** 转移 / 失效表单与状态字段：只经转移与失效命令写入，不在普通编辑里出现。 */
export const OFFER_STATUS_FIELDS = [
  'acceptTime',
  'refusalTime',
  'refusalReasonCode',
  'refusalRemark',
  'invalidReasonCode',
  'invalidRemark',
  'invalidAt',
] as const;

/** 拒绝时间 / 原因 / 备注：退回待发后保留不清空，详情与编辑只在“已拒绝”时显示，转移表单带出原值（DEC-532①）。 */
export const OFFER_REFUSAL_FIELDS = ['refusalTime', 'refusalReasonCode', 'refusalRemark'] as const;

/**
 * 按类型区分必填（OF-R1，DEC-532⑤）：社招新建必填 10 项；实习只必填 4 项。校招没有单独取证，按“类型为空按社招”
 * 同口径取社招集合（保守取严）。
 */
const SOCIAL_REQUIRED: readonly OfferField[] = [
  'channelName',
  'name',
  'personalEmail',
  'departmentId',
  'plannedEntryDate',
  'levelId',
  'directManagerId',
  'hrbpId',
  'costCenter',
  'contractCompanyId',
];
const INTERN_REQUIRED: readonly OfferField[] = ['name', 'personalEmail', 'departmentId', 'plannedEntryDate'];

export function offerRequiredFields(type: OfferType | null | undefined): readonly OfferField[] {
  return effectiveOfferType(type) === 'intern' ? INTERN_REQUIRED : SOCIAL_REQUIRED;
}

const blank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && !value.trim());

export function missingOfferFields(
  type: OfferType | null | undefined,
  values: Readonly<Partial<Record<OfferField, unknown>>>,
): OfferField[] {
  return offerRequiredFields(type).filter((field) => blank(values[field]));
}

export interface OfferStateFacts {
  readonly status: OfferStatus;
  readonly approvalStatus: OfferApprovalStatus;
  readonly offerType: OfferType | null;
  /** 已关联待入职记录（同步产物是待入职；实习转正记录不算，那里没有可取消 / 删除的待入职）。 */
  readonly hasPendingEntry: boolean;
}

/** 编辑、删除只限待发且不在审批中。 */
export const offerEditable = (offer: Pick<OfferStateFacts, 'status' | 'approvalStatus'>) =>
  offer.status === 'pending' && offer.approvalStatus !== 'approving';

/** 编辑并同步（OF-R14）的入口：已发、已接受；普通编辑（offerEditable）的 Offer 也走同一接口（只保存 Offer）。 */
export const offerEditableWithSync = (offer: Pick<OfferStateFacts, 'status' | 'approvalStatus'>) =>
  offerEditable(offer) || offer.status === 'sent' || offer.status === 'accepted';

/** 转移候选（34 §2.1 转移表）；已接受 → 待发须先经过已拒绝，所以不在候选里。 */
export const OFFER_TRANSITIONS: Readonly<Record<OfferStatus, readonly OfferStatus[]>> = {
  pending: ['accepted', 'rejected'],
  sent: ['pending', 'accepted', 'rejected'],
  accepted: ['rejected', 'onboarded'],
  rejected: ['pending', 'accepted'],
  onboarded: [],
  invalid: [],
};

export type OfferRejection =
  | 'OFFER_TRANSITION_INVALID'
  | 'OFFER_APPROVAL_IN_PROGRESS'
  | 'OFFER_ENTRY_LINKED'
  | 'OFFER_FORM_INCOMPLETE'
  | 'OFFER_INVALIDATION_NOT_ALLOWED'
  | 'OFFER_APPROVAL_REQUIRED'
  | 'OFFER_NOT_PENDING';

export type OfferPlan<P> =
  | { readonly ok: true; readonly patch: P }
  | { readonly ok: false; readonly reason: OfferRejection; readonly fields?: readonly string[] };

const reject = (reason: OfferRejection, fields?: readonly string[]): OfferPlan<never> =>
  fields ? { ok: false, reason, fields } : { ok: false, reason };

/**
 * 转移前的状态守卫（表单之前）：候选外的目标、审批中的待发各自给机读拒绝。已接受 → 已入职只限“未同步待入职”
 * （34 §2.1）：已有待入职时由待入职办理入职联动，手动转移拒绝，免得 Offer 已入职而待入职还在。
 */
function transitionGuard(offer: OfferStateFacts, target: OfferStatus): OfferRejection | null {
  if (!OFFER_TRANSITIONS[offer.status].includes(target)) return 'OFFER_TRANSITION_INVALID';
  if (offer.status === 'pending' && offer.approvalStatus === 'approving') return 'OFFER_APPROVAL_IN_PROGRESS';
  if (target === 'onboarded' && offer.hasPendingEntry) return 'OFFER_ENTRY_LINKED';
  return null;
}

/**
 * 转移要联动的待入职动作（34 §2.1、OF-R4）：转已拒绝，或已发退回待发，已有待入职 → 取消入职。
 * 取消不走 OF-R9 的回调（Offer 自己已是目标状态）。
 */
export const offerTransitionCancelsEntry = (
  offer: Pick<OfferStateFacts, 'status' | 'hasPendingEntry'>,
  target: OfferStatus,
) => offer.hasPendingEntry && (target === 'rejected' || (target === 'pending' && offer.status === 'sent'));

/** 转移状态表单里可选的目标：只列本段能完成的转移（不给可点但必然被拒的候选）。 */
export const offerTransferTargets = (offer: OfferStateFacts): OfferStatus[] =>
  OFFER_TRANSITIONS[offer.status].filter((target) => transitionGuard(offer, target) === null);

export interface OfferTransitionForm {
  readonly acceptTime?: string | null | undefined;
  readonly refusalTime?: string | null | undefined;
  readonly refusalReasonCode?: string | null | undefined;
  readonly refusalRemark?: string | null | undefined;
}

export interface OfferTransitionPatch {
  readonly status: OfferStatus;
  readonly approvalStatus?: OfferApprovalStatus;
  readonly acceptTime?: string;
  readonly refusalTime?: string;
  readonly refusalReasonCode?: string;
  readonly refusalRemark?: string | null;
}

/**
 * 转移状态（34 §2.1 / AC-OF-08 / 09 / 17）：转已接受必填接受时间；转已拒绝必填拒绝时间与原因、备注选填。
 * 已拒绝退回待发回到“未发起审批”（R2e4）；其余转移不动审批子状态（已发 → 待发原站未取证，保持原值）。
 */
export function planOfferTransition(
  offer: OfferStateFacts,
  target: OfferStatus,
  form: OfferTransitionForm,
): OfferPlan<OfferTransitionPatch> {
  const guard = transitionGuard(offer, target);
  if (guard) return reject(guard);
  if (target === 'accepted') {
    if (blank(form.acceptTime)) return reject('OFFER_FORM_INCOMPLETE', ['acceptTime']);
    return { ok: true, patch: { status: 'accepted', acceptTime: form.acceptTime! } };
  }
  if (target === 'rejected') {
    const missing = (['refusalTime', 'refusalReasonCode'] as const).filter((field) => blank(form[field]));
    if (missing.length) return reject('OFFER_FORM_INCOMPLETE', missing);
    const refusalRemark = blank(form.refusalRemark) ? null : form.refusalRemark!;
    return {
      ok: true,
      patch: {
        status: 'rejected',
        refusalTime: form.refusalTime!,
        refusalReasonCode: form.refusalReasonCode!,
        refusalRemark,
      },
    };
  }
  if (target === 'onboarded') return { ok: true, patch: { status: 'onboarded' } };
  return offer.status === 'rejected'
    ? { ok: true, patch: { status: 'pending', approvalStatus: 'unsubmitted' } }
    : { ok: true, patch: { status: 'pending' } };
}

/** 失效入口（OF-R7，DEC-529② / DEC-533①）：已发、已接受、非实习类待发可失效，不看审批状态；实习待发、已拒绝不提供。 */
export function offerInvalidatable(offer: Pick<OfferStateFacts, 'status' | 'offerType'>): boolean {
  if (offer.status === 'sent' || offer.status === 'accepted') return true;
  return offer.status === 'pending' && effectiveOfferType(offer.offerType) !== 'intern';
}

export interface OfferInvalidationForm {
  readonly reasonCode?: string | null | undefined;
  readonly remark?: string | null | undefined;
}

export interface OfferInvalidationPatch {
  readonly status: 'invalid';
  readonly invalidReasonCode: string;
  readonly invalidRemark: string | null;
}

/** 失效（R2e6，DEC-537）：原因必填、备注选填；有待入职时由服务层同事务经端口删除待入职。 */
export function planOfferInvalidation(
  offer: OfferStateFacts,
  form: OfferInvalidationForm,
): OfferPlan<OfferInvalidationPatch> {
  if (!offerInvalidatable(offer)) return reject('OFFER_INVALIDATION_NOT_ALLOWED');
  if (blank(form.reasonCode)) return reject('OFFER_FORM_INCOMPLETE', ['reasonCode']);
  const invalidRemark = blank(form.remark) ? null : form.remark!;
  return { ok: true, patch: { status: 'invalid', invalidReasonCode: form.reasonCode!, invalidRemark } };
}

/**
 * OF-R3「发送前须审批通过」：开关按 Offer 类型设置，出厂都关（本租户各类型都未要求，34 §7）。
 * 发送动作在 BE-14b；本段只给拦截判定：只有待发能发送，审批中不能发送，开关开着时须审批通过。
 */
export const OFFER_SEND_APPROVAL_KEY = 'offer.send_requires_approval';
export type OfferSendApprovalSetting = Readonly<Record<OfferType, boolean>>;
export const OFFER_SEND_APPROVAL_DEFAULT: OfferSendApprovalSetting = { social: false, campus: false, intern: false };

export function validOfferSendApprovalSetting(value: unknown): value is OfferSendApprovalSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length === OFFER_TYPES.length &&
    entries.every(([type, on]) => (OFFER_TYPES as readonly string[]).includes(type) && typeof on === 'boolean')
  );
}

export function planOfferSend(
  offer: Pick<OfferStateFacts, 'status' | 'approvalStatus' | 'offerType'>,
  setting: OfferSendApprovalSetting,
): OfferPlan<null> {
  if (offer.status !== 'pending') return reject('OFFER_NOT_PENDING');
  if (offer.approvalStatus === 'approving') return reject('OFFER_APPROVAL_IN_PROGRESS');
  if (setting[effectiveOfferType(offer.offerType)] && offer.approvalStatus !== 'approved')
    return reject('OFFER_APPROVAL_REQUIRED');
  return { ok: true, patch: null };
}

/** 发送 / 重发（OF-R5）：待发按 OF-R3 判定后发送，已发直接重发（发送时已过审批判定）；其他状态不能发送。 */
export function planOfferDispatch(
  offer: Pick<OfferStateFacts, 'status' | 'approvalStatus' | 'offerType'>,
  setting: OfferSendApprovalSetting,
): OfferPlan<{ readonly kind: 'send' | 'resend' }> {
  if (offer.status === 'sent') return { ok: true, patch: { kind: 'resend' } };
  const plan = planOfferSend(offer, setting);
  return plan.ok ? { ok: true, patch: { kind: 'send' } } : plan;
}

/**
 * OF-R3 / OF-R4 必审字段：按 Offer 类型设置，只能是非必填字段（OF-R3）；出厂都为空。必审字段只在该类型开了
 * “发送前须审批”时起作用（开启后才能设置，OF-R3；两项配置分属两个键，消费方一并判断）。
 */
export const OFFER_REVIEW_FIELDS_KEY = 'offer.review_fields';
export type OfferReviewFieldsSetting = Readonly<Record<OfferType, readonly OfferField[]>>;
export const OFFER_REVIEW_FIELDS_DEFAULT: OfferReviewFieldsSetting = { social: [], campus: [], intern: [] };

export function validOfferReviewFieldsSetting(value: unknown): value is OfferReviewFieldsSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== OFFER_TYPES.length) return false;
  return entries.every(([type, fields]) => {
    if (!(OFFER_TYPES as readonly string[]).includes(type) || !Array.isArray(fields)) return false;
    const required = offerRequiredFields(type as OfferType);
    return (
      new Set(fields).size === fields.length &&
      fields.every((field) => (OFFER_FIELDS as string[]).includes(field) && !required.includes(field))
    );
  });
}

/**
 * OF-R4 前半：审批通过后修改了必审字段，旧的“审批通过”作废、回到未发起审批，须重新审批（发送判定因此不会复用旧结果）。
 * 返回要写回的审批子状态；不需要改返回 null。“审批通过允许再次发起”开关的两条分支见 reapprovalAfterEdit（BE-14b3）。
 */
export function approvalAfterEdit(
  offer: Pick<OfferStateFacts, 'approvalStatus' | 'offerType'>,
  changed: readonly OfferField[],
  sendApproval: OfferSendApprovalSetting,
  reviewFields: OfferReviewFieldsSetting,
): OfferApprovalStatus | null {
  if (offer.approvalStatus !== 'approved') return null;
  const type = effectiveOfferType(offer.offerType);
  if (!sendApproval[type]) return null;
  return changed.some((field) => reviewFields[type].includes(field)) ? 'unsubmitted' : null;
}

/**
 * OF-R9 / OF-R4 两个联动开关（BE-14b3，同一配置键）：
 * - entryCancelRejects（OF-R9，出厂开）：待入职取消入职后，把已发 / 已接受的 Offer 改为已拒绝；
 * - reapprovalAllowed（OF-R4「审批通过允许再次发起审批」，出厂开，原站默认未知取不破坏数据的一侧）：开 → 原 Offer 回到待发 / 未发起审批，
 *   已有待入职则取消入职；关 → 失效原 Offer 并复制一份新 Offer。
 */
export const OFFER_LINKAGE_KEY = 'offer.linkage';
export interface OfferLinkageSetting {
  readonly entryCancelRejects: boolean;
  readonly reapprovalAllowed: boolean;
}
export const OFFER_LINKAGE_DEFAULT: OfferLinkageSetting = { entryCancelRejects: true, reapprovalAllowed: true };

export function validOfferLinkageSetting(value: unknown): value is OfferLinkageSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 2 && typeof v.entryCancelRejects === 'boolean' && typeof v.reapprovalAllowed === 'boolean'
  );
}

/** OF-R9 的消费判定：开关开，且 Offer 在已发 / 已接受（有待入职的只可能是这两个状态，待发的待入职是 OF-R4 取消的）。 */
export const offerRejectsOnEntryCancel = (setting: OfferLinkageSetting, offer: Pick<OfferStateFacts, 'status'>) =>
  setting.entryCancelRejects && (offer.status === 'sent' || offer.status === 'accepted');

/** 再次发起审批的处理（OF-R4）：不用重审 / 原 Offer 回待发重审（restart）/ 失效并复制新 Offer（replace）。 */
export type OfferReapproval = 'none' | 'restart' | 'replace';
export function reapprovalAfterEdit(
  offer: Pick<OfferStateFacts, 'approvalStatus' | 'offerType'>,
  changed: readonly OfferField[],
  sendApproval: OfferSendApprovalSetting,
  reviewFields: OfferReviewFieldsSetting,
  linkage: OfferLinkageSetting,
): OfferReapproval {
  if (approvalAfterEdit(offer, changed, sendApproval, reviewFields) === null) return 'none';
  return linkage.reapprovalAllowed ? 'restart' : 'replace';
}

/** 系统失效（OF-R4 关分支）用的原因编码：不在两项人工失效字典里，备注写明缘由。 */
export const OFFER_REAPPROVAL_INVALID_REASON = 'reapproval_replaced';
/** 系统联动拒绝（OF-R9）用的拒绝原因：字典里的“其他原因”。 */
export const OFFER_ENTRY_CANCEL_REFUSAL_REASON = 'other';

/** 拒绝原因（A37，R2e4 5 项）与失效原因（R2e6 2 项）两个字典的预置项。 */
export const OFFER_DICTIONARY_KINDS = ['refusal-reasons', 'invalid-reasons'] as const;
export type OfferDictionaryKind = (typeof OFFER_DICTIONARY_KINDS)[number];
export const OFFER_DICTIONARY_PRESETS: readonly { kind: OfferDictionaryKind; code: string; name: string }[] = [
  { kind: 'refusal-reasons', code: 'compensation', name: '薪酬福利不满意' },
  { kind: 'refusal-reasons', code: 'growth', name: '发展空间受限' },
  { kind: 'refusal-reasons', code: 'better_offer', name: '有更好的工作机会' },
  { kind: 'refusal-reasons', code: 'personal', name: '个人原因' },
  { kind: 'refusal-reasons', code: 'other', name: '其他原因' },
  { kind: 'invalid-reasons', code: 'candidate_gave_up', name: '候选人放弃' },
  { kind: 'invalid-reasons', code: 'background_check_failed', name: '背调不通过' },
];
