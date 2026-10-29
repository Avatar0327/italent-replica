import { and, auditObjectCreators, eq, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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
 * 创建人子查询的公共构造函数（编制重放 establishment-replay.ts 仍保留独立内联查询）。
 * 对象 id 与 tenant 均可引用外层列；避开输入表达式已有的层级别名，防止嵌套时遮蔽外层，造成 42703 或静默错绑
 * （BE-15b1 第 3 轮 P2-1、F-232）。tenant 也可以直接传租户 ID 参数。
 */
export function firstCreatorSql(tenant: string | SQL, objectId: SQL, action: string, objectType?: string): SQL {
  // 只检查 SQL 文本、不检查绑定值；稳定后缀保留同形查询的预备语句复用，避免随机别名。
  const inputSql = new PgDialect().sqlToQuery(sql`${tenant} ${objectId}`).sql.toLowerCase();
  let level = 1;
  while (inputSql.includes(`creator_meta_${level}`)) level += 1;
  const meta = sql.identifier(`creator_meta_${level}`);
  const type = objectType ? sql`AND ${meta}.object_type=${objectType}` : sql``;
  return sql`(SELECT ${meta}.creator_user_id FROM audit_object_creators ${meta}
    WHERE ${meta}.tenant_id=${tenant} AND ${meta}.object_id=${objectId}::text
    AND ${meta}.action=${action} ${type}
    ORDER BY ${meta}.created_at LIMIT 1)`;
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
