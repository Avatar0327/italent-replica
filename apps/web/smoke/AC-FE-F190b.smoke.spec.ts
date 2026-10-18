import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { mockInfo } from './f154-fixtures.js';
import { ui } from '../src/foundation/messages.js';

test('AC-FE-F190b-05 展开同名子菜单进入带教列表，旧深链与隐藏分组', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await mockInfo(page);
  await page.goto('/idp/plans');
  const title = page.locator('.shell-sidebar .ant-menu-submenu-title').filter({ hasText: '带教信息' });
  await expect(title).toBeVisible();
  await title.click();
  await expect(page).toHaveURL(/\/idp\/plans$/);
  await title.locator('..').getByRole('menuitem', { name: '带教信息', exact: true }).click();
  await expect(page).toHaveURL(/\/tutorship-information$/);
  await expect(page.getByRole('heading', { name: '带教信息', exact: true })).toBeVisible();
  await expect(page.getByText('共5条', { exact: true })).toBeVisible();
  await page.reload();
  await expect(title.locator('..').getByRole('menuitem', { name: '带教信息', exact: true })).toBeVisible();
  await expect(page.getByText('共5条', { exact: true })).toBeVisible();
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: snapshotFixture }));
  await page.goto('/tutorship-information');
  await expect(page.locator('.shell-workspace')).toContainText(ui.denied);
  await expect(title).toHaveCount(0);
});
