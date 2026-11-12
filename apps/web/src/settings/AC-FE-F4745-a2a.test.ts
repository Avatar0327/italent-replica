/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Routes, Route } from 'react-router';
import { act, h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { UsersPage } from './UsersPage.js';
import { GrantsPage } from './GrantsPage.js';
import { ProfilesPage } from './ProfilesPage.js';
import { SettingsPage } from './SettingsPage.js';

vi.mock('../foundation/Permissions.js', async (original) => ({
  ...(await original<object>()),
  usePermissions: () => ({ menus: [{ key: 'settings', children: [{ key: 'permission.admins', editable: true }] }] }),
}));
const base = '/api/tenant/permission';
const id = '60000000-0000-4000-8000-000000000477';
const profile = {
  id,
  name: '合成身份',
  code: 'SYNTH',
  apps: ['TenantBase'],
  description: '合成描述',
  source: 'custom',
  autoHeld: false,
  revision: 1,
  updatedBy: null,
  updatedAt: '2026-11-10T23:30:00Z',
  grantCount: 23,
};
const user = {
  userId: id,
  displayName: '合成用户',
  email: 'login@example.com',
  contactEmail: 'contact@example.com',
  userType: 'external',
  businessIdentity: '顾问',
  membershipStatus: 'revoked',
  accountStatus: 'active',
  createdAt: '2026-11-10T23:30:00Z',
  membershipRevision: 1,
  employeeId: null,
};
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const props = { title: '合成列表', editable: false };
const queries = () => vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
async function next() {
  const button = ui.host.querySelector<HTMLElement>('.ant-pagination-next button');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}
describe('AC-FE-F4745-A2a 列表投影、结构与服务端分页', () => {
  it.each([
    { scenario: '联系邮箱为空', contactEmail: null, expected: '—' },
    { scenario: '联系邮箱与登录邮箱不同', contactEmail: 'contact@example.com', expected: 'contact@example.com' },
  ])('P2-1 $scenario：从列表点击姓名打开详情，不用登录邮箱填充联系邮箱', async ({ contactEmail, expected }) => {
    const row = { ...user, contactEmail };
    await ui.render(h(UsersPage, { ...props, code: 'users.all' }), '/', undefined, {
      [`${base}/users`]: { items: [row], total: 1 },
      [`${base}/users/${id}`]: row,
    });
    const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
    expect(cells[3]?.textContent).toBe(user.email);
    expect(cells[4]?.textContent).toBe(contactEmail ?? '--');
    const name = Array.from(ui.host.querySelectorAll<HTMLButtonElement>('tbody button')).find(
      (button) => button.textContent === user.displayName,
    );
    expect(name).toBeDefined();
    await act(async () => {
      name!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(queries().some((query) => query.pathname === `${base}/users/${id}`)).toBe(true);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const label = Array.from(dialog!.querySelectorAll('.ant-descriptions-item-label')).find(
      (item) => item.textContent === '联系邮箱',
    );
    expect(label).toBeDefined();
    const value = label!.closest('.ant-descriptions-item')?.querySelector('.ant-descriptions-item-content');
    expect(value?.textContent).toBe(expected);
    expect(value?.textContent).not.toContain(user.email);
  });
  it('全部用户按规格列序，联系邮箱不冒用登录邮箱，账号状态不冒用成员状态', async () => {
    await ui.render(h(UsersPage, { ...props, code: 'users.all' }), '/', undefined, {
      [`${base}/users`]: { items: [user], total: 31 },
    });
    expect(ui.headers().slice(1)).toEqual([
      '姓名',
      '登录手机号',
      '登录用户名',
      '联系邮箱',
      '联系手机号',
      '用户类型',
      '业务身份',
      '来源',
      '创建人',
      '创建时间',
      '账号状态',
      '员工状态',
      '',
    ]);
    expect(ui.widths()).toEqual(
      [30, 128, 128, 188, 188, 128, 128, 128, 128, 118, 146, 128, 128, 24].map((n) => `${n}px`),
    );
    expect(ui.host.textContent).toContain('contact@example.com');
    expect(ui.host.textContent).toContain('login@example.com');
    expect(ui.host.querySelector('tbody')?.textContent).toContain('启用');
    expect(ui.host.querySelector('tbody')?.textContent).not.toContain('已撤销');
    const select = ui.host.querySelector<HTMLInputElement>('input[aria-label="选择此行"]');
    await act(() => select!.click());
    expect(select!.checked).toBe(true);
    await next();
    expect(queries().at(-1)?.searchParams.get('offset')).toBe('15');
    expect(ui.host.querySelector<HTMLInputElement>('input[aria-label="选择此行"]')?.checked).toBe(false);
  });
  it('用户授权读取关联名称与管理单元，不依赖可授予身份权限或当前页切片', async () => {
    await ui.render(h(GrantsPage, { ...props, code: 'permission.user_grant', canScope: false }), '/', undefined, {
      [`${base}/grants`]: {
        items: [
          {
            id,
            userId: id,
            profileId: id,
            source: 'manual',
            status: 'active',
            userName: '合成被授权人',
            userEmail: 'grant@example.com',
            profileName: '合成身份',
            apps: ['TenantBase'],
            mous: [{ appCode: 'TenantBase', mouId: id, name: '合成单元' }],
            revision: 1,
          },
        ],
        total: 31,
      },
    });
    expect(ui.headers().slice(1)).toEqual(['姓名', '邮箱', '手机号码', '身份', '管理单元', '产品', '操作', '']);
    expect(ui.widths()).toEqual([30, 158, 218, 158, 158, 158, 158, 160, 24].map((n) => `${n}px`));
    expect(ui.host.textContent).toContain('合成被授权人');
    expect(ui.host.textContent).toContain('合成身份');
    expect(ui.host.textContent).toContain('合成单元');
    expect(queries().some((q) => q.pathname.endsWith('grantable-profiles'))).toBe(false);
    await next();
    expect(queries().at(-1)?.searchParams.get('offset')).toBe('15');
    expect(ui.host.querySelectorAll('tbody .ant-table-row')).toHaveLength(1);
  });
  it('管理员独立入口只读，显示服务端创建信息与总数', async () => {
    await ui.render(
      h(Routes, {}, h(Route, { path: '/settings/menu/:code', element: h(SettingsPage) })),
      '/settings/menu/permission.admins',
      undefined,
      {
        [`${base}/admins`]: {
          items: [
            {
              id,
              userId: id,
              displayName: '合成管理员',
              email: 'admin@example.com',
              role: 'user_admin',
              status: 'active',
              mous: [],
              createdBy: { userId: id, displayName: '合成创建人' },
              createdAt: '2026-11-10T23:30:00Z',
            },
          ],
          total: 31,
        },
      },
    );
    expect(ui.headers().slice(1)).toEqual([
      '姓名',
      '邮箱',
      '部门',
      '管理单元',
      '身份',
      '创建时间',
      '创建人',
      '操作',
      '',
    ]);
    expect(ui.widths()).toEqual([30, 134, 194, 134, 134, 134, 152, 124, 160, 24].map((n) => `${n}px`));
    expect(ui.host.textContent).toContain('合成创建人');
    expect(ui.host.textContent).toContain('用户管理员');
    expect(Array.from(ui.host.querySelectorAll('button')).some((b) => /新增|撤销|编辑/.test(b.textContent ?? ''))).toBe(
      false,
    );
    await next();
    expect(queries().at(-1)?.pathname).toBe(`${base}/admins`);
    expect(queries().at(-1)?.searchParams.get('offset')).toBe('15');
  });
  it('身份列表补齐修改人时间，旧行为空，不回填或把当前页作为总数', async () => {
    await ui.render(h(ProfilesPage, { ...props, code: 'permission.profiles' }), '/', undefined, {
      [`${base}/profiles`]: { items: [profile], total: 31 },
    });
    expect(ui.headers()).toEqual([
      '名称',
      '编码',
      '关联应用',
      '授权范围',
      '类型',
      '描述',
      '状态',
      '最近修改人',
      '最近修改时间',
      '所属应用',
      '操作',
      '',
    ]);
    expect(ui.widths()).toEqual([193, 128, 128, 128, 128, 128, 128, 118, 146, 128, 168, 24].map((n) => `${n}px`));
    const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
    expect(cells[7]?.textContent).toBe('—');
    expect(cells[6]?.textContent).toBe('—');
    expect(cells[8]?.textContent).toContain('2026/11/11');
    expect(cells[3]?.textContent).toContain('23');
    expect(ui.headers()).not.toContain('来源视图');
    await next();
    expect(queries().at(-1)?.searchParams.get('offset')).toBe('15');
    expect(ui.host.querySelectorAll('tbody .ant-table-row')).toHaveLength(1);
  });
  it('总数收缩后从失效页回到有效页，不保留越界空页', async () => {
    await ui.render(h(ProfilesPage, { ...props, code: 'permission.profiles' }), '/', undefined, {
      [`${base}/profiles`]: (url: URL) => ({
        items: url.searchParams.get('offset') === '0' ? [profile] : [],
        total: url.searchParams.get('offset') === '0' ? 31 : 1,
      }),
    });
    await next();
    expect(
      queries()
        .filter((url) => url.pathname.endsWith('/profiles'))
        .map((url) => url.searchParams.get('offset')),
    ).toEqual(['0', '15', '0']);
    expect(ui.host.querySelectorAll('tbody .ant-table-row')).toHaveLength(1);
  });
  it('修改人、自动持有与特殊字符如实显示，不把关联应用冒充所属应用', async () => {
    await ui.render(h(ProfilesPage, { ...props, code: 'permission.profiles' }), '/', undefined, {
      [`${base}/profiles`]: {
        items: [
          {
            ...profile,
            name: '<script>合成</script>',
            autoHeld: true,
            updatedBy: { userId: id, displayName: '合成修改人' },
          },
        ],
        total: 1,
      },
    });
    const cells = ui.host.querySelectorAll('tbody .ant-table-row td');
    expect(cells[3]?.textContent).toBe('自动适用于全体员工');
    expect(cells[7]?.textContent).toBe('合成修改人');
    expect(cells[9]?.textContent).toBe('—');
    expect(ui.host.querySelector('tbody script')).toBeNull();
    expect(ui.host.querySelector('input[aria-label="名称"]')?.getAttribute('maxlength')).toBe('100');
    expect(ui.host.querySelector('input[aria-label="关联应用"]')?.getAttribute('maxlength')).toBe('64');
  });
});
