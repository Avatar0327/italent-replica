/**
 * Offer 对象的纯规则（R2 BE-14a C1，DEC-581；docs/02_业务建模/34 §2.1、OF-R1 / R12，DEC-527③ / 532⑤）。
 * 本段只有对象本身：状态与审批子状态的取值、字段集、按类型必填、可编辑判定、两项转移按钮的编码与两个原因字典。
 * 状态转移、失效、行操作矩阵与 OF-R3 在 C2（BE-14a2），审批类型在 BE-14a3。
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

/**
 * 转移状态的两项按钮权限（R2e5，DEC-533④）：列表级在顶部工具栏，行级在行主按钮；本段只登记授权项，
 * 转移入口随 C2（BE-14a2）接入。
 */
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

/** 拒绝时间 / 原因 / 备注：退回待发后保留不清空，详情与编辑只在“已拒绝”时显示（DEC-532①；转移表单带出原值随 C2）。 */
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
}

/** 编辑、删除只限待发且不在审批中（已发 / 已接受的“编辑并同步”归 BE-14b）。 */
export const offerEditable = (offer: OfferStateFacts) =>
  offer.status === 'pending' && offer.approvalStatus !== 'approving';

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
