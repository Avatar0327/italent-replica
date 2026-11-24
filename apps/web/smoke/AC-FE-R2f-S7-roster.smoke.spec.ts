import type { Page } from '@playwright/test';
import { actionButton } from './action-button.js';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';
import { reportCatalog, reportPermission } from './hr-reports-fixtures.js';

const rosterObject = 'TenantBase.HrRoster';
const rosterRead = '**/hr-analysis/roster?*';
const rosterExport = '**/hr-analysis/roster/export?*';
const title = '时点员工花名册';
const today = snapshotFixture.session.today;
const historical = '2025-07-01';
const columns = [
  { key: 'code', label: '工号' },
  { key: 'employeeName', label: '姓名' },
  { key: 'orgFullName', label: '组织全称' },
  { key: 'backupMail', label: '个人邮箱' },
  { key: 'employeeStatus', label: '人员状态' },
  { key: 'workDate', label: '参加工作日期' },
];
function rosterPage(asOf = today, page = 1) {
  const count = page === 1 ? 20 : 1;
  return {
    asOf,
    columns,
    items: Array.from({ length: count }, (_, i) => {
      const number = (page - 1) * 20 + i + 1;
      return {
        employeeId: `ZZ_FER2F_ID_${number}`,
        employeeName: `ZZ_FER2F_员工_${number}`,
        code: `ZZ_FER2F_${number}`,
        orgFullName: asOf === historical ? 'ZZ_FER2F_历史集团/部门' : 'ZZ_FER2F_当前集团/部门',
        backupMail: 'zz_fer2f@example.com',
        employeeStatus: 3,
        workDate: '2020-01-01',
      };
    }),
    page,
    pageSize: 20,
    total: 21,
    hasDataPermission: true,
  };
}
async function allow(page: Page, entryObjects = [rosterObject], exportAllowed = true) {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => (app.app === 'staff' ? { ...app, entryObjects } : app)),
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.HrRoster', (route) =>
    route.fulfill({ json: reportPermission(exportAllowed) }),
  );
}
const workspace = (page: Page) => page.locator('.shell-workspace');

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await allow(page);
  await page.route('**/hr-analysis/reports', (route) => route.fulfill({ json: reportCatalog() }));
});

