import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError, type ErrorCode } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { recordAudit } from '../../audit/record.js';
import type { ForeignField } from './foreign-fields.js';

/**
 * 用户 / 租户 ID 按数据库 UUID 语义规范化（与 R6-1 派单闸锁键同口径）：入参已校验为 8-4-4-4-12 的十六进制写法，
 * 规范形式即小写。审批模块在入口统一规范化，大小写不同的同一 UUID 在比较、去重、一人一票计数时都是同一个人
 * （F-003 第二轮 P2-1）。
 */
export function canonicalId(id: string): string {
  return id.toLowerCase();
}

/** 按用户解析某业务对象的可查看字段（undefined = 全部可见）；由路由用授权器注入。 */
export interface FieldAccess {
  viewable(tx: Tx, userId: string, objectCode: string): Promise<ReadonlySet<string> | undefined>;
  /** 载荷中嵌套的其他对象字段（foreign-fields.ts）；未提供时按看不到处理。 */
  foreignVisible?(tx: Tx, userId: string, field: ForeignField): Promise<boolean>;
}

/** 审批命令上下文：时钟与命令 ID 由路由注入，事件时间存 UTC（DEC-056）。 */
export interface ApprovalContext extends TenantContext {
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
  /** 同人自动跳过前要按候选审批人的当前字段权限做盲审（清单 5）；未注入时按看不到处理（fail-closed）。 */
  readonly fields?: FieldAccess;
  /** 合同重提在 openOwn 已按员工→业务→实例加锁后，再复核当前功能/人员/字段权限。 */
  readonly recheckContractResubmit?: (tx: Tx, instanceId: string, corrections: Row) => Promise<void>;
  /** 审计与日志记录的操作人；系统自动处理（如成员停用时的接管，DEC-123）可为平台操作人或空。缺省为 userId。 */
  readonly actorUserId?: string | null;
  /**
   * DEC-258：撤回 / 驳回 / 不同意使原部门超编时的单次确认，只由路由从请求体设置并透传到任职状态机；
   * 缺省未确认，不影响审批通过的严格兜底。
   */
  readonly establishmentConfirmed?: boolean;
}

export function actorOf(ctx: ApprovalContext): string | null {
  return ctx.actorUserId === undefined ? ctx.userId : ctx.actorUserId;
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
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: actorOf(ctx),
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
