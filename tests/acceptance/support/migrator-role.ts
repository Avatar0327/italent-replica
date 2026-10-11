/**
 * F-086b：升级迁移用例（useTestDb({ migrateBefore }) 造旧结构数据、再补跑后续迁移）里的“数据回填”迁移，
 * 要求执行迁移的角色绕过行级安全：租户表都是 FORCE ROW LEVEL SECURITY，表属主不设 app.tenant_id 也只看到 0 行，
 * 回填就悄悄什么都不做（部署手册 06_部署/01 §2.1：升级迁移须用超级用户或带 BYPASSRLS 的专用升级角色）。
 * CI 的 PostgreSQL 与 PGlite 都是超级用户，天然满足；本地 dev-db.sh 的 app_owner 是非超级用户，故这类用例在那里会误报失败。
 * 这里按“当前连接角色是否绕过 RLS”决定是否运行：不满足就跳过并说明原因，不改变 CI 里的任何断言。
 */
import { type Db, sql } from '@italent/db';
import type { TestContext } from 'vitest';

export async function migratorBypassesRls(db: Db): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`,
  );
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { bypass: boolean }[];
  return rows[0]?.bypass === true;
}

/** 在升级用例开头调用：迁移角色受 RLS 约束时跳过本用例（CI 的超级用户连接照常运行）。 */
export async function skipUnlessMigratorBypassesRls(context: TestContext, db: Db): Promise<void> {
  if (await migratorBypassesRls(db)) return;
  context.skip(
    '迁移角色不绕过行级安全（如本地 dev-db.sh 的 app_owner）：数据回填迁移看不到租户行，需超级用户或 BYPASSRLS 连接（部署手册 §2.1）',
  );
}
