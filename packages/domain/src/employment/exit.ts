/**
 * 离职（R2-T03）的纯数据常量：三个字典的种类与预置项、自助子集编码、租户配置项。
 * docs/08_设计/R2-T03_离职管理设计.md §2.1 / §2.2 / §4B。
 */

/** 字典种类（路径参数 `:dict`）→ 表名；离职字典不混用调动类型（§2.1）。 */
export const EXIT_DICTIONARIES = {
  types: 'exit_types',
  reasons: 'exit_reasons',
  whereabouts: 'exit_whereabouts',
} as const;
export type ExitDictionaryKind = keyof typeof EXIT_DICTIONARIES;
export const EXIT_DICTIONARY_KINDS = Object.keys(EXIT_DICTIONARIES) as ExitDictionaryKind[];

export interface ExitDictionaryPreset {
  readonly kind: ExitDictionaryKind;
  readonly code: string;
  readonly name: string;
}

/**
 * 预置项（§2.1）：离职原因、离职去向是自助子集依赖的编码（§4B）；离职类型两项使 confirmed 前“离职类型必填”开箱可用。
 * 编码保存后不可改、字典不提供删除，所以这些编码在租户里一直存在（可被停用、改名）。
 */
export const EXIT_DICTIONARY_PRESETS: readonly ExitDictionaryPreset[] = [
  { kind: 'types', code: 'voluntary', name: '主动离职' },
  { kind: 'types', code: 'involuntary', name: '被动离职' },
  { kind: 'reasons', code: 'personal', name: '个人原因' },
  { kind: 'reasons', code: 'family', name: '家庭原因' },
  { kind: 'whereabouts', code: 'other_industry', name: '离职去其他行业' },
  { kind: 'whereabouts', code: 'same_industry', name: '离职去同行业' },
  { kind: 'whereabouts', code: 'startup', name: '自主创业' },
];

/** 本人申请 / 经理代发只能选的离职原因（DEC-283；缺省 personal）与离职去向（三选一），§4B。 */
export const EXIT_SELF_REASON_CODES = ['personal', 'family'] as const;
export const EXIT_SELF_WHEREABOUTS_CODES = ['other_industry', 'same_industry', 'startup'] as const;

/** 职责转交时机（DEC-213）：离职生效时 / 审批通过时；创建离职单时快照到 exit_requests.duty_transfer_timing。 */
export const EXIT_DUTY_TRANSFER_TIMINGS = ['business_effective', 'approval_passed'] as const;
export type ExitDutyTransferTiming = (typeof EXIT_DUTY_TRANSFER_TIMINGS)[number];

/** 租户配置项（两层配置，系统值随迁移下发；§2.2）。 */
export const EXIT_SETTINGS = {
  'exit.duty_transfer_timing': {
    default: 'business_effective' as ExitDutyTransferTiming,
    valid: (value: unknown): boolean =>
      typeof value === 'string' && (EXIT_DUTY_TRANSFER_TIMINGS as readonly string[]).includes(value),
  },
} as const;
export type ExitSettingKey = keyof typeof EXIT_SETTINGS;
export const EXIT_SETTING_KEYS = Object.keys(EXIT_SETTINGS) as ExitSettingKey[];

/**
 * 经理代发租户开关（§4B，默认 false）：key 由 B2a 定义，系统值 seed 与管理页由 F-020 做；
 * 没有系统行时按未开启处理，只认租户的有效覆盖。
 */
export const EXIT_MANAGER_INITIATION_KEY = 'exit.manager_initiation_enabled';

/** 离职扩展行上的业务字段（字段权限登记到任职记录对象，§4A / §9；lastWorkDate / reasonCode 已有）。 */
export const EXIT_REQUEST_FIELDS = [
  'exitTypeCode',
  'whereaboutsCode',
  'handoverEmployeeId',
  'addToBlacklist',
  'blacklistExpiryDate',
  'blacklistReason',
  'blacklistNote',
  'compensationAmount',
  'nonCompeteAmount',
  'lastPayDate',
  'socialInsuranceEndMonth',
  'annualLeaveSettled',
  'taxPeriod',
  'taxYear',
  'employerName',
  'actualLeaveDate',
  'attachmentRefs',
] as const;

/** 加黑三项（BE-8b1）：只存离职扩展行、生效时写名单，不进审批表单（审批人只看“是否加入黑名单”，原因与说明不披露给审批节点）。 */
export const EXIT_BLACKLIST_DETAIL_FIELDS: readonly string[] = [
  'blacklistExpiryDate',
  'blacklistReason',
  'blacklistNote',
];

/** 审批表单里的离职扩展字段（LEAVE_FORM 与审批适配器 exitMetadata 共用；附件引用不进表单，§9）。 */
export const EXIT_FORM_FIELDS: readonly string[] = [
  'reasonCode',
  ...EXIT_REQUEST_FIELDS.filter((field) => field !== 'attachmentRefs' && !EXIT_BLACKLIST_DETAIL_FIELDS.includes(field)),
];

/** 系统写入、只可查看的离职字段：发起人账号、批次、编制预减时点、转交时机快照（§2.1）。 */
export const EXIT_REQUEST_SYSTEM_FIELDS = [
  'initiatorUserId',
  'batchId',
  'preReleaseDate',
  'dutyTransferTiming',
] as const;

/** 离职四个按钮（§4A）：直接离职 / 离职申请 / 编辑离职 / 撤销离职。 */
export const EXIT_BUTTONS = {
  direct: 'Employment.Dimission',
  application: 'Employment.DimissionApproval',
  edit: 'Employment.DimissionEdit',
  cancel: 'Employment.DimissionCancel',
} as const;

/** 退休四个按钮（R2-T04 §3.1，DEC-637 A-2）：退休 / 退休申请 / 编辑退休 / 撤销退休；独立授权，不复用 Dimission*。 */
export const RETIREMENT_BUTTONS = {
  direct: 'Employment.Retire',
  application: 'Employment.RetireApproval',
  edit: 'Employment.RetireEdit',
  cancel: 'Employment.RetireCancel',
} as const;

/** 离职 / 退休共用一个门禁，按业务类型取按钮（门禁、撤销、预览都经这一个入口）。 */
export const buttonsOf = (kind: 'leave' | 'retirement' | string) =>
  kind === 'retirement' ? RETIREMENT_BUTTONS : EXIT_BUTTONS;
