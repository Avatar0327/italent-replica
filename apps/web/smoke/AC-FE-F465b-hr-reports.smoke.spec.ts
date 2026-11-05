import { actionButton } from './action-button.js';
import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { reportCatalog, reportPage, reportPermission, movementPage, qualityPage } from './hr-reports-fixtures.js';

test.beforeEach(async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((a) =>
          a.app === 'staff'
            ? {
                ...a,
                entryObjects: ['TenantBase.HrRoster', 'TenantBase.HrMovementReport', 'TenantBase.HrStructureReport'],
              }
            : a,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.HrRoster', (route) =>
    route.fulfill({ json: reportPermission() }),
  );
  await page.route('**/hr-analysis/reports', (route) => route.fulfill({ json: reportCatalog() }));
});

test('AC-FE-F465b 目录 → 名册 → 筛选空结果 → 有权导出；表头只显示返回列', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const queries: string[] = [];
  await page.route('**/hr-analysis/reports/1.01?*', (route) => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    const body = reportPage();
    return route.fulfill({ json: url.searchParams.has('name') ? { ...body, items: [], total: 0 } : body });
  });
  await page.route('**/hr-analysis/reports/1.01/export?*', (route) =>
    route.fulfill({
      contentType: 'text/csv',
      body: '\ufeff姓名,工号\r\n',
    }),
  );
  await page.goto('/hr-reports');
  await expect(page.locator('.shell-sidebar').getByText('报表', { exact: true })).toBeVisible();
  const main = page.locator('.shell-workspace');
  await expect(main.getByRole('button', { name: '在职员工花名册', exact: true })).toBeVisible();
  await main.getByRole('button', { name: '在职员工花名册', exact: true }).click();
  await expect(main.getByText('合成甲', { exact: true })).toBeVisible();
  await expect(main.locator('thead th')).toHaveText(['姓名', '工号']);
  await page.screenshot({ path: test.info().outputPath('hr-report.png'), fullPage: true });
  await main.getByLabel('姓名', { exact: true }).fill('无匹配合成姓名');
  await actionButton(main, '查询').click();
  await expect(main.getByText('该报表暂无数据', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await actionButton(main, '导出').click();
  expect((await download).suggestedFilename()).toContain('1.01');
  expect(queries.some((q) => q.includes('name='))).toBe(true);
  expect(errors).toEqual([]);
});

test('AC-FE-F465b 三张统计报表隐藏导出，直链 403 明示无权', async ({ page }) => {
  await page.route('**/analytics/hr-movement/reports/*', (route) =>
    route.fulfill({
      json: movementPage(new URL(route.request().url()).pathname.split('/').at(-1)),
    }),
  );
  await page.route('**/analytics/hr-structure/reports/quality?*', (route) => route.fulfill({ json: qualityPage() }));
  for (const code of ['monthly', 'institution', 'quality']) {
    await page.goto(`/hr-reports/${code}`);
    await expect(page.locator('.shell-workspace table')).toBeVisible();
    await expect(actionButton(page.locator('.shell-workspace'), '导出')).toHaveCount(0);
  }
  await page.route('**/hr-analysis/reports/1.06?*', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'FORBIDDEN', message: '缺少合同对象的查看权限' } },
    }),
  );
  await page.goto('/hr-reports/1.06');
  await expect(page.getByText('无权查看该报表', { exact: true })).toBeVisible();
});