test('AC-FE-R2f-01/06 两个入口共用名册、按回执列序与时点翻页', async ({ page }) => {
  const requests: URL[] = [];
  await page.route(rosterRead, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    return route.fulfill({
      json: rosterPage(url.searchParams.get('asOf') ?? today, Number(url.searchParams.get('page'))),
    });
  });
  await page.goto('/hr-reports');
  const main = workspace(page);
  await main.getByRole('button', { name: '员工花名册', exact: true }).click();
  await expect(main.getByRole('heading', { name: '员工花名册', exact: true })).toBeVisible();
  await expect(main.locator('thead th')).toHaveText(columns.map(({ label }) => label));

  await page.getByRole('button', { name: '应用导航' }).click();
  const panel = page.getByRole('dialog', { name: '全部菜单' });
  await panel.getByRole('searchbox').fill('员工名册');
  const rosterLink = panel.getByRole('link', { name: /员工名册/ });
  await expect(rosterLink).toBeVisible({ timeout: 6000 });
  await rosterLink.click();
  await expect(page).toHaveURL(/\/hr-analytics-roster$/);
  await expect(main.getByRole('heading', { name: title })).toBeVisible();
  await expect(main.getByText('在职内部员工和实习生（试用、正式）')).toBeVisible();
  await expect(main.locator('thead th')).toHaveText(columns.map(({ label }) => label));
  await expect(main.getByLabel('雇佣关系', { exact: true })).toHaveCount(0);
  await expect(main.getByLabel('邮箱', { exact: true })).toHaveCount(0);
  await main.getByLabel('时点日期').fill(historical);
  await actionButton(main, '查询').click();
  await expect(main.getByText('ZZ_FER2F_历史集团/部门').first()).toBeVisible();
  await expect(main.getByText('ZZ_FER2F_员工_1', { exact: true })).toBeVisible();
  await main.locator('.ant-pagination-item-2').click();
  await expect(main.getByText('ZZ_FER2F_员工_21', { exact: true })).toBeVisible();
  await expect(main.getByText('ZZ_FER2F_员工_1', { exact: true })).toHaveCount(0);
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({ asOf: historical, page: '2', pageSize: '20' });

  await allow(page, []);
  await page.goto('/hr-analytics-roster');
  await expect(main.getByRole('heading', { name: title })).toHaveCount(0);
  await page.getByRole('button', { name: '应用导航' }).click();
  await panel.getByRole('searchbox').fill('员工名册');
  await expect(panel.getByRole('link', { name: /员工名册/ })).toHaveCount(0);
  await expect(page.locator('.shell-sidebar').getByText('数据分析', { exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(4);
});

test('AC-FE-R2f-06 导出改权 403 清退结果，422、429 和错误格式均无文件', async ({ page }) => {
  let status = 422;
  let downloads = 0;
  const urls: URL[] = [];
  page.on('download', () => downloads++);
  await page.route(rosterRead, (route) => route.fulfill({ json: rosterPage(historical) }));
  await page.route(rosterExport, (route) => {
    urls.push(new URL(route.request().url()));
    if (status === 200) return route.fulfill({ contentType: 'text/csv-invalid', body: 'ZZ_FER2F_假文件' });
    if (status === 429)
      return route.fulfill({
        status,
        headers: { 'Retry-After': '3' },
        json: { error: { code: 'REQUEST_RATE_LIMITED' } },
      });
    return route.fulfill({
      status,
      json: {
        error:
          status === 422
            ? { code: 'VALIDATION_FAILED', details: { reason: 'EXPORT_ROW_LIMIT' } }
            : { code: 'FORBIDDEN' },
      },
    });
  });
  await page.goto('/hr-reports/roster');
  const main = workspace(page);
  await expect(main.locator('table')).toBeVisible();
  await main.getByLabel('时点日期').fill('2024-01-01');
  await main.getByLabel('姓名', { exact: true }).fill('ZZ_FER2F_未查询');
  await actionButton(main, '导出').click();
  await expect(main.getByText('导出最多 10000 行，请缩小筛选范围')).toBeVisible();
  expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ asOf: historical });
  status = 200;
  await actionButton(main, '导出').click();
  await expect(main.getByText('导出失败，请重试')).toBeVisible();
  status = 429;
  await actionButton(main, '导出').click();
  await expect(main.getByText('请求过于频繁，请稍后重试')).toBeVisible();
  await expect(actionButton(main, '导出')).toBeDisabled();
  await expect(actionButton(main, '查询')).toBeDisabled();
  await expect(actionButton(main, '导出')).toBeEnabled({ timeout: 6000 });
  expect(urls).toHaveLength(3);
  status = 403;
  await actionButton(main, '导出').click();
  await expect(main.getByText('无权导出该报表')).toBeVisible();
  await expect(main.locator('table')).toHaveCount(0);
  await expect(actionButton(main, '导出')).toHaveCount(0);
  expect(downloads).toBe(0);
});

test('AC-FE-R2f-11 429 在 Retry-After 期间锁定查询，恢复后只手动重试', async ({ page }) => {
  let count = 0;
  let limited = true;
  await page.route(rosterRead, (route) => {
    count += 1;
    if (limited)
      return route.fulfill({
        status: 429,
        headers: { 'Retry-After': '3' },
        json: { error: { code: 'REQUEST_RATE_LIMITED' } },
      });
    return route.fulfill({ json: rosterPage() });
  });
  await page.goto('/hr-reports/roster');
  const main = workspace(page);
  await expect(main.getByText('请求过于频繁，请稍后重试')).toBeVisible();
  const retry = actionButton(main, '重试');
  const before = count;
  await expect(retry).toBeDisabled({ timeout: 1000 });
  await expect(actionButton(main, '查询')).toBeDisabled({ timeout: 1000 });
  await expect(retry).toBeEnabled({ timeout: 6000 });
  expect(count).toBe(before);
  limited = false;
  await retry.click();
  await expect(main.locator('table')).toBeVisible();
  expect(count).toBe(before + 1);
});

