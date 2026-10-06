import { and, auditObjectCreators, eq, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { ModuleScope } from './module-access.js';

export const hasCreatorScope = (scope: ModuleScope) =>
  scope.terms?.some((term) => term.dimension === 'using_user') ?? false;

/**
 * 没有物理 created_by 列的版本化实体，创建人取对象的首个新增事件。DEC-198 起改读最小元数据表 audit_object_creators
 * （对象、创建人、创建时间；由审计新增事件触发写入，迁移 0050 回填历史），审计本身可按保留期整条清理。
 */
export function creatorSql(tenantId: string, id: SQL, action: string, objectType: string): SQL {
  return sql`(SELECT a.creator_user_id FROM audit_object_creators a WHERE a.tenant_id=${tenantId}
    AND a.object_id=${id}::text AND a.action=${action} AND a.object_type=${objectType}
    ORDER BY a.created_at LIMIT 1)`;
}

export async function creatorOf(tx: Tx, tenantId: string, id: string, action: string, objectType: string) {
  const [row] = await tx
    .select({ userId: auditObjectCreators.creatorUserId })
    .from(auditObjectCreators)
    .where(
      and(
        eq(auditObjectCreators.tenantId, tenantId),
        eq(auditObjectCreators.objectId, id),
        eq(auditObjectCreators.action, action),
        eq(auditObjectCreators.objectType, objectType),
      ),
    )
    .orderBy(auditObjectCreators.createdAt)
    .limit(1);
  return row?.userId;
}
