import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { ui } from '../src/foundation/messages.js';

test('AC-FE-F190a-04 外壳展开分组、子项路由与 legacy、直达鉴权和刷新展开', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // 仅在浏览器响应中注入合成登记，不修改业务模块或生产路由。
  await page.route(/\/src\/idp\/pages\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'entries: [',
      `entries: [{
      id: 'fixture-group', app: 'idp', group: 'talent', label: '合成分组', children: [
        { id: 'fixture-first', label: '合成子页甲', objectCode: 'IDP.Idp',
          page: { Component: () => '合成子页甲' } },
        { id: 'fixture-second', label: '合成子页乙', objectCode: 'IDP.Career', legacy: true,
          page: { Component: () => '合成子页乙' } }
      ]
    },`,
    );
    expect(body).toContain('fixture-group');
    await route.fulfill({ response, body });
  });
  let allowed = ['IDP.Idp', 'IDP.Career'];
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => (app.app === 'idp' ? { ...app, entryObjects: allowed } : app)),
      },
    }),
  );
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.goto('/idp/plans');
  const sidebar = page.locator('.shell-sidebar');
  const title = sidebar.locator('.ant-menu-submenu-title').filter({ hasText: '合成分组' });
  await expect(sidebar.getByText('合成子页乙', { exact: true })).not.toBeVisible();
  await title.click();
  await expect(page).toHaveURL(/\/idp\/plans$/);
  const nested = title.locator('..');
  await nested.getByText('合成子页乙', { exact: true }).click();
  await expect(page).toHaveURL(/\/fixture-second$/);
  await expect(page.locator('.legacy-page')).toHaveText('合成子页乙');
  await page.reload();
  await expect(sidebar.getByText('合成子页乙', { exact: true })).toBeVisible();
  await sidebar.getByText('合成子页甲', { exact: true }).click();
  await expect(page.locator('.shell-workspace')).toContainText('合成子页甲');
  await expect(page.locator('.legacy-page')).toHaveCount(0);
  allowed = ['IDP.Idp'];
  await page.goto('/fixture-second');
  await expect(page.locator('.shell-workspace')).toContainText(ui.denied);
  await expect(sidebar.getByText('合成子页乙', { exact: true })).toHaveCount(0);
  for (const path of ['/%66ixture-second', '/FIXTURE-SECOND']) {
    await page.goto(path);
    await expect(page.locator('.shell-workspace')).toContainText(ui.denied);
  }
  allowed = [];
  await page.reload();
  await expect(title).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F190a-06 冲突子项不能借调动权限挂载隐藏的 IDP 应用', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/\/src\/idp\/pages\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(
        'entries: [',
        `entries: [{
      id: 'fixture-conflict', app: 'transfer', group: 'people', label: '合成冲突组',
      children: [{ id: 'IDP', label: '合成子项', objectCode: 'TenantBase.EmploymentRecord' }]
    },`,
      )
      .replace('page: IdpPage,', "page: { Component: () => '禁止挂载的合成 IDP 应用' },");
    await route.fulfill({ response, body });
  });
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => (app.app === 'idp' ? { ...app, visible: false } : app)),
      },
    }),
  );
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  for (const path of ['/idp', '/idp/', '/%69dp']) {
    errors.length = 0;
    await page.goto(path);
    await expect.poll(() => errors.join('\n')).toMatch(/子菜单路由冲突/);
    await expect(page.getByText('禁止挂载的合成 IDP 应用', { exact: true })).toHaveCount(0);
  }
});