test('AC-FE-R2f-06 撤列同步撤下筛选，已应用状态与日期用于 CSV，草稿留在表单', async ({ page }) => {
  let canSeeWorkDate = true;
  const queries: URL[] = [];
  await page.route(rosterRead, (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const result = rosterPage(url.searchParams.get('asOf') ?? today);
    if (canSeeWorkDate) return route.fulfill({ json: result });
    return route.fulfill({
      json: {
        ...result,
        columns: result.columns.filter(({ key }) => key !== 'workDate'),
        items: result.items.map(({ workDate: _workDate, ...item }) => item),
      },
    });
  });
  await page.route(rosterExport, (route) =>
    route.fulfill({ contentType: 'text/csv', body: '\ufeff工号,姓名\r\nZZ_FER2F_1,ZZ_FER2F_员工_1\r\n' }),
  );
  await page.goto('/hr-analytics-roster');
  const main = workspace(page);
  const from = main.getByLabel('参加工作日期起');
  await expect(from).toBeVisible();
  await from.fill('2020-01-01');
  await main.getByLabel('参加工作日期止').fill('2025-01-01');
  await main.getByLabel('时点日期').fill(historical);
  await main.locator('.ant-select[aria-label="人员状态"] .ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="正式"]').click();
  await actionButton(main, '查询').click();
  await expect(main.getByText(/当前结果条件.*2020-01-01.*2025-01-01.*人员状态 正式/)).toBeVisible();
  await main.getByLabel('参加工作日期起').fill('2021-01-01');
  const csvRequest = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/roster/export'));
  const downloaded = page.waitForEvent('download');
  await actionButton(main, '导出').click();
  const { searchParams } = new URL((await csvRequest).url());
  expect(Object.fromEntries(searchParams)).toEqual({
    asOf: historical,
    workDateFrom: '2020-01-01',
    workDateTo: '2025-01-01',
    employeeStatus: '3',
  });
  expect((await downloaded).suggestedFilename()).toBe('report-roster.csv');

  canSeeWorkDate = false;
  await main.locator('.ant-pagination-item-2').click();
  await expect(main.getByText('可用筛选已变更，请重新查询')).toBeVisible();
  await expect(from).toHaveCount(0);
  await expect(main.getByLabel('参加工作日期止')).toHaveCount(0);
  await expect(actionButton(main, '导出')).toHaveCount(0);
  await actionButton(main, '查询').click();
  await expect(main.locator('thead th')).toHaveText(
    columns.filter(({ key }) => key !== 'workDate').map(({ label }) => label),
  );
  expect(Object.fromEntries(queries.at(-1)!.searchParams)).toEqual({
    asOf: historical,
    employeeStatus: '3',
    page: '1',
    pageSize: '20',
  });
  canSeeWorkDate = true;
  await actionButton(main, '查询').click();
  await expect(from).toHaveValue('');
});

test('AC-FE-R2f-06/11 无导出按钮，空权限与有权空结果可区分', async ({ page }) => {
  await allow(page, [rosterObject], false);
  let hasDataPermission = false;
  let exports = 0;
  await page.route(rosterExport, (route) => {
    exports += 1;
    return route.abort();
  });
  await page.route(rosterRead, (route) =>
    route.fulfill({ json: { ...rosterPage(), items: [], total: 0, hasDataPermission } }),
  );
  await page.goto('/hr-analytics-roster');
  const main = workspace(page);
  await expect(main.getByText('无数据权限')).toBeVisible();
  await expect(main.getByText('该报表暂无数据')).toBeVisible();
  await expect(actionButton(main, '导出')).toHaveCount(0);
  hasDataPermission = true;
  await actionButton(main, '查询').click();
  await expect(main.getByText('该报表暂无数据')).toBeVisible();
  await expect(main.getByText('无数据权限')).toHaveCount(0);
  await expect(actionButton(main, '导出')).toHaveCount(0);
  expect(exports).toBe(0);
});

