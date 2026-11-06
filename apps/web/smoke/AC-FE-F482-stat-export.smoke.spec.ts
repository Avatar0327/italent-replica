import { actionButton } from './action-button.js';
import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { reportCatalog, reportPermission, movementPage, qualityPage } from './hr-reports-fixtures.js';

/** F-482：三张统计报表的“下载▾”——两个下载项、页面筛选带进导出、同步下载、失败有提示；不做订阅 / 打印。 */
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FORMULA = '下载（含公式、隐藏行/列）';
const DATA = '仅下载数据';
const REPORTS = [
  { code: 'monthly', file: '各月入离职统计.xlsx', api: '**/analytics/hr-movement/reports/monthly/export?*' },
  { code: 'institution', file: '各机构入离职统计.xlsx', api: '**/analytics/hr-movement/reports/institution/export?*' },
  { code: 'quality', file: '员工素质结构.xlsx', api: '**/analytics/hr-structure/reports/quality/export?*' },
] as const;

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
  // 名册导出按钮的权限里没有“导出”：统计报表的下载也不该依赖它（DEC-809①：能看就能导出）
  await page.route('**/permission/me/objects/TenantBase.HrRoster', (route) =>
    route.fulfill({ json: reportPermission(false) }),
  );
  await page.route('**/hr-analysis/reports', (route) => route.fulfill({ json: reportCatalog() }));
  await page.route('**/analytics/hr-movement/reports/*?*', (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/export')) return route.fallback();
    return route.fulfill({ json: movementPage(new URL(route.request().url()).pathname.split('/').at(-1)) });
  });
  await page.route('**/analytics/hr-structure/reports/quality?*', (route) => route.fulfill({ json: qualityPage() }));
});

const fileResponse = (file: string, body = 'PK') => ({
  status: 200,
  contentType: XLSX,
  headers: {
    'content-disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(file)}`,
  },
  body,
});

for (const report of REPORTS) {
  test(`AC-FE-F482 ${report.code}：下载▾两项分别走 mode=formula / mode=data，页面筛选带进导出，文件名 = 报表名.xlsx`, async ({
    page,
  }) => {
    const queries: URLSearchParams[] = [];
    await page.route(report.api, (route) => {
      queries.push(new URL(route.request().url()).searchParams);
      return route.fulfill(fileResponse(report.file));
    });
    await page.goto(`/hr-reports/${report.code}`);
    const main = page.locator('.shell-workspace');
    await expect(main.locator('table')).toBeVisible();

    // 页面上没有订阅 / 打印（DEC-809③），也没有 CSV 的“导出”
    await expect(main.getByText(/订阅|打印/)).toHaveCount(0);
    await expect(actionButton(main, '导出')).toHaveCount(0);

    const trigger = actionButton(main, '下载 ▾');
    await trigger.click();
    await expect(page.getByRole('menuitem')).toHaveText([FORMULA, DATA]);

    const first = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: FORMULA }).click();
    expect((await first).suggestedFilename()).toBe(report.file);

    await trigger.click();
    const second = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: DATA }).click();
    expect((await second).suggestedFilename()).toBe(report.file);

    expect(queries.map((q) => q.get('mode'))).toEqual(['formula', 'data']);
    // 页面已运行的筛选原样带上
    expect(queries[0]!.get('asOf')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (report.code === 'quality') expect(queries[0]!.get('employType')).toBe('internal');
    else expect(queries[0]!.get('year')).toMatch(/^\d{4}$/);
    if (report.code === 'institution') expect(queries[0]!.get('month')).toMatch(/^\d{1,2}$/);
  });
}

test('AC-FE-F482 改了筛选但没点查询时，下载用的是页面已运行的筛选；点查询后用新的', async ({ page }) => {
  const years: (string | null)[] = [];
  await page.route(REPORTS[0].api, (route) => {
    years.push(new URL(route.request().url()).searchParams.get('year'));
    return route.fulfill(fileResponse(REPORTS[0].file));
  });
  await page.goto('/hr-reports/monthly');
  const main = page.locator('.shell-workspace');
  await expect(main.locator('table')).toBeVisible();
  const ran = await main.getByLabel('年度', { exact: true }).inputValue();
  await main.getByLabel('年度', { exact: true }).fill('2025');
  let download = page.waitForEvent('download');
  await actionButton(main, '下载 ▾').click();
  await page.getByRole('menuitem', { name: DATA }).click();
  await download;
  await actionButton(main, '查询').click();
  await expect(main.locator('table')).toBeVisible();
  download = page.waitForEvent('download');
  await actionButton(main, '下载 ▾').click();
  await page.getByRole('menuitem', { name: DATA }).click();
  await download;
  expect(years).toEqual([ran, '2025']);
});

test('AC-FE-F482 下载中按钮禁用、只发一次请求；完成后恢复', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await page.route(REPORTS[0].api, async (route) => {
    calls += 1;
    await gate;
    await route.fulfill(fileResponse(REPORTS[0].file));
  });
  await page.goto('/hr-reports/monthly');
  const main = page.locator('.shell-workspace');
  await expect(main.locator('table')).toBeVisible();
  const download = page.waitForEvent('download');
  await actionButton(main, '下载 ▾').click();
  await page.getByRole('menuitem', { name: DATA }).click();
  const busy = main.getByRole('button', { name: /下载/ });
  await expect(busy).toBeDisabled();
  release();
  await download;
  await expect(busy).toBeEnabled();
  expect(calls).toBe(1);
});

test('AC-FE-F482 导出失败给出明确提示、不落盘；403 与服务端错误分开说', async ({ page }) => {
  let status = 403;
  await page.route(REPORTS[2].api, (route) =>
    route.fulfill({ status, json: { error: { code: status === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR', message: 'x' } } }),
  );
  await page.goto('/hr-reports/quality');
  const main = page.locator('.shell-workspace');
  await expect(main.locator('table')).toBeVisible();
  let downloads = 0;
  page.on('download', () => (downloads += 1));
  await actionButton(main, '下载 ▾').click();
  await page.getByRole('menuitem', { name: FORMULA }).click();
  await expect(main.getByRole('alert')).toHaveText('无权导出该报表');
  status = 500;
  await actionButton(main, '下载 ▾').click();
  await page.getByRole('menuitem', { name: DATA }).click();
  await expect(main.getByRole('alert')).toHaveText('导出失败，请重试');
  // 返回的不是 xlsx 也不能当成功落盘
  await page.route(REPORTS[2].api, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>x</p>' }),
  );
  await actionButton(main, '下载 ▾').click();
  await page.getByRole('menuitem', { name: DATA }).click();
  await expect(main.getByRole('alert')).toHaveText('导出失败，请重试');
  expect(downloads).toBe(0);
});

test('AC-FE-F482 名册类报表的“导出”(CSV)不受影响：有导出按钮权限才出现，且没有“下载▾”', async ({ page }) => {
  await page.route('**/permission/me/objects/TenantBase.HrRoster', (route) =>
    route.fulfill({ json: reportPermission(true) }),
  );
  await page.route('**/hr-analysis/reports/1.01?*', (route) =>
    route.fulfill({ json: { ...movementPage('monthly'), columns: [], items: [], total: 0, page: 1, pageSize: 20 } }),
  );
  await page.goto('/hr-reports/1.01');
  const main = page.locator('.shell-workspace');
  await expect(actionButton(main, '导出')).toBeVisible();
  await expect(actionButton(main, '下载 ▾')).toHaveCount(0);
});
