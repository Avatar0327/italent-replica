/**
 * 兼职（BE-7）的契约常量（docs/08_设计/R2-T05_兼职设计.md §1 / §4 / §7）。兼职底层业务的 kind 只出现在数据库与兼职模块，
 * 不加进 BusinessKind（§3.2：加入会牵动 20 余处穷举，通用任职入口的入参枚举因此天然拒绝 part_time）。
 * 数据库 CHECK 与这里的取值逐一对应（packages/db/src/schema/part-time.ts、employment.ts）。
 */

/** 兼职记录的底层业务类型（employment_records.kind / employment_payload_versions.kind）。 */
export const PART_TIME_KIND = 'part_time';

/** 任职类型（原站 ServiceType 主职 0 / 兼职 1 / 借调 4 / 外派 5，`31` Q-M0-121①）；“返聘 3”不在兼职下拉，不建。 */
export const SERVICE_TYPES = ['primary', 'part_time', 'secondment', 'expatriate'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
/** 兼职表单“兼职类型 / 任职类型”的取值（创建后不可改，`15` §6）。 */
export const PART_TIME_SERVICE_TYPES = ['part_time', 'secondment', 'expatriate'] as const;
export type PartTimeServiceType = (typeof PART_TIME_SERVICE_TYPES)[number];

/** 期限链每一期的来源（§1.2）。 */
export const PART_TIME_TERM_SOURCES = ['create', 'edit', 'extend', 'end', 'batch_end', 'transfer', 'exit'] as const;
export type PartTimeTermSource = (typeof PART_TIME_TERM_SOURCES)[number];
/** 只有系统联动（离职 / 调动）可以写空区间期（end = start − 1，“未开始即终止”），人工入口要求 end ≥ start。 */
export const PART_TIME_EMPTY_TERM_SOURCES: readonly PartTimeTermSource[] = ['exit', 'transfer'];

/** 兼职申请（原站 ParttimeJobApproval，§1.4）：新增 / 延长 / 结束。 */
export const PART_TIME_REQUEST_TYPES = ['add', 'extend', 'end'] as const;
export type PartTimeRequestType = (typeof PART_TIME_REQUEST_TYPES)[number];
/** 发起方式：self / manager 入口由 F-020 做（DEC-200 / 283），复刻服务层预留。 */
export const PART_TIME_INITIATORS = ['hr', 'self', 'manager'] as const;
/** 申请状态与任职业务同一集合（§2.2）。 */
export const PART_TIME_REQUEST_STATES = [
  'draft',
  'in_review',
  'approved',
  'rejected',
  'disapproved',
  'voided',
  'effective',
  'deleted',
] as const;
export type PartTimeRequestState = (typeof PART_TIME_REQUEST_STATES)[number];
export type PartTimeInitiator = (typeof PART_TIME_INITIATORS)[number];
/** 作废原因（voided 事件必填）：HR 撤销 / 离职 / 调动 / 提交后目标被改 / 落地复核不通过。 */
export const PART_TIME_VOID_REASONS = ['hr', 'exit', 'transfer', 'changed_since_submit', 'landing_rejected'] as const;
export type PartTimeVoidReason = (typeof PART_TIME_VOID_REASONS)[number];
/** 站内消息模板（approval_notifications.template_code）：申请被离职作废 / 落地复核不通过而作废，通知发起人。 */
export const PART_TIME_NOTICE_TEMPLATES = {
  voidedByExit: 'part_time_request_voided_by_exit',
  voided: 'part_time_request_voided',
} as const;
/** 延长 / 结束备注上限（原站计数器 0/32766）。 */
export const PART_TIME_REMARK_MAX = 32766;

/** 审计 / outbox 对象类型（§7.4）。 */
export const PART_TIME_AUDIT_OBJECTS = { record: 'employment-part-time', request: 'part-time-request' } as const;

/** 任职记录对象上的兼职按钮（§7.2；原站编码未取证，B-9，复刻自定）。 */
export const PART_TIME_BUTTONS = {
  direct: 'Employment.PartTime',
  application: 'Employment.PartTimeApproval',
  extend: 'Employment.PartTimeExtend',
  end: 'Employment.PartTimeEnd',
  batchEnd: 'Employment.PartTimeBatchEnd',
  edit: 'Employment.PartTimeEdit',
} as const;
/** 可授编辑的兼职字段（申请字段编码 = 任职记录字段编码，PT-R4）。 */
export const PART_TIME_FIELDS = ['partTimeType', 'endDate', 'requestRemark'] as const;
/** 系统字段，只可授查看：原定结束日期（申请版本）、任职状态与视图归属（按期限链派生）。 */
export const PART_TIME_SYSTEM_FIELDS = ['originalEndDate', 'serviceStatus', 'partTimeView'] as const;

/** 机器可读的业务拒绝原因（`details.reason`）；各批次入口按 §4 使用。 */
export const PART_TIME_ERRORS = {
  endBeforeStart: 'PART_TIME_END_BEFORE_START',
  endDateRequired: 'PART_TIME_END_DATE_REQUIRED',
  beforeEntry: 'PART_TIME_BEFORE_ENTRY',
  exclusiveTypeExists: 'PART_TIME_EXCLUSIVE_TYPE_EXISTS',
  primaryNotActive: 'PART_TIME_PRIMARY_NOT_ACTIVE',
  beyondExit: 'PART_TIME_BEYOND_EXIT',
  afterExit: 'PART_TIME_AFTER_EXIT',
  spansPendingExit: 'PART_TIME_SPANS_PENDING_EXIT',
  openEnded: 'PART_TIME_OPEN_ENDED',
  notExtended: 'PART_TIME_NOT_EXTENDED',
  endAfterCurrent: 'PART_TIME_END_AFTER_CURRENT',
  requestInProgress: 'PART_TIME_REQUEST_IN_PROGRESS',
  alreadyEnded: 'PART_TIME_ALREADY_ENDED',
  recordNotFound: 'PART_TIME_RECORD_NOT_FOUND',
  /** 编辑兼职：开始日期、任职类型创建后不可改（§5.1，A-9；日期沿用主职记录编辑同码）。 */
  dateImmutable: 'RECORD_DATE_IMMUTABLE',
  typeImmutable: 'PART_TIME_TYPE_IMMUTABLE',
  /** 批量结束：同一 recordId 重复（§4.4）。 */
  duplicateRecord: 'DUPLICATE_RECORD',
  linkageNotAvailable: 'PART_TIME_LINKAGE_NOT_AVAILABLE',
  requestTypeNotAvailable: 'PART_TIME_REQUEST_TYPE_NOT_AVAILABLE',
  /** 申请当前状态不允许该动作（如审批中不能直接修改）。 */
  requestStateInvalid: 'PART_TIME_REQUEST_STATE_INVALID',
  /** 审批编辑带了适配器不接的字段。 */
  fieldNotEditable: 'PART_TIME_FIELD_NOT_EDITABLE',
  /** 提交 / 撤回只允许原发起人。 */
  notInitiator: 'PART_TIME_NOT_INITIATOR',
} as const;
