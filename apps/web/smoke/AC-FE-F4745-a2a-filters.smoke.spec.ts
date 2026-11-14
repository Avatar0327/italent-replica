import type { Page } from '@playwright/test';
import { test, expect, snapshotFixture } from './fixtures.js';
import { settingsFixtures, rows, ids } from './settings-fixtures.js';

test('AC-FE-F4745-A2a 授权筛选使用独立候选，页大小和选择状态一致', async ({ page }) => {
  await settingsFixtures(page, false);
  const queries: URLSearchParams[] = [];
  const extra: string[] = [];
  page.on('request', (request) => {
    if (/grantable-profiles|permission\/profiles|permission\/mous/.test(request.url())) extra.push(request.url());
  });
  await page.route('**/permission/grants?*', (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({
      json: {
        items: [{ ...rows.grant, mous: [{ mouId: ids.mou, name: '合成范围', appCode: 'TenantBase' }] }],
        total: 401,
      },
    });
  });
  await page.route('**/permission/grants/mou-candidates?*', (route) =>
    route.fulfill({ json: { items: [{ id: ids.mou, name: '合成范围' }], total: 1 } }),
  );
  await page.goto('/settings/menu/permission.user_grant');
  await expect(page.locator('.page-total')).toContainText('401');
  await page.getByRole('checkbox', { name: '选择此行', exact: true }).check();
  await page.locator('.ant-pagination-options .ant-select-selector').click();
  await page
    .locator('.ant-select-item-option:visible')
    .filter({ hasText: /^200条\/页$/ })
    .click();
  await expect.poll(() => queries.at(-1)?.get('limit')).toBe('200');
  await expect(page.getByRole('checkbox', { name: '选择此行', exact: true })).not.toBeChecked();
  await page.locator('.ant-pagination-next button').click();
  await expect.poll(() => queries.at(-1)?.get('offset')).toBe('200');
  await select(page, '身份');
  await page.locator('.ant-select-item-option:visible').filter({ hasText: '合成人事身份' }).click();
  await select(page, '管理单元');
  await page.locator('.ant-select-item-option:visible').filter({ hasText: '合成范围' }).click();
  await page.getByRole('button', { name: /^查\s*询$/ }).click();
  await expect.poll(() => queries.at(-1)?.get('profileId')).toBe(ids.profile);
  expect(queries.at(-1)?.get('mouId')).toBe(ids.mou);
  expect(queries.at(-1)?.get('offset')).toBe('0');
  expect(queries.at(-1)?.get('limit')).toBe('200');
  await page.getByRole('button', { name: /^清\s*空$/ }).click();
  await expect.poll(() => queries.at(-1)?.has('profileId')).toBe(false);
  expect(extra).toEqual([]);
});

test('AC-FE-F4745-A2a 身份应用校验与离开后迟到响应，后退前进不复活旧查询', async ({ page }) => {
  await settingsFixtures(page, false);
  const queries: URLSearchParams[] = [];
  let release: (() => void) | undefined;
  await page.route('**/permission/profiles?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    if (query.get('name') === '迟到')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      json: {
        items: [{ ...rows.profile, name: query.get('name') === '迟到' ? '合成旧结果' : '合成新结果' }],
        total: 1,
      },
    });
  });
  await page.goto('/settings/menu/permission.profiles');
  const app = page.getByRole('textbox', { name: '关联应用', exact: true });
  await app.fill('非法应用!');
  const before = queries.length;
  await page.getByRole('button', { name: /^查\s*询$/ }).click();
  await expect(page.getByText('请检查必填项及格式', { exact: true })).toBeVisible();
  expect(queries).toHaveLength(before);
  await app.fill('TenantBase');
  await page.getByRole('textbox', { name: '编码', exact: true }).fill('SYNTH');
  await page.getByRole('button', { name: /^查\s*询$/ }).click();
  await expect.poll(() => queries.at(-1)?.get('app')).toBe('TenantBase');
  expect(queries.at(-1)?.get('code')).toBe('SYNTH');
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('迟到');
  await page.getByRole('button', { name: /^查\s*询$/ }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator('.settings-navigation').getByRole('button', { name: '全部用户', exact: true }).click();
  release!();
  await expect(page.getByRole('heading', { name: '全部用户', exact: true })).toBeVisible();
  await expect(page.getByText('合成旧结果', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('button', { name: '合成新结果', exact: true })).toBeVisible();
  expect(queries.at(-1)?.has('name')).toBe(false);
  await page.goForward();
  await expect(page.getByRole('heading', { name: '全部用户', exact: true })).toBeVisible();
});

test('AC-FE-F4745-A2a 管理员菜单缺失时拒绝直达且不请求列表', async ({ page }) => {
  await settingsFixtures(page, false);
  const calls: string[] = [];
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({ json: { ...snapshotFixture, adminMenus: [] } }),
  );
  page.on('request', (request) => {
    if (request.url().includes('/permission/admins')) calls.push(request.url());
  });
  await page.goto('/settings/menu/permission.admins');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  expect(calls).toEqual([]);
});
async function select(page: Page, name: string) {
  await page
    .locator('.ant-select')
    .filter({ has: page.getByRole('combobox', { name, exact: true }) })
    .locator('.ant-select-selector')
    .click();
}
