/**
 * 测试专用夹具 tenant_probe：一张最小的租户数据表，只在测试中建，不进产品迁移。
 * 用于在组织对象（R1-T03）落地前验证租户隔离（AC-TEN-01/02）。
 * 隔离策略复用产品迁移里的 enable_tenant_isolation()，与真实业务表完全同一套写法。
 */
import { type Db, sql } from '@italent/db';
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const tenantProbe = pgTable('tenant_probe', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  revision: integer('revision').notNull().default(1),
});

/** 以连接角色（测试中为超级用户）建表、启用隔离并授权给 app_user。幂等。 */
export async function installTenantProbe(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS tenant_probe (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        name text NOT NULL,
        revision integer NOT NULL DEFAULT 1
      )`);
    const [policy] = rowsOf(await tx.execute(sql`SELECT 1 FROM pg_policy WHERE polrelid = 'tenant_probe'::regclass`));
    if (!policy) await tx.execute(sql`SELECT enable_tenant_isolation('tenant_probe')`);
    await tx.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_probe TO app_user`);
  });
}

function rowsOf(result: unknown): unknown[] {
  // postgres-js 直接返回数组，PGlite 返回 { rows }
  return Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
}
