/**
 * CI 守卫（硬规则 7；docs/07_M0/02_技术栈评估.md §8 R-2）：
 * public schema 中凡含 tenant_id 列的表，必须 ENABLE + FORCE ROW LEVEL SECURITY 且至少有一条策略；
 * 应用角色与平台角色都不得是超级用户或带 BYPASSRLS。新表漏配 RLS 时本测试失败。
 */
import { APP_ROLE, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();

interface TableRls {
  table: string;
  rls: boolean;
  forced: boolean;
  policies: number;
}

const tenantTablesQuery = sql`
  SELECT c.relname AS "table",
         c.relrowsecurity AS "rls",
         c.relforcerowsecurity AS "forced",
         (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS "policies"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     )
   ORDER BY c.relname`;

function rowsOf<T>(result: unknown): T[] {
  // postgres-js 直接返回数组，PGlite 返回 { rows }
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function violations(tables: TableRls[]): string[] {
  return tables.filter((t) => !t.rls || !t.forced || t.policies < 1).map((t) => t.table);
}

describe('守卫：带 tenant_id 的表必须启用并强制 RLS', () => {
  it('迁移后的所有租户表都已 ENABLE + FORCE RLS 且有策略', async () => {
    const tables = rowsOf<TableRls>(await testDb().db.execute(tenantTablesQuery));
    expect(tables.map((t) => t.table)).toEqual(
      expect.arrayContaining(['audit_events', 'command_ledger', 'tenant_memberships', 'tenant_setting_overrides']),
    );
    expect(violations(tables)).toEqual([]);
  });

  it('守卫本身有效：一张漏配 RLS 的新表会被查出来', async () => {
    const { db } = testDb();
    const found = await db
      .transaction(async (tx) => {
        await tx.execute(sql`CREATE TABLE guard_canary (id int, tenant_id uuid)`);
        const tables = rowsOf<TableRls>(await tx.execute(tenantTablesQuery));
        throw Object.assign(new Error('rollback'), { found: violations(tables) });
      })
      .catch((e: { found?: string[] }) => e.found);
    expect(found).toEqual(['guard_canary']);
  });

  it('应用角色与平台角色不是超级用户、没有 BYPASSRLS、不能登录', async () => {
    const roles = rowsOf<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      await testDb().db.execute(sql`
        SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
         WHERE rolname IN (${APP_ROLE.tenant}, ${APP_ROLE.platform}) ORDER BY rolname`),
    );
    expect(roles).toEqual([
      { rolname: APP_ROLE.platform, rolsuper: false, rolbypassrls: false, rolcanlogin: false },
      { rolname: APP_ROLE.tenant, rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);
  });
});
