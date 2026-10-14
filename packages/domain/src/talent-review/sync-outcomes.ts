/**
 * 同步回执的纯规则：SP-14 回执组合表（R1～R14、R4a、R4b，穷举）与 SP-12 行状态转换、完成门槛。
 * T04 的 registerTargets / recordOutcome 在写入前逐行判定，不在表内的组合整调用拒绝（OUTCOME_NOT_ALLOWED）；
 * 替身与真实实现共用本文件，契约测试按组合逐条断言（SP-19 #16）。
 */
import type { ConsumptionCounts, OutcomeItem, RowKind, RowStatus, SyncErrorCode } from './sync-protocol.js';

/** 写入它的提交：计划 = registerTargets.planOutcomes；执行 = recordOutcome；终止 = T04 在 SP-04 / SP-13 收尾。 */
export type OutcomePhase = 'plan' | 'execute' | 'terminate';
/** 判定需要的行上下文：提名行的种类（TARGET_NOT_KEY_POSITION 只适用于职位目标）。 */
export interface OutcomeContext {
  nominationKind(nominationId: string): 'org' | 'position' | undefined;
}

type Item = Pick<OutcomeItem, 'rowKind' | 'rowId' | 'status' | 'recovery' | 'errorCode' | 'errorParams'>;
type FailedRule = {
  readonly kinds: readonly RowKind[];
  readonly phases: readonly OutcomePhase[];
  readonly recovery: readonly OutcomeItem['recovery'][];
  readonly check?: (item: Item, context: OutcomeContext) => boolean;
};

const PLAN: readonly OutcomePhase[] = ['plan'];
const BOTH: readonly OutcomePhase[] = ['plan', 'execute'];
const NONE = ['none'] as const;
const param = (item: Item, key: string) => item.errorParams?.[key];
const scopeIn =
  (...scopes: string[]) =>
  (item: Item) =>
    scopes.includes(String(param(item, 'scope'))) && typeof param(item, 'ref') === 'string';

/** failed 行的允许组合；同一个码可能有多条（如 TARGET_OUT_OF_SCOPE 的 R4 与 R4a）。 */
const FAILED_RULES: Partial<Record<SyncErrorCode, readonly FailedRule[]>> = {
  SUBJECT_IN_PROCESS: [{ kinds: ['nomination'], phases: PLAN, recovery: NONE }], // R1
  READINESS_UNKNOWN: [{ kinds: ['nomination'], phases: PLAN, recovery: NONE }], // R2
  SUCCESSOR_NOT_ACTIVE: [{ kinds: ['nomination'], phases: BOTH, recovery: NONE }], // R3
  READINESS_DISABLED: [{ kinds: ['nomination'], phases: BOTH, recovery: NONE }], // R3
  TARGET_NOT_FOUND: [
    { kinds: ['target', 'nomination'], phases: BOTH, recovery: NONE }, // R4
    { kinds: ['org_health'], phases: BOTH, recovery: NONE }, // R4b
  ],
  TARGET_OUT_OF_SCOPE: [
    { kinds: ['target', 'nomination'], phases: BOTH, recovery: NONE }, // R4
    { kinds: ['org_health'], phases: BOTH, recovery: NONE }, // R4a
  ],
  TARGET_NOT_KEY_POSITION: [
    {
      // R4：仅限职位目标；健康度行不允许（“不允许”行）
      kinds: ['target', 'nomination'],
      phases: BOTH,
      recovery: NONE,
      check: (item, context) =>
        item.rowKind === 'target'
          ? item.rowId.startsWith('position:')
          : context.nominationKind(item.rowId) === 'position',
    },
  ],
  TARGET_PARTIAL_NOMINATIONS: [
    {
      kinds: ['target', 'nomination'],
      phases: BOTH,
      recovery: NONE,
      check: (item) => Array.isArray(param(item, 'causeNominationIds')),
    },
  ], // R5
  SOURCE_REVOKED: [
    // R6
    { kinds: ['nomination', 'object'], phases: BOTH, recovery: NONE, check: scopeIn('object', 'field', 'source') },
    { kinds: ['org_health'], phases: BOTH, recovery: NONE, check: scopeIn('org', 'field') }, // R7
  ],
  HEALTH_LEVEL_UNKNOWN: [{ kinds: ['org_health'], phases: BOTH, recovery: NONE }], // R8
  HEALTH_LEVEL_DISABLED: [{ kinds: ['org_health'], phases: BOTH, recovery: NONE }], // R8
  STORAGE_UNAVAILABLE: [
    { kinds: ['target', 'nomination', 'org_health'], phases: ['execute'], recovery: ['retry_same_run'] },
  ], // R9
  NOMINATIONS_FAILED: [
    {
      kinds: ['object'],
      phases: BOTH,
      recovery: ['none', 'retry_same_run'],
      check: (item) => Array.isArray(param(item, 'codes')) && Array.isArray(param(item, 'nominationIds')),
    },
  ], // R10
};

