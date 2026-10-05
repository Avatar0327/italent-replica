/**
 * 失败命令三类审计（AGENTS.md §10「审计」；PR #1 Codex 审计第三轮第 1 条转入 R1-T16，docs/08_设计/R1-T00 §8）。
 * - 业务失败：命令执行中抛出业务错误（或其他确定已回滚的错误），返回原错误；
 * - 存储不可写：执行阶段遇到存储 / 连接错误（磁盘满、只读、连接中断），事务必然回滚，返回 503 STORAGE_UNWRITABLE；
 * - 结果未知：提交阶段连接中断、回查台账也查不到（或回查本身失败），可能已提交，返回 503 RESULT_UNKNOWN，
 *   客户端按原命令 ID 回查后再决定是否重提（DEC-067）。
 * 业务写入已整体回滚，失败审计在独立事务里另写一条；审计库也写不进去时落到兜底通道（结构化进程日志），
 * 仍按三类标注，不伪造、不丢弃。
 */
import {
  type CommandFailureInput,
  type Db,
  IdempotencyConflictError,
  insertCommandFailure,
  pgErrorCode,
  RevisionConflictError,
  withTenant,
} from '@italent/db';
import type { CommandFailureOutcome } from '@italent/domain';
import { AppError } from '../errors.js';
import { auditActor } from '../system-actor.js';
import { currentAuditRequest } from './request-context.js';

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

export function classifyCommandFailure(error: unknown, phase: CommandPhase, recheckFailed = false): CommandFailure {
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

/** 返回给客户端的错误：业务失败保持原错误；另两类统一 503，带机器可读的原因（AGENTS.md §10「错误」）。 */
export function failureResponse(error: unknown, failure: CommandFailure, commandId: string): unknown {
  if (failure.outcome === 'storage_unwritable') {
    return new AppError('SERVICE_UNAVAILABLE', '存储暂时不可写，请稍后按原命令 ID 重提', {
      reason: 'STORAGE_UNWRITABLE',
    });
  }
  if (failure.outcome === 'unknown') {
    return new AppError('SERVICE_UNAVAILABLE', '提交结果未知，请按原命令 ID 回查后再决定是否重提', {
      reason: 'RESULT_UNKNOWN',
      commandId,
    });
  }
  return error;
}

export type AuditFallbackRecord = CommandFailureInput & { readonly occurredAt: Date; readonly storageError: string };

let fallbackSink: (record: AuditFallbackRecord) => void = (record) => {
  console.error(JSON.stringify({ type: 'audit.command_failure.fallback', ...record }));
};

/** 替换兜底通道（测试或接入外部日志系统）；返回恢复原通道的函数。 */
export function setAuditFallbackSink(sink: (record: AuditFallbackRecord) => void): () => void {
  const previous = fallbackSink;
  fallbackSink = sink;
  return () => {
    fallbackSink = previous;
  };
}

export async function recordCommandFailure(
  db: Db,
  ctx: { readonly tenantId: string; readonly userId: string },
  commandId: string,
  failure: CommandFailure,
): Promise<void> {
  const request = currentAuditRequest();
  const entry: CommandFailureInput & { occurredAt: Date } = {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    commandId,
    ...failure,
    method: request?.method ?? null,
    path: request?.path ?? null,
    occurredAt: request?.clock() ?? new Date(),
    ...(request ? { source: request.source } : {}),
  };
  try {
    await withTenant(db, ctx.tenantId, (tx) => insertCommandFailure(tx, entry));
  } catch (storageError) {
    fallbackSink({ ...entry, storageError: pgErrorCode(storageError) ?? connectionCode(storageError) ?? 'UNKNOWN' });
  }
}

/** 业务错误：AppError 及各模块自有的同形错误（如 EmploymentError：字符串 code + 4xx status），以及并发 / 幂等冲突。 */
function businessCode(error: unknown): { errorCode: string; reason: string | null } | undefined {
  if (error instanceof RevisionConflictError) return { errorCode: 'REVISION_CONFLICT', reason: null };
  if (error instanceof IdempotencyConflictError) return { errorCode: 'IDEMPOTENCY_CONFLICT', reason: null };
  const shaped = error as { code?: unknown; status?: unknown; details?: unknown } | null;
  const status = typeof shaped?.status === 'number' ? shaped.status : 0;
  const moduleError = error instanceof Error && status >= 400 && status < 500;
  if (!(error instanceof AppError) && !moduleError) return undefined;
  if (typeof shaped?.code !== 'string') return undefined;
  const reason = (shaped.details as { reason?: unknown } | undefined)?.reason;
  return { errorCode: shaped.code, reason: typeof reason === 'string' ? reason : null };
}

function connectionCode(error: unknown): string | undefined {
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
