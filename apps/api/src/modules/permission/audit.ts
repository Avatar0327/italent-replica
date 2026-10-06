/**
 * 权限模块的审计与领域事件：与业务写在同一租户事务内写入（AGENTS.md §10「审计」「事件」）。
 * 权限模块的每一次写都经 audit()，因此审计与 outbox 不会只写一边；消费者按游标拉取 permission_outbox。
 */
import { permissionOutbox, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';

export interface WriteContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly now: Date;
  readonly commandId: string;
}

export interface AuditInput {
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly before: unknown;
  readonly after: unknown;
}

export async function audit(tx: Tx, write: WriteContext, entry: AuditInput): Promise<void> {
  await auditAs(tx, { ...write, actorUserId: write.userId }, entry);
}

/** 平台命令在租户内的写入（R1-T17 开通预置）：操作人是平台运营身份，系统任务为空，不必是租户成员。 */
export interface PlatformWriteContext extends Omit<WriteContext, 'userId'> {
  readonly actorUserId: string | null;
}

export async function auditAs(tx: Tx, write: PlatformWriteContext, entry: AuditInput): Promise<void> {
  await recordAudit(tx, {
    tenantId: write.tenantId,
    actorUserId: write.actorUserId,
    occurredAt: write.now,
    commandId: write.commandId,
    ...entry,
  });
  await tx.insert(permissionOutbox).values({
    tenantId: write.tenantId,
    objectType: entry.objectType,
    objectId: entry.objectId,
    eventType: entry.action,
    revision: revisionOf(entry.after),
    commandId: write.commandId,
    createdAt: write.now,
  });
}

function revisionOf(after: unknown): number | null {
  const revision = (after as { revision?: unknown } | null)?.revision;
  return typeof revision === 'number' && Number.isInteger(revision) ? revision : null;
}
