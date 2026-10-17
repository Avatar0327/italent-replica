/**
 * F-212（DEC-568）：CI 的“PostgreSQL 16 app_owner”分片用普通角色跑验收测试，本文件是它的守卫与反证。
 * 背景：超级用户连接绕过 RLS，测试里漏设租户上下文（裸 db.transaction / 裸连接读写）在超级用户分片永远是绿的，
 * F-209 / F-210 / F-211 连续三批都是这样漏过去的。
 *
 * - 守卫：分片设了 REQUIRE_APP_ROLE=1 时，当前连接必须是非超级用户、NOBYPASSRLS 的真 PG 角色，否则判红；
 *   没设时（PGlite、超级用户分片、本地）只在连接确为普通角色时运行反证，其余跳过。
 * - 反证：同一张租户表，没设租户上下文（等同“去掉一处 withTenant”）读不到行、写被 RLS 拒绝；
 *   补上 withTenant 则读写正常。这正是该分片能把漏设租户上下文的用例变红的机制。
 */
import { sql, withPlatform, withTenant } from '@italent/db';
import { pgErrorCode, testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from './support/f048.js';

const testDb = useTestDb();
const requireAppRole = process.env.REQUIRE_APP_ROLE === '1';

async function connectionRole(): Promise<{ user: string; bypass: boolean }> {
  const result = await testDb().db.execute(sql`
    SELECT current_user AS "user", (rolsuper OR rolbypassrls) AS "bypass" FROM pg_roles WHERE rolname = current_user`);
  const [row] = rowsOf<{ user: string; bypass: boolean }>(result);
  if (!row) throw new Error('查不到当前连接角色');
  return row;
}

describe('AC-CI-F212 / DEC-568 普通角色分片守卫', () => {
  it('分片要求普通角色时：真 PG 连接，且不是超级用户、没有 BYPASSRLS', async (context) => {
    if (!requireAppRole) context.skip('未设 REQUIRE_APP_ROLE=1（普通角色分片才设）');
    expect(testDbMode(), 'REQUIRE_APP_ROLE=1 却在 PGlite 上跑').toBe('pg');
    expect(await connectionRole()).toEqual({ user: 'app_owner', bypass: false });
  });

  it('反证：普通角色下，没设租户上下文读不到租户行、写入被 RLS 拒绝；withTenant 内正常', async (context) => {
    if (testDbMode() !== 'pg' || (await connectionRole()).bypass) {
      if (requireAppRole) throw new Error('REQUIRE_APP_ROLE=1，但当前连接不是普通角色，反证无法成立');
      context.skip('当前连接绕过 RLS（PGlite / 超级用户），反证只在普通角色下成立');
    }
    const { db } = testDb();
    const { tenantId, userId } = await withPlatform(db, async (tx) => {
      const tenant = rowsOf<{ id: string }>(
        await tx.execute(sql`INSERT INTO tenants (code, name) VALUES ('f212', 'F-212 合成租户') RETURNING id`),
      );
      const user = rowsOf<{ id: string }>(
        await tx.execute(
          sql`INSERT INTO users (email, display_name) VALUES ('f212@example.com', 'F-212 合成用户') RETURNING id`,
        ),
      );
      return { tenantId: tenant[0]!.id, userId: user[0]!.id };
    });
    const insertMembership = sql`INSERT INTO tenant_memberships (tenant_id, user_id) VALUES (${tenantId}, ${userId})`;

    // 去掉 withTenant：裸事务写入，WITH CHECK 要求 tenant_id = current_tenant_id()，未设租户时拒绝（42501）
    const bare = await db.transaction((tx) => tx.execute(insertMembership)).catch((error: unknown) => error);
    expect(pgErrorCode(bare)).toBe('42501');

    await withTenant(db, tenantId, (tx) => tx.execute(insertMembership));

    const countSql = sql`SELECT count(*)::int AS n FROM tenant_memberships`;
    const bareCount = await db.transaction(async (tx) => rowsOf<{ n: number }>(await tx.execute(countSql)));
    expect(bareCount[0]?.n, '裸事务应读不到任何租户行（fail-closed）').toBe(0);
    const scopedCount = await withTenant(db, tenantId, async (tx) => rowsOf<{ n: number }>(await tx.execute(countSql)));
    expect(scopedCount[0]?.n).toBe(1);
  });
});
