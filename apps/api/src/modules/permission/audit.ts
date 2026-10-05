/**
 * 权限模块的审计与领域事件：与业务写在同一租户事务内写入（AGENTS.md §10「审计」「事件」）。
 * 权限模块的每一次写都经 audit()，因此审计与 outbox 不会只写一边；消费者按游标拉取 permission_outbox。
 */
import { auditEvents, permissionOutbox, type Tx } from '@italent/db';

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
  await tx.insert(auditEvents).values({
    tenantId: write.tenantId,
    actorUserId: write.userId,
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
