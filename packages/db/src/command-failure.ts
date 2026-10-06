/**
 * 失败命令三类（AGENTS.md §10「审计」；R1-T16，DEC-199）：租户命令（apps/api commands.ts）与平台命令
 * （runPlatformCommand）共用同一判定，平台命令的失败写平台层受限通道 platform_command_failures。
 * - 业务失败：应用错误（带字符串 code 与数值 status 的错误，如 AppError / 各模块同形错误）、并发与幂等冲突，
 *   以及执行阶段其余确定已回滚的错误；
 * - 存储不可写：执行阶段的存储 / 连接错误（磁盘满、只读、连接中断），事务必然回滚；
 * - 结果未知：提交阶段连接中断、回查台账也查不到（或回查本身失败），可能已提交。
 */
import { pgErrorCode } from './pg-error.js';

export type CommandFailureOutcome = 'business_failed' | 'storage_unwritable' | 'unknown';
export type CommandPhase = 'execute' | 'commit';

export interface CommandFailure {
  readonly outcome: CommandFailureOutcome;
  readonly errorCode: string;
  readonly reason: string | null;
}

/** SQLSTATE 类别：08 连接异常、53 资源不足（磁盘满、内存不足）、57 运维干预（关库、崩溃恢复）、58 系统 / I/O 错误。 */
const STORAGE_CLASSES = new Set(['08', '53', '57', '58']);
const STORAGE_STATES = new Set(['25006']); // read_only_sql_transaction
const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'CONNECTION_ENDED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

/** 已分类过的失败（执行器包装后再抛出的错误）直接沿用原分类，调用方据此区分“确定失败”与“结果未知”。 */
export interface ClassifiedFailure {
  readonly failure: CommandFailure;
}

export function isClassifiedFailure(error: unknown): error is ClassifiedFailure {
  const failure = (error as { failure?: unknown } | null)?.failure as CommandFailure | undefined;
  return typeof failure?.outcome === 'string' && typeof failure.errorCode === 'string';
}

export function classifyCommandFailure(error: unknown, phase: CommandPhase, recheckFailed = false): CommandFailure {
  if (isClassifiedFailure(error)) return error.failure;
  const business = businessCode(error);
  if (business) return { outcome: 'business_failed', ...business };
  const sqlState = pgErrorCode(error);
  const connection = connectionCode(error);
  if (phase === 'commit' && (recheckFailed || !sqlState || sqlState.startsWith('08') || sqlState.startsWith('57'))) {
    return { outcome: 'unknown', errorCode: sqlState ?? connection ?? 'UNKNOWN', reason: null };
  }
  if (sqlState && (STORAGE_STATES.has(sqlState) || STORAGE_CLASSES.has(sqlState.slice(0, 2)))) {
    return { outcome: 'storage_unwritable', errorCode: sqlState, reason: null };
  }
  if (!sqlState && connection) return { outcome: 'storage_unwritable', errorCode: connection, reason: null };
  return { outcome: 'business_failed', errorCode: sqlState ?? 'INTERNAL_ERROR', reason: null };
}

/** 应用错误：字符串 code + 数值 status（AppError、EmploymentError 等）；冲突错误类按名称识别（同包定义，避免循环引用）。 */
function businessCode(error: unknown): { errorCode: string; reason: string | null } | undefined {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'RevisionConflictError') return { errorCode: 'REVISION_CONFLICT', reason: null };
  if (name === 'IdempotencyConflictError') return { errorCode: 'IDEMPOTENCY_CONFLICT', reason: null };
  const shaped = error as { code?: unknown; status?: unknown; details?: unknown } | null;
  if (!(error instanceof Error) || typeof shaped?.status !== 'number' || typeof shaped.code !== 'string') {
    return undefined;
  }
  const reason = (shaped.details as { reason?: unknown } | undefined)?.reason;
  return { errorCode: shaped.code, reason: typeof reason === 'string' ? reason : null };
}

export function connectionCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_CODES.has(code)) return code;
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && /connection (terminated|closed|ended|reset)/i.test(message)) {
      return 'CONNECTION_LOST';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
