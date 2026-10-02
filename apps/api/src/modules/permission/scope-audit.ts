import { and, auditEvents, eq, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { ModuleScope } from './module-access.js';

export const hasCreatorScope = (scope: ModuleScope) =>
  scope.terms?.some((term) => term.dimension === 'using_user') ?? false;

/** 创建审计不可变，作为没有物理 created_by 列的版本化实体的可靠创建人来源。 */
export function creatorSql(tenantId: string, id: SQL, action: string, objectType: string): SQL {
  return sql`(SELECT a.actor_user_id FROM audit_events a WHERE a.tenant_id=${tenantId}
    AND a.object_id=${id}::text AND a.action=${action} AND a.object_type=${objectType}
    ORDER BY a.occurred_at,a.id LIMIT 1)`;
}

export async function creatorOf(tx: Tx, tenantId: string, id: string, action: string, objectType: string) {
  const [row] = await tx
    .select({ userId: auditEvents.actorUserId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.objectId, id),
        eq(auditEvents.action, action),
        eq(auditEvents.objectType, objectType),
      ),
    )
    .orderBy(auditEvents.occurredAt, auditEvents.id)
    .limit(1);
  return row?.userId;
}
