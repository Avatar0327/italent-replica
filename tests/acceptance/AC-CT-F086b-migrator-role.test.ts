/**
 * F-086b：为什么升级迁移用例只在本地真 PG 失败——迁移角色受 FORCE RLS 约束时，数据回填迁移的 SELECT 看不到任何租户行。
 * 本用例不依赖角色：按当前连接角色是否绕过 RLS，断言“不设 app.tenant_id 时表属主能看到几行”与之一致，
 * 并断言 skipUnlessMigratorBypassesRls 的判断与实测一致（CI 超级用户 → 看到全部；非超级用户 app_owner → 看到 0 行）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { migratorBypassesRls } from './support/migrator-role.js';

const database = useTestDb();

describe('AC-CT-F086b 迁移角色与行级安全', () => {
  it('不设 app.tenant_id 时，表属主看到的租户行数与“是否绕过 RLS”一致', async () => {
    const { db } = database();
    const session = await employmentSession(db, 'f086b-role');
    await session.org('合同部门', { establishedOn: '2025-01-01' });
    await session.employee();
    const tenantId = session.tenant.id;
    const visible = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT count(*)::int AS n FROM employment_employees WHERE tenant_id = ${tenantId}`,
      );
      return ((Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { n: number }[])[0]!.n;
    });
    expect(visible).toBeGreaterThan(0);
    const bare = await db.execute(
      sql`SELECT count(*)::int AS n FROM employment_employees WHERE tenant_id = ${tenantId}`,
    );
    const bareRows = (Array.isArray(bare) ? bare : (bare as { rows: unknown[] }).rows) as { n: number }[];
    expect(bareRows[0]!.n).toBe((await migratorBypassesRls(db)) ? visible : 0);
  });
});
