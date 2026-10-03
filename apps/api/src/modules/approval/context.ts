import { randomUUID } from 'node:crypto';
import { auditEvents, sql, type Tx } from '@italent/db';
import { AppError, type ErrorCode } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';

/** 审批命令上下文：时钟与命令 ID 由路由注入，事件时间存 UTC（DEC-056）。 */
export interface ApprovalContext extends TenantContext {
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

export type Row = Record<string, unknown>;

export function rowsOf<T = Row>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** 机器可读的审批错误原因放在 details.reason，客户端不解析中文文案（AGENTS §10「错误」）。 */
export function approvalError(code: ErrorCode, reason: string, message: string, extra: Row = {}): AppError {
  return new AppError(code, message, { reason, ...extra });
}

export function assertRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new AppError('REVISION_CONFLICT', '审批数据已变更，请刷新后显式重提', { expected, actual });
  }
}

function changed(before: Row | null, after: Row | null): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

/** 字段级审计 + outbox 事件，与业务写入同事务（AGENTS §10「审计」「事件」）。 */
export async function auditApproval(
  tx: Tx,
  ctx: ApprovalContext,
  entry: { action: string; objectType: string; objectId: string; before: Row | null; after: Row | null },
): Promise<void> {
  const keys = changed(entry.before, entry.after);
  const pick = (value: Row | null) => (value ? Object.fromEntries(keys.map((key) => [key, value[key] ?? null])) : null);
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    before: pick(entry.before),
    after: pick(entry.after),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

export async function emitOutbox(
  tx: Tx,
  ctx: ApprovalContext,
  event: { objectType: string; objectId: string; eventType: string; revision: number },
): Promise<void> {
  await tx.execute(sql`INSERT INTO approval_outbox
    (id,tenant_id,object_type,object_id,event_type,revision,command_id,created_at)
    VALUES (${randomUUID()},${ctx.tenantId},${event.objectType},${event.objectId}::uuid,${event.eventType},
      ${event.revision},${ctx.commandId},${ctx.now.toISOString()})`);
}
