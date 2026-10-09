/**
 * 《R3-T04/T05 同步协议》v4 的纯数据部分（docs/08_设计/R3-T04-T05_同步协议.md SP-05、SP-12、SP-14、SP-15）：
 * 值、run、消费协议与健康度的类型，以及回执组合表（SP-14 R1～R14、R4a、R4b）与状态转换（SP-12）的判定。
 * 放在领域层是因为 T05 的纯规则（条件行编译、批次规划）同样要用；端口接口与替身在
 * apps/api/src/modules/talent-review/sync-port.ts，由那里统一再导出，消费方只从那里引用。
 */
import type { IsoDate } from '../tenant-time.js';
import type { PlainValue } from '../expression/values.js';

// ---- 基本值（SP-05、SP-17）----
export type PortScalar = Exclude<PlainValue, undefined>;
/** 多选 = 选项 value 数组（SP-17），不提供任何拼接形式。 */
export type PortValue = PortScalar | readonly string[];
export type FieldStatus = 'value' | 'empty' | 'forbidden' | 'unavailable';
export interface FieldRead {
  readonly status: FieldStatus;
  readonly value: PortValue | null;
}
export interface ReviewFieldDescriptor {
  readonly code: string;
  readonly label: string;
  readonly group: string;
  readonly kind: 'number' | 'text' | 'option' | 'multi_option' | 'date' | 'boolean';
  readonly precision?: number;
  readonly pairRole?: 'before' | 'after';
  readonly pairFieldCode?: string;
  readonly systemWritten: boolean;
  /** 选项 value 一律 string。 */
  readonly optionDomain?: readonly { readonly value: string; readonly label: string; readonly enabled: boolean }[];
  /** multi_option 恒 false（SP-17，DEC-314②）。 */
  readonly formulaUsable: boolean;
}
export type SourceTier = 1 | 2 | 3;
export interface ReviewSource {
  readonly projectId: string;
  readonly meetingId: string | null;
  readonly tier: SourceTier;
  readonly businessDate: IsoDate | null;
}
export interface ReviewSourceContext {
  readonly triggerProjectId?: string;
  readonly triggerMeetingId?: string;
  readonly asOf: IsoDate;
}
export type SourceViewer =
  { readonly kind: 'principal'; readonly userId: string } | { readonly kind: 'user'; readonly userId: string };

// ---- run（SP-02～SP-04）----
export type ObjectStatus = 'initial' | 'in_flow' | 'flow_ended' | 'calibrating' | 'calibrated' | 'terminated';
export interface SyncRunHeader {
  readonly runId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly ownerOrgId: string;
  readonly trigger: 'sync_requested';
  readonly businessDate: IsoDate;
  readonly principalUserId: string;
  readonly actorUserId: string;
  readonly ownerUserId: string;
  readonly manualOverride: boolean;
  readonly scopeOrgIds: readonly string[];
  readonly scopeExplicit: boolean;
  readonly frozenAt: Date;
  readonly status: 'frozen' | 'superseded';
  readonly supersededByRunId: string | null;
  readonly objectCount: number;
  readonly nominationCount: number;
  readonly orgHealthCount: number;
  readonly excludedCount: number;
}
export interface SyncMatrixPlacement {
  readonly matrixId: string;
  readonly cellBefore: number | null;
  readonly cellAfter: number | null;
  readonly placement: number | null;
  readonly countsGreen: boolean | null;
}
export interface SyncObjectResult {
  readonly objectId: string;
  readonly employeeId: string;
  readonly status: ObjectStatus;
  readonly syncEligible: boolean;
  readonly blockReason: 'in_flow' | 'terminated' | null;
  readonly fields: Readonly<Record<string, FieldRead>>;
  readonly matrices: readonly SyncMatrixPlacement[];
  readonly calibrated: boolean;
  readonly resultSeq: number;
  readonly resultAt: Date;
  readonly successionModule: 'absent' | 'present';
}
export interface SyncNomination {
  readonly nominationId: string;
  readonly objectId: string;
  readonly employeeId: string;
  readonly kind: 'org' | 'position';
  readonly direction: 'successor' | 'target';
  readonly orgId: string | null;
  readonly positionId: string | null;
  /** target 方向 = 被盘点人本人。 */
  readonly successorEmployeeId: string;
  readonly readinessId: string | null;
  readonly readinessCode: string | null;
  readonly sortNo: number;
  readonly createdAt: Date;
  readonly syncEligible: boolean;
  readonly formValues: Readonly<Record<string, FieldRead>>;
}
export interface SyncOrgHealth {
  readonly orgId: string;
  readonly meetingId: string | null;
  readonly levelId: string | null;
  readonly levelCode: string | null;
  readonly manual: boolean;
  readonly status: 'value' | 'empty' | 'not_provided' | 'forbidden';
  readonly succession: {
    readonly status: 'module_absent' | 'present';
    readonly count: number;
    readonly nominations: readonly SyncNomination[];
  };
}
export interface SuccessionReadResult {
  readonly employeeId: string | null;
  readonly orgId: string | null;
  readonly positionId: string | null;
  /** value 时 nominations 可为空数组（零提名），与 module_absent 分开（A-19）。 */
  readonly status: 'value' | 'module_absent' | 'forbidden' | 'unavailable';
  readonly nominations: readonly SyncNomination[];
  readonly source: ReviewSource | null;
}
export interface ReviewFieldReadResult {
  readonly values: Readonly<Record<string, FieldRead>>;
  readonly source: ReviewSource | null;
}
export interface GreenRateResult {
  /** value = 有可读来源；unavailable = 没有来源；forbidden = 查看人无权读该组织（数值为 0 / null，不带来源）。 */
  readonly status: 'value' | 'unavailable' | 'forbidden';
  readonly green: number;
  readonly placed: number;
  /** 分母 0 或缺参考九宫格 → null（DEC-305④）。 */
  readonly rate: number | null;
  readonly source: (ReviewSource & { readonly matrixId: string }) | null;
}

