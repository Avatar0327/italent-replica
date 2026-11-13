/**
 * AC-DM-30-F493-35（F-493 S1，设计 §4.5）：用户管理列表与详情把“登录名”和“档案联系邮箱”分开显示。
 * email = 账号登录名（登录名为空显示空串）；contactEmail = 绑定人员档案最新版本里的电子邮件；外部用户为 null。
 */
import { eq, sql, users, withPlatform, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { hrApi, memberWithAdminRole, syntheticEmail, type TenantUserBody } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

type UserWithContact = TenantUserBody & { contactEmail: string | null };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('AC-DM-30-F493-35 用户管理：登录名与档案联系邮箱分开', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;
  /** DEC-901：档案联系邮箱需人员对象查看 + 邮箱字段 + 数据范围，读取者按此授权（租户管理员本身不免权限）。 */
  let viewer: { user: string; tenant: string };
  let orgId: string;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
    orgId = await hr.org('联系邮箱范围内');
    const reader = await memberWithAdminRole(world, 'user_admin', 'f493-viewer');
    viewer = reader.as;
    const profile = await createProfile(world, `F493_${uniqueSuffix()}`);
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: ['name', 'email'].map((fieldCode) => ({ fieldCode, view: true, edit: false })),
        buttons: [],
      },
      PERSONNEL_OBJECT,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, reader.user.id, profile.id)).status).toBe(201);
    const scope = await world.api.request('PUT', `${BASE}/scopes/${reader.user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId, includeDescendants: false }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
  });

  const list = async () => {
    const response = await world.api.request('GET', `${BASE}/users?type=all&limit=200`, viewer);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: UserWithContact[] }).items;
  };
  const detail = async (userId: string) => {
    const response = await world.api.request('GET', `${BASE}/users/${userId}`, viewer);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as UserWithContact;
  };
  /** 建档并入职到读取者数据范围内的组织，档案才对读取者可见。 */
  async function hired(name: string, login: string) {
    const employee = await hr.employee(name, login);
    expect((await hr.hire(employee, orgId)).status).toBe(201);
    return employee;
  }
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
    const employee = await hired('联系邮箱人员', login);
    await setArchiveEmail(employee.id, 'syn.d@example.com');
    const userId = await boundUser(employee.id);
    const row = (await list()).find((u) => u.userId === userId)!;
    expect(row).toMatchObject({ email: login, contactEmail: 'syn.d@example.com' });
    expect(await detail(userId)).toMatchObject({ email: login, contactEmail: 'syn.d@example.com' });
  });

  it('登录名为空的账号：email = 空串（只作显示），contactEmail 仍取档案', async () => {
    const employee = await hired('空登录名人员', syntheticEmail('null-login'));
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
