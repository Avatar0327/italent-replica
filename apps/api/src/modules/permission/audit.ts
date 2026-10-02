/** 权限模块的审计：与业务写在同一租户事务内写入（AGENTS.md §10「审计」）。 */
import { auditEvents, type Tx } from '@italent/db';

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
}