// ---- 目标（SP-10）----
export type SyncTargetKind = 'org' | 'position';
/** 稳定目标键 = 种类 + 规范化小写 UUID（DEC-194）。 */
export type SyncTargetKey = `${SyncTargetKind}:${string}`;
export type SyncTargetAction = 'append' | 'overwrite' | 'scope_overwrite' | 'delete_only';
export interface SyncTargetRegistration {
  readonly targetKey: SyncTargetKey;
  readonly action: SyncTargetAction;
  readonly nominationIds: readonly string[];
}

// ---- 消费协议（SP-08～SP-13）----
export const SYNC_CONSUMERS = ['succession', 'talent_pool'] as const;
export type SyncConsumer = (typeof SYNC_CONSUMERS)[number];
export const ROW_KINDS = ['nomination', 'object', 'org_health', 'target'] as const;
export type RowKind = (typeof ROW_KINDS)[number];
export type RowStatus = 'pending' | 'synced' | 'failed' | 'skipped' | 'superseded' | 'aborted';
export type RowRecovery = 'none' | 'retry_same_run';
export type RunRecovery = 'retry_same_run' | 'terminate' | 'new_run';
export interface ConsumptionCounts {
  readonly pending: number;
  readonly synced: number;
  /** 全部 failed 行（含 failedRetry）。 */
  readonly failed: number;
  /** failed ∧ recovery = retry_same_run（阻止完成，SP-12）。 */
  readonly failedRetry: number;
  readonly skipped: number;
  readonly superseded: number;
  readonly aborted: number;
}
export interface ConsumptionState {
  readonly runId: string;
  readonly consumer: SyncConsumer;
  readonly status: 'running' | 'completed' | 'aborted' | 'superseded';
  readonly executionNo: number;
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
  readonly targetsSealed: boolean;
  readonly targetCount: number;
  readonly terminalCode: SyncErrorCode | null;
  readonly terminalRecovery: Exclude<RunRecovery, 'retry_same_run'> | null;
  readonly counts: ConsumptionCounts;
}
export interface OutcomeItem {
  readonly rowKind: RowKind;
  /** nomination: nominationId；object: objectId；org_health: orgId；target: SyncTargetKey。 */
  readonly rowId: string;
  readonly status: RowStatus;
  readonly recovery: RowRecovery;
  readonly errorCode?: SyncErrorCode;
  readonly errorParams?: Readonly<Record<string, unknown>>;
  readonly executionNo: number | null;
  readonly pageCommandId: string | null;
  readonly updatedAt: Date;
}
export interface PageCommit {
  readonly runId: string;
  readonly consumer: string;
  readonly executionNo: number;
  readonly pageNo: number;
  readonly pageCommandId: string;
  /** plan = 计划已提交（pageNo = 0）；execute = 本页目标已执行（pageNo ≥ 1）。 */
  readonly kind: 'plan' | 'execute';
  readonly rowCount: number;
  readonly committedAt: Date;
}
export interface SourceReadAuthorization {
  readonly ok: boolean;
  readonly runStatus: 'frozen' | 'superseded';
  readonly reason?: 'PRINCIPAL_UNAVAILABLE' | 'OWNER_UNAVAILABLE' | 'PROJECT_INVISIBLE';
  readonly forbidden: {
    readonly objectIds: readonly string[];
    /** 对象 ID → 本页请求字段中被撤权的字段编码。 */
    readonly fields: Readonly<Record<string, readonly string[]>>;
    readonly sources: readonly { readonly objectId: string; readonly source: string }[];
    readonly orgIds: readonly string[];
    /** 组织 ID → 本页请求字段中被撤权的健康度字段（健康度页只给组织与字段时，SP-14 R7 字段撤权据此执行）。 */
    readonly orgFields: Readonly<Record<string, readonly string[]>>;
  };
}

