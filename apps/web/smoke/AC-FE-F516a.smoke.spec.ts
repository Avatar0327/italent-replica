import { test, expect, snapshotFixture } from './fixtures.js';
import { settingsFixtures, rows, ids, menus } from './settings-fixtures.js';

test('AC-FE-F516a 全部用户账号状态与独立邮箱筛选同步 total，清空恢复启用', async ({ page }) => {
  await settingsFixtures(page, false);
  const queries: URLSearchParams[] = [];
  await page.route('**/permission/users?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    return route.fulfill({
      json: {
        items: [
          {
            ...rows.user,
            contactPhone: '13000000001',
            employeeStatus: 'pending',
            accountStatus: query.get('accountStatus'),
          },
        ],
        total: query.has('contactEmail') ? 1 : 31,
      },
    });
  });
  await page.goto('/settings/menu/users.all');
  await expect(page.getByRole('cell', { name: '13000000001', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '待入职', exact: true })).toBeVisible();
  expect(queries.at(-1)?.get('accountStatus')).toBe('active');
  await page.locator('.ant-pagination-next button').click();
  await expect.poll(() => queries.at(-1)?.get('offset')).toBe('15');
  await page
    .getByRole('combobox', { name: '账号状态', exact: true })
    .locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," ant-select ")][1]')
    .click();
  await page
    .locator('.ant-select-item-option:visible')
    .filter({ hasText: /^停用$/ })
    .click();
  await page.getByRole('textbox', { name: '联系邮箱', exact: true }).fill('Zhang');
  await page.getByRole('button', { name: /^查\s*询$/ }).click();
  await expect.poll(() => queries.at(-1)?.get('contactEmail')).toBe('Zhang');
  expect(queries.at(-1)?.get('accountStatus')).toBe('disabled');
  expect(queries.at(-1)?.has('q')).toBe(false);
  expect(queries.at(-1)?.get('offset')).toBe('0');
  await expect(page.locator('.page-total')).toContainText('1');
  await page.getByRole('button', { name: /^清\s*空$/ }).click();
  await expect.poll(() => queries.at(-1)?.get('accountStatus')).toBe('active');
  expect(queries.at(-1)?.has('contactEmail')).toBe(false);
});

test('AC-FE-F516a 管理员部门筛选使用组织树并提交上级 ID', async ({ page }) => {
  await settingsFixtures(page, false);
  const queries: URLSearchParams[] = [];
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        adminMenus: [...menus, ['permission.admins', '管理员']].map(([code, path]) => ({
          code,
          path,
          implemented: true,
          editable: false,
        })),
      },
    }),
  );
  await page.route('**/org/organizations/tree?*', (route) =>
    route.fulfill({
      json: {
        roots: [{ id: ids.mou, name: '合成上级部门', children: [] }],
        total: 1,
        hasDataPermission: true,
      },
    }),
  );
  await page.route('**/permission/admins?*', (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({
      json: {
        items: [
          {
            id: ids.user,
            userId: ids.user,
            displayName: '合成管理员',
            role: 'audit_admin',
            mous: [],
            department: { id: ids.mou, name: '合成主职部门' },
          },
        ],
        total: 1,
      },
    });
  });
  await page.goto('/settings/menu/permission.admins');
  await expect(page.getByRole('cell', { name: '合成主职部门', exact: true })).toBeVisible();
  await page
    .getByRole('combobox', { name: '部门', exact: true })
    .locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," ant-select ")][1]')
    .click();
  await page.locator('.ant-select-tree-title').filter({ hasText: '合成上级部门' }).click();
  await page.getByRole('button', { name: /^查\s*询$/ }).click();
  await expect.poll(() => queries.at(-1)?.get('departmentId')).toBe(ids.mou);
});
