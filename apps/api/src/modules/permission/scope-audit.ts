import { and, auditObjectCreators, eq, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { ModuleScope } from './module-access.js';

export const hasCreatorScope = (scope: ModuleScope) =>
  scope.terms?.some((term) => term.dimension === 'using_user') ?? false;

/**
 * 没有物理 created_by 列的版本化实体，创建人取对象的首个新增事件。DEC-198 起改读最小元数据表 audit_object_creators
 * （对象、创建人、创建时间；由审计新增事件触发写入，迁移 0058 回填历史），审计本身可按保留期整条清理。
 */
export function creatorSql(tenantId: string, id: SQL, action: string, objectType: string): SQL {
  return firstCreatorSql(tenantId, id, action, objectType);
}

/**
 * 创建人子查询的唯一构造点：对象 id 表达式由调用方给出，常是外层查询的列（如 a.employee_id、r.id）。子查询用专属别名
 * creator_meta，不能再用 a / b / r 这类外层常见别名，否则内层遮住外层列，PostgreSQL 报 42703（BE-15b1 第 3 轮 P2-1）。
 * tenant 可以是租户 ID 参数，也可以是外层的租户列表达式。
 */
export function firstCreatorSql(tenant: string | SQL, objectId: SQL, action: string, objectType?: string): SQL {
  const type = objectType ? sql`AND creator_meta.object_type=${objectType}` : sql``;
  return sql`(SELECT creator_meta.creator_user_id FROM audit_object_creators creator_meta
    WHERE creator_meta.tenant_id=${tenant} AND creator_meta.object_id=${objectId}::text
    AND creator_meta.action=${action} ${type}
    ORDER BY creator_meta.created_at LIMIT 1)`;
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