/** SP-14 全表：写回执的码、不写回执的码与入口拒绝码；契约测试逐码断言。 */
export const SYNC_ERROR_CODES = [
  // 写回执（R1～R14）
  'SUBJECT_IN_PROCESS',
  'READINESS_UNKNOWN',
  'SUCCESSOR_NOT_ACTIVE',
  'READINESS_DISABLED',
  'TARGET_NOT_FOUND',
  'TARGET_OUT_OF_SCOPE',
  'TARGET_NOT_KEY_POSITION',
  'TARGET_PARTIAL_NOMINATIONS',
  'SOURCE_REVOKED',
  'HEALTH_LEVEL_UNKNOWN',
  'HEALTH_LEVEL_DISABLED',
  'STORAGE_UNAVAILABLE',
  'NOMINATIONS_FAILED',
  'SCOPE_REQUIRED',
  'ACTOR_SCOPE_EXCEEDED',
  'UNSUPPORTED_TRIGGER',
  'ABORTED_BY_ADMIN',
  'RUN_SUPERSEDED',
  // 不写回执
  'SOURCE_UNAVAILABLE',
  'PRINCIPAL_UNAVAILABLE',
  'OWNER_UNAVAILABLE',
  'PROJECT_INVISIBLE',
  'RULE_CACHE_STALE',
  'BATCH_IN_PROGRESS',
  'CONSUMPTION_LEASED',
  'EXECUTION_INACTIVE',
  'TARGETS_ALREADY_SEALED',
  'TARGETS_NOT_SEALED',
  'PENDING_ROWS_REMAIN',
  'RETRYABLE_ROWS_REMAIN',
  'ROW_FINAL',
  'OUTCOME_NOT_ALLOWED',
  // 入口拒绝
  'INVALID_OVERRIDE',
  'SYNC_PRINCIPAL_UNAVAILABLE',
  'BATCH_SCOPE_EXCEEDS_REQUESTER',
  'RUN_NOT_RETRYABLE',
  'TARGET_SYNC_IN_PROGRESS',
  // 健康度（SP-15）与公式（SP-17）
  'HEALTH_COMPUTE_UNAVAILABLE',
  'MULTI_OPTION_IN_FORMULA',
  // 健康度回写命令台账同键异内容（SP-16 第 3 条）
  'IDEMPOTENCY_CONFLICT',
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

// ---- 健康度（SP-15 / SP-16）----
export interface HealthLevel {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly color: string;
  readonly sortNo: number;
  readonly enabled: boolean;
}
/** 完整定位一条健康度：项目级 meetingId = null。 */
export interface OrgHealthContext {
  readonly projectId: string;
  readonly meetingId: string | null;
}
/** 导入凭据随 F-050 延期（DEC-311②），本版不定义。 */
export type HealthCredential =
  | {
      readonly kind: 'compute';
      readonly principalUserId: string;
      readonly calcRunId: string;
      readonly commandId: string;
    }
  | { readonly kind: 'assign'; readonly userId: string; readonly commandId: string }
  | { readonly kind: 'reset'; readonly userId: string; readonly commandId: string };
export interface OrgHealthRowWrite {
  readonly orgId: string;
  readonly levelId: string | null;
  readonly levelCode: string | null;
  readonly status: 'value' | 'empty';
  /** 逐组织预期版本；该组织尚无行时传 0。 */
  readonly expectedRevision: number;
}
export interface OrgHealthWriteCommand {
  readonly tenantId: string;
  readonly context: OrgHealthContext;
  readonly credential: Extract<HealthCredential, { kind: 'compute' | 'assign' }>;
  readonly rows: readonly OrgHealthRowWrite[];
}
export interface OrgHealthResetCommand {
  readonly tenantId: string;
  readonly context: OrgHealthContext;
  readonly credential: Extract<HealthCredential, { kind: 'reset' }>;
  readonly rows: readonly OrgHealthRowWrite[];
}
/** 盘点侧健康度行的当前状态（可辨识联合）：forbidden 不带存在性、版本与值。 */
export type OrgHealthRowState =
  | { readonly status: 'forbidden'; readonly orgId: string; readonly context: OrgHealthContext }
  | { readonly status: 'absent'; readonly orgId: string; readonly context: OrgHealthContext; readonly revision: 0 }
  | {
      readonly status: 'value' | 'empty';
      readonly orgId: string;
      readonly context: OrgHealthContext;
      readonly levelId: string | null;
      readonly levelCode: string | null;
      readonly manual: boolean;
      readonly method: 'computed' | 'manual';
      readonly revision: number;
    };
export type OrgHealthOutcome =
  'written' | 'unchanged' | 'MANUAL_KEPT' | 'REVISION_CONFLICT' | 'PROJECT_ENDED' | 'OUT_OF_SCOPE' | 'FORBIDDEN';
export interface OrgHealthWriteReceipt {
  readonly items: readonly {
    readonly orgId: string;
    readonly outcome: OrgHealthOutcome;
    readonly currentRevision: number;
    readonly currentLevelId: string | null;
    readonly currentManual: boolean;
  }[];
}
