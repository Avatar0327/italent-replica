/**
 * AC-DM-30-F493-31 ④⑤（F-493 S1，设计 §3.5 / §4.2）：登录名可空后，账号开通路径不得产生“无登录名”的新账号。
 * ④ 已绑定的账号登录名为 NULL 且成员关系被移出：办理入职不带登录邮箱 → 409 ACCOUNT_LOGIN_MISSING，整单回滚；
 *    带另一个登录邮箱 → 409 USER_REBIND_FORBIDDEN，不新建账号。
 * ⑤ 开通函数 tenant_provision_account 登录名为 NULL → check_violation（不是静默零行），users 不出现空登录名行。
 */
import { eq, sql, users, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { getTenantUser, hrApi, reasonOf, syntheticEmail } from './AC-PRM-users-support.js';

const testDb = useTestDb();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('AC-DM-30-F493-31 ④ 已绑定账号登录名为空时办理入职', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
  });

  const counts = async (employeeId: string, tenantId: string) => {
    const { db } = testDb();
    const accounts = await withPlatform(db, async (tx) =>
      rowsOf<{ n: string }>(await tx.execute(sql`SELECT count(*) AS n FROM users`)),
    );
    const audits = await withPlatform(db, async (tx) =>
      rowsOf<{ n: string }>(
        await tx.execute(sql`SELECT count(*) AS n FROM platform_audit_events WHERE action='user.create'`),
      ),
    );
    const own = await withTenant(db, tenantId, async (tx) =>
      rowsOf<{ n: string; states: string | null }>(
        await tx.execute(sql`SELECT count(*) AS n,
            (SELECT string_agg(s.state, ',' ORDER BY s.event_no) FROM employment_state_events s
              WHERE s.tenant_id=${tenantId} AND s.employee_id=${employeeId}::uuid) AS states
          FROM employment_business_objects WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid`),
      ),
    );
    return { users: Number(accounts[0]!.n), userCreateAudits: Number(audits[0]!.n), businesses: own[0] };
  };

  it('入职不带登录邮箱 → 409 ACCOUNT_LOGIN_MISSING 且整单回滚；带另一邮箱 → 409 USER_REBIND_FORBIDDEN', async () => {
    const { db } = testDb();
    const employee = await hr.employee('空登录名人员', syntheticEmail('login-missing'));
    const bound = await withTenant(db, world.tenant.id, async (tx) =>
      rowsOf<{ user_id: string }>(
        await tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE employee_id=${employee.id}::uuid`),
      ),
    );
    const userId = bound[0]!.user_id;
    // 可信夹具：账号登录名置空（真实场景由 F-493 S2 导入产生）；再由管理员移出租户成员关系
    await withPlatform(db, (tx) => tx.update(users).set({ email: null }).where(eq(users.id, userId)));
    const member = await getTenantUser(world, userId);
    const removed = await world.api.request('POST', `${BASE}/users/${userId}/remove`, {
      ...world.asAdmin,
      ifMatch: member.membershipRevision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);

    const departmentId = await hr.org('空登录名部门');
    const before = await counts(employee.id, world.tenant.id);
    const current = await hr.getEmployee(employee.id);
    const missing = await hr.hire(current, departmentId);
    expect(await reasonOf(missing)).toMatchObject({ status: 409, reason: 'ACCOUNT_LOGIN_MISSING' });
    expect(await counts(employee.id, world.tenant.id)).toEqual(before);
    expect(await getTenantUser(world, userId)).toMatchObject({ membershipStatus: 'revoked', email: '' });

    const rebind = await hr.hire(await hr.getEmployee(employee.id), departmentId, {
      loginEmail: 'syn.e@example.com',
    });
    expect(await reasonOf(rebind)).toMatchObject({ status: 409, reason: 'USER_REBIND_FORBIDDEN' });
    expect(await counts(employee.id, world.tenant.id)).toEqual(before);
  });
});

describe('AC-DM-30-F493-31 ⑤ 开通函数拒绝空登录名', () => {
  it('tenant_provision_account(NULL, …) 抛 check_violation；users 不出现空登录名行', async () => {
    const { db } = testDb();
    const world = await seedPermissionWorld(db);
    const before = await withPlatform(db, async (tx) =>
      rowsOf<{ n: string }>(await tx.execute(sql`SELECT count(*) AS n FROM users WHERE email IS NULL`)),
    );
    const rejected = await withTenant(db, world.tenant.id, (tx) =>
      tx.execute(
        sql`SELECT * FROM tenant_provision_account(NULL::text, '合成空登录名', ${world.asAdmin.user}::uuid, 'f493s1-31-5')`,
      ),
    ).then(
      () => null,
      (error: { cause?: { code?: string } }) => error.cause?.code ?? 'unknown',
    );
    expect(rejected).toBe('23514');
    const after = await withPlatform(db, async (tx) =>
      rowsOf<{ n: string }>(await tx.execute(sql`SELECT count(*) AS n FROM users WHERE email IS NULL`)),
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