test('AC-FE-R2f-11 读失败清退结果，503 手动重试，401 走共享登录态', async ({ page }) => {
  let status = 200;
  let requests = 0;
  let code = '';
  await page.route(rosterRead, (route) => {
    requests += 1;
    return route.fulfill({ status, json: status === 200 ? rosterPage() : { error: { code } } });
  });
  await page.goto('/hr-analytics-roster');
  const main = workspace(page);
  await expect(main.locator('table')).toBeVisible();
  for (const [http, errorCode, message] of [
    [503, 'DEPENDENCY_UNAVAILABLE', '报表加载失败，请重试'],
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围'],
    [413, 'PAYLOAD_TOO_LARGE', '请求内容过大，请缩小筛选范围'],
    [403, 'FORBIDDEN', '无权查看该报表'],
    [404, 'NOT_FOUND', '报表不存在'],
    [401, 'UNAUTHENTICATED', '请选择演示身份或提供会话上下文'],
  ] as const) {
    const before = requests;
    status = http;
    code = errorCode;
    await actionButton(main, '查询').click();
    await expect(main.getByText(message, { exact: true })).toBeVisible();
    await expect(main.locator('table')).toHaveCount(0);
    await expect(actionButton(main, '导出')).toHaveCount(0);
    expect(requests).toBe(before + 1);
    if (http === 401) {
      await expect(actionButton(main, '查询')).toHaveCount(0);
      break;
    }
    const retry = actionButton(main, '重试');
    if (http !== 503) await expect(retry).toHaveCount(0);
    status = 200;
    await (http === 503 ? retry : actionButton(main, '查询')).click();
    await expect(main.locator('table')).toBeVisible();
  }
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test('AC-FE-R2f-11 翻页和换入口时丢弃迟到的名册与 CSV', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith('/roster/export') || url.searchParams.get('page') === '2')
        return original(input, { ...init, signal: undefined });
      return original(input, init);
    };
  });
  const reading = gate();
  const exporting = gate();
  const finish = gate();
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.route(rosterRead, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('page') === '2') {
      reading.release();
      await finish.wait;
      return route.fulfill({ json: rosterPage(today, 2) });
    }
    return route.fulfill({ json: rosterPage() });
  });
  await page.route(rosterExport, async (route) => {
    exporting.release();
    await finish.wait;
    return route.fulfill({ contentType: 'text/csv', body: '\ufeff工号\r\nZZ_FER2F_迟到\r\n' });
  });

  try {
    await page.goto('/hr-analytics-roster');
    const main = workspace(page);
    await actionButton(main, '导出').click();
    await exporting.wait;
    await main.locator('.ant-pagination-item-2').click();
    await reading.wait;
    await expect(main.locator('table')).toHaveCount(0);
    await expect(actionButton(main, '导出')).toHaveCount(0);
    await page.locator('.shell-sidebar').getByRole('menuitem', { name: '报表', exact: true }).click();
    await main.getByRole('button', { name: '员工花名册', exact: true }).click();
    await expect(main.getByText('ZZ_FER2F_员工_1', { exact: true })).toBeVisible();

    const latePage = page.waitForResponse((response) => new URL(response.url()).searchParams.get('page') === '2');
    const lateCsv = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/roster/export'));
    finish.release();
    await (await latePage).finished();
    await (await lateCsv).finished();
    await expect(main.getByText('ZZ_FER2F_员工_21', { exact: true })).toHaveCount(0);
    await expect(main.getByText('ZZ_FER2F_员工_1', { exact: true })).toBeVisible();
    expect(downloads).toBe(0);
  } finally {
    finish.release();
  }
});