/** R12：跳过原因与可用行种类。 */
const SKIP_REASONS: Readonly<Record<string, readonly RowKind[]>> = {
  // 对象只有 target 方向提名时，全部提名 skipped ⇒ 对象聚合同为 skipped（SP-12）
  direction_target: ['nomination', 'object'],
  object_terminated: ['nomination', 'object'],
  no_nominations: ['object'],
  not_provided: ['org_health'],
};

/** R13 / R14：终止阶段由 T04 写的码。 */
const ABORT_CODES: readonly SyncErrorCode[] = [
  'SCOPE_REQUIRED',
  'ACTOR_SCOPE_EXCEEDED',
  'UNSUPPORTED_TRIGGER',
  'ABORTED_BY_ADMIN',
];

/** 回执组合是否在 SP-14 表内。 */
export function outcomeAllowed(item: Item, phase: OutcomePhase, context: OutcomeContext): boolean {
  switch (item.status) {
    case 'synced': // R11
      return phase !== 'terminate' && item.recovery === 'none' && item.errorCode === undefined;
    case 'skipped': {
      // R12
      const kinds = SKIP_REASONS[String(param(item, 'reason'))];
      return (
        phase === 'plan' && item.recovery === 'none' && item.errorCode === undefined && !!kinds?.includes(item.rowKind)
      );
    }
    case 'aborted': // R13
      return phase === 'terminate' && item.recovery === 'none' && ABORT_CODES.includes(item.errorCode!);
    case 'superseded': // R14
      return phase === 'terminate' && item.recovery === 'none' && item.errorCode === 'RUN_SUPERSEDED';
    case 'failed':
      return (FAILED_RULES[item.errorCode!] ?? []).some(
        (rule) =>
          rule.kinds.includes(item.rowKind) &&
          rule.phases.includes(phase) &&
          rule.recovery.includes(item.recovery) &&
          (rule.check?.(item, context) ?? true),
      );
    default:
      return false; // pending 只由 T04 预建
  }
}

/** 行是否处于终态（synced / skipped / failed∧none / superseded / aborted）。 */
export function rowFinal(row: Pick<OutcomeItem, 'status' | 'recovery'>): boolean {
  if (row.status === 'pending') return false;
  return !(row.status === 'failed' && row.recovery === 'retry_same_run');
}

const sameOutcome = (a: Item, b: Item) =>
  a.status === b.status &&
  a.recovery === b.recovery &&
  (a.errorCode ?? null) === (b.errorCode ?? null) &&
  JSON.stringify(a.errorParams ?? null) === JSON.stringify(b.errorParams ?? null);

/**
 * SP-12 状态转换：pending / failed∧retry → 任一消费方状态；终态同值重写幂等（'same'），异值 ROW_FINAL。
 */
export function outcomeTransition(current: Item, next: Item): 'write' | 'same' | 'ROW_FINAL' {
  if (!rowFinal(current)) return 'write';
  return sameOutcome(current, next) ? 'same' : 'ROW_FINAL';
}

/** 消费记录计数（SP-12；failedRetry ⊆ failed）。 */
export function countOutcomes(rows: Iterable<Pick<OutcomeItem, 'status' | 'recovery'>>): ConsumptionCounts {
  const counts: Record<RowStatus | 'failedRetry', number> = {
    pending: 0,
    synced: 0,
    failed: 0,
    failedRetry: 0,
    skipped: 0,
    superseded: 0,
    aborted: 0,
  };
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.status === 'failed' && row.recovery === 'retry_same_run') counts.failedRetry += 1;
  }
  return counts;
}

/** 完成门槛（SP-12）：四类行都非 pending、没有 failed∧retry_same_run；未封存另报 TARGETS_NOT_SEALED。 */
export function completionBlocker(counts: ConsumptionCounts): 'PENDING_ROWS_REMAIN' | 'RETRYABLE_ROWS_REMAIN' | null {
  if (counts.pending > 0) return 'PENDING_ROWS_REMAIN';
  return counts.failedRetry > 0 ? 'RETRYABLE_ROWS_REMAIN' : null;
}

/** 稳定目标键：种类 + 规范化小写 UUID（SP-10，DEC-194）。 */
export const TARGET_KEY_PATTERN = /^(org|position):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 页命令身份（SP-11）：计划页 pageNo = 0，执行页 pageNo ≥ 1。 */
export const pageCommandIdOf = (runId: string, consumer: string, executionNo: number, pageNo: number) =>
  `${runId}:${consumer}:${executionNo}:${pageNo}`;
