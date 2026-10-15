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

/** 离职扩展行上的业务字段（字段权限登记到任职记录对象，§4A / §9；lastWorkDate / reasonCode 已有）。 */
export const EXIT_REQUEST_FIELDS = [
  'exitTypeCode',
  'whereaboutsCode',
  'handoverEmployeeId',
  'addToBlacklist',
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
