/// <reference lib="dom" />
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import {
  BASE,
  seedPermissionWorld,
  addMember,
  createProfile,
  makeGrantable,
  grant,
} from '../../../../tests/acceptance/AC-PRM-support.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { AdminsPage } from './AdminsPage.js';
import { UsersPage } from './UsersPage.js';
import { ProfilesPage } from './ProfilesPage.js';
import { GrantsPage } from './GrantsPage.js';
const database = useTestDb();
const responses: Record<string, unknown> = {};
let ui: ReturnType<typeof uiHarness> | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});
beforeEach(() => {
  const browser = new Window();
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'SVGElement',
    'Element',
    'ShadowRoot',
    'Node',
    'getComputedStyle',
    'ResizeObserver',
  ] as const) {
    vi.stubGlobal(key, key === 'window' ? browser : browser[key]);
  }
});

beforeAll(async () => {
  const world = await seedPermissionWorld(database().db);
  const member = await addMember(world, '合成读者');
  const profile = await createProfile(world, `A2a_${uniqueSuffix()}`);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, member.id, profile.id)).status).toBe(201);
  for (const resource of ['users', 'profiles', 'grants', 'admins']) {
    const response = await world.api.request('GET', `${BASE}/${resource}?limit=15&offset=0`, world.asAdmin);
    expect(response.status).toBe(200);
    responses[`${BASE}/${resource}`] = await response.json();
    const denied = await world.api.request('GET', `${BASE}/${resource}`, { tenant: world.tenant.id, user: member.id });
    expect(denied.status).toBe(403);
  }
});
describe('AC-FE-F4745-A2a 真后端响应进入列表', () => {
  it('用户真实 contactEmail 为空时不冒用登录邮箱', async () => {
    ui = uiHarness();
    await ui.render(h(UsersPage, { code: 'users.all', title: '全部用户', editable: false }), '/', undefined, responses);
    expect(ui.headers()).toContain('账号状态');
    const headers = ui.headers();
    const login = headers.indexOf('登录用户名');
    const contact = headers.indexOf('联系邮箱');
    expect(login).toBeGreaterThan(-1);
    expect(contact).toBe(login + 1);
    const body = responses[`${BASE}/users`] as { items: { email: string; contactEmail: string | null }[] };
    const rows = ui.host.querySelectorAll('tbody .ant-table-row');
    expect(rows).toHaveLength(body.items.length);
    body.items.forEach((user, index) => {
      const cells = rows[index]!.querySelectorAll('td');
      expect(cells[login]?.textContent).toBe(user.email || '--');
      expect(cells[contact]?.textContent).toBe(user.contactEmail || '--');
    });
  });
  it('身份真实修改人与授权数显示，不依赖截图合成', async () => {
    ui = uiHarness();
    await ui.render(
      h(ProfilesPage, { code: 'permission.profiles', title: '身份管理', editable: false }),
      '/',
      undefined,
      responses,
    );
    expect(ui.headers()).toContain('最近修改人');
    const body = responses[`${BASE}/profiles`] as { items: { updatedBy: { displayName: string } | null }[] };
    for (const row of body.items) if (row.updatedBy) expect(ui.host.textContent).toContain(row.updatedBy.displayName);
  });
  it('授权真实关联姓名和身份在只读列表中显示', async () => {
    ui = uiHarness();
    await ui.render(
      h(GrantsPage, { code: 'permission.user_grant', title: '用户授权', editable: false, canScope: false }),
      '/',
      undefined,
      responses,
    );
    expect(ui.headers()).toContain('管理单元');
    expect(ui.host.textContent).toContain('合成读者');
    expect(ui.host.textContent).toContain('身份A2a_');
  });
  it('管理员真实列表显示创建时间，部门保持空值', async () => {
    ui = uiHarness();
    await ui.render(
      h(AdminsPage, { code: 'permission.admins', title: '管理员', editable: true }),
      '/',
      undefined,
      responses,
    );
    expect(ui.headers()).toContain('创建人');
    expect(ui.host.querySelectorAll('tbody .ant-table-row')).toHaveLength(1);
    expect(ui.host.querySelectorAll('tbody .ant-table-row td')[3]?.textContent).toBe('—');
  });
});
