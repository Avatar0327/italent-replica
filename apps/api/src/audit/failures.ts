/**
 * 失败命令三类审计（AGENTS.md §10「审计」；PR #1 Codex 审计第三轮第 1 条转入 R1-T16，docs/08_设计/R1-T00 §8）。
 * 判定规则与平台命令共用（@italent/db command-failure.ts）：
 * - 业务失败：返回原错误；
 * - 存储不可写：返回 503 STORAGE_UNWRITABLE；结果未知：返回 503 RESULT_UNKNOWN，客户端按原命令 ID 回查（DEC-067）。
 *   这两类以 CommandFailureError 抛出并携带分类，调用方（调度器、逐条回执）据此区分“确定失败”与“结果未知 /
 *   存储故障”，不能只看它是不是应用错误（PR #75 第二轮 P2-8）。
 * 业务写入已整体回滚，失败审计在独立事务里另写一条；审计库也写不进去时落到兜底通道（结构化进程日志），
 * 两边用同一个预生成的事件编号，仍按三类标注，不伪造、不丢弃。同一请求只记一次：执行器记过的，入口兜底不再记。
 */
import {
  type CommandFailure,
  type CommandFailureInput,
  connectionCode,
  type Db,
  insertCommandFailure,
  pgErrorCode,
  withTenant,
} from '@italent/db';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { auditActor } from '../system-actor.js';
import { currentAuditRequest } from './request-context.js';

export { classifyCommandFailure, type CommandFailure, type CommandPhase } from '@italent/db';

/** 存储不可写或结果未知：仍是 503 应用错误（HTTP 映射不变），但带着分类，调用方不得当作确定的业务失败。 */
export class CommandFailureError extends AppError {
  constructor(
    readonly failure: CommandFailure,
    commandId: string,
  ) {
    const unknown = failure.outcome === 'unknown';
    super(
      'SERVICE_UNAVAILABLE',
      unknown ? '提交结果未知，请按原命令 ID 回查后再决定是否重提' : '存储暂时不可写，请稍后按原命令 ID 重提',
      unknown ? { reason: 'RESULT_UNKNOWN', commandId } : { reason: 'STORAGE_UNWRITABLE' },
    );
    this.name = 'CommandFailureError';
  }
}

/** 确定的业务失败（可据此记“失败”）；存储不可写、结果未知与非应用错误都不是。 */
export function isDefiniteFailure(error: unknown): error is AppError {
  return error instanceof AppError && !(error instanceof CommandFailureError);
}

/** 返回给客户端的错误：业务失败保持原错误；另两类统一 503，带机器可读的原因（AGENTS.md §10「错误」）。 */
export function failureResponse(error: unknown, failure: CommandFailure, commandId: string): unknown {
  return failure.outcome === 'business_failed' ? error : new CommandFailureError(failure, commandId);
}

export type AuditFallbackRecord = CommandFailureInput & {
  readonly id: string;
  readonly occurredAt: Date;
  readonly storageError: string;
};

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
  if (request) request.state.failureRecorded = true;
  const entry = {
    id: randomUUID(),
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
