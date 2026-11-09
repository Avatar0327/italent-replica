/**
 * AC-DM-30-F493-35（F-493 S1，设计 §4.5）：用户管理列表与详情把“登录名”和“档案联系邮箱”分开显示。
 * email = 账号登录名（登录名为空显示空串）；contactEmail = 绑定人员档案最新版本里的电子邮件；外部用户为 null。
 */
import { eq, sql, users, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { hrApi, syntheticEmail, type TenantUserBody } from './AC-PRM-users-support.js';

const testDb = useTestDb();

type UserWithContact = TenantUserBody & { contactEmail: string | null };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('AC-DM-30-F493-35 用户管理：登录名与档案联系邮箱分开', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
  });

  const list = async () => {
    const response = await world.api.request('GET', `${BASE}/users?type=all&limit=200`, world.asAdmin);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: UserWithContact[] }).items;
  };
  const detail = async (userId: string) => {
    const response = await world.api.request('GET', `${BASE}/users/${userId}`, world.asAdmin);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as UserWithContact;
  };
  const boundUser = async (employeeId: string) =>
    (
      await withTenant(testDb().db, world.tenant.id, async (tx) =>
        rowsOf<{ user_id: string }>(
          await tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE employee_id=${employeeId}::uuid`),
        ),
      )
    )[0]!.user_id;
  /** 经人员档案接口写电子邮件（档案版本表不可变，写入口会追加新版本）。 */
  async function setArchiveEmail(employeeId: string, email: string) {
    const path = `/api/tenant/personnel/employees/${employeeId}`;
    const current = await hr.api.request('GET', path, world.asAdmin);
    expect(current.status, await current.clone().text()).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const response = await hr.api.request('PATCH', path, { ...world.asAdmin, ifMatch: revision, body: { email } });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  it('绑定账号：email = 虚拟登录名，contactEmail = 档案电子邮件；列表与详情一致', async () => {
    const login = syntheticEmail('virtual-login');
    const employee = await hr.employee('联系邮箱人员', login);
    await setArchiveEmail(employee.id, 'syn.d@example.com');
    const userId = await boundUser(employee.id);
    const row = (await list()).find((u) => u.userId === userId)!;
    expect(row).toMatchObject({ email: login, contactEmail: 'syn.d@example.com' });
    expect(await detail(userId)).toMatchObject({ email: login, contactEmail: 'syn.d@example.com' });
  });

  it('登录名为空的账号：email = 空串（只作显示），contactEmail 仍取档案', async () => {
    const employee = await hr.employee('空登录名人员', syntheticEmail('null-login'));
    await setArchiveEmail(employee.id, 'syn.f@example.com');
    const userId = await boundUser(employee.id);
    await withPlatform(testDb().db, (tx) => tx.update(users).set({ email: null }).where(eq(users.id, userId)));
    expect(await detail(userId)).toMatchObject({ email: '', contactEmail: 'syn.f@example.com' });
    expect((await list()).find((u) => u.userId === userId)).toMatchObject({ email: '' });
  });

  it('外部用户没有人员档案：contactEmail = null', async () => {
    const response = await world.api.request('POST', `${BASE}/users`, {
      ...world.asAdmin,
      body: { email: syntheticEmail('ext'), displayName: '外部联系人', userType: 'external', businessIdentity: '猎头' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as { userId: string };
    expect((await detail(created.userId)).contactEmail).toBeNull();
  });
});
