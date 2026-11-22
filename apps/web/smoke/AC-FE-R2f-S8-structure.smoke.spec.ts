import type { Page, Route } from '@playwright/test';
import { actionButton } from './action-button.js';
import { expect, seedDemoUser, snapshotFixture, tenant, test } from './fixtures.js';
import { reportCatalog } from './hr-reports-fixtures.js';

const object = 'TenantBase.HrStructureReport';
const analytics = '/hr-structure-reports';
const api = '/api/tenant/analytics/hr-structure/reports';
const candidates = '**/analytics/organization-candidates?*';
const quality = '员工素质结构统计';
const position = '员工任职结构统计';
const prefix = 'ZZ_FER2F_';
const department = '10000000-0000-4000-8000-000000000002';
const otherTenant = '10000000-0000-4000-8000-000000000003';
const outside = '10000000-0000-4000-8000-000000000004';
const today = snapshotFixture.session.today;
const past = '2026-04-01';
const draft = '2026-02-02';
const formula = '下载（含公式、隐藏行/列）';
const dataOnly = '仅下载数据';
const file = {
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  body: 'PK',
};
const path = (code: string) => `**${api}/${code}?*`;
const exportPath = `**${api}/quality/export?*`;
const main = (page: Page) => page.locator('.shell-workspace');
const download = (page: Page) => actionButton(main(page), '下载 ▾');
const query = (page: Page) => actionButton(main(page), '查询');
const dateInput = (page: Page) => main(page).getByLabel('时点日期');
const selectDepartment = (page: Page) => main(page).getByRole('combobox', { name: '部门', exact: true });
const params = (route: Route) => Object.fromEntries(new URL(route.request().url()).searchParams);
const requestTenant = (route: Route) => route.request().headers()['x-tenant-id'];

function result(route: Route, name = prefix + '组织', hasDataPermission = true, empty = false) {
  const code = new URL(route.request().url()).pathname.split('/').at(-1);
  const columns =
    code === 'position'
      ? [
          { key: 'total', label: '合计' },
          { key: 'source:ZZ_FER2F_来源', label: prefix + '来源' },
          { key: 'category:ZZ_FER2F_类别', label: prefix + '类别' },
          { key: 'employType:intern:ratio', label: '实习生占比' },
        ]
      : [
          { key: 'total', label: '合计' },
          { key: 'avgAge', label: '平均年龄' },
          { key: 'avgTenure', label: '平均司龄' },
        ];
  const cells = {
    total: 7,
    'source:ZZ_FER2F_来源': 2,
    'category:ZZ_FER2F_类别': 3,
    'employType:intern:ratio': 0.1667,
    avgAge: 32.5,
    avgTenure: null,
  };
  return {
    asOf: params(route).asOf ?? today,
    report: code,
    name: code === 'position' ? position : quality,
    employType: params(route).employType ?? 'internal',
    hasDataPermission,
    columns,
    rows: empty ? [] : [{ organizationId: department, organizationName: name, cells }],
    summary: { cells: { ...cells, total: empty ? 0 : 21, avgAge: empty ? null : 34.8 } },
  };
}

function nodes(id = department, name = prefix + '部门') {
  return {
    items: [
      { id: tenant, parentId: null, name: prefix + '集团', enabled: true },
      { id, parentId: tenant, name, enabled: true },
      { id: outside, parentId: tenant, name: prefix + '范围外', enabled: false },
    ],
  };
}

async function allow(page: Page, entryObjects = [object], tenantId = tenant) {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, tenantId },
        apps: snapshotFixture.apps.map((app) => (app.app === 'staff' ? { ...app, entryObjects } : app)),
      },
    }),
  );
}

async function pickDepartment(page: Page, name: string) {
  await expect(selectDepartment(page)).toBeEnabled();
  await selectDepartment(page).press('ArrowDown');
  await page.locator('.ant-select-tree').getByText(name, { exact: true }).click();
}

async function startDownload(page: Page, label: string) {
  await download(page).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await allow(page);
  await page.route('**/hr-analysis/reports', (route) => route.fulfill({ json: reportCatalog() }));
  await page.route(path('quality'), (route) => route.fulfill({ json: result(route) }));
  await page.route(path('position'), (route) => route.fulfill({ json: result(route) }));
  await page.route(candidates, (route) => route.fulfill({ json: nodes() }));
});

test('AC-FE-R2f-07 两入口使用已运行条件下载两种模式，任职表只显示回执列和合计', async ({ page }) => {
  const reads: Record<string, string>[] = [];
  const exports: Record<string, string>[] = [];
  const options: Record<string, string>[] = [];
  await page.route(candidates, (route) => {
    options.push(params(route));
    return route.fulfill({ json: nodes() });
  });
  await page.route(path('quality'), (route) => {
    reads.push(params(route));
    return route.fulfill({ json: result(route) });
  });
  await page.route(exportPath, (route) => {
    exports.push(params(route));
    expect(requestTenant(route)).toBe(tenant);
    return route.fulfill(file);
  });

  for (const entrance of ['catalog', 'analytics']) {
    await page.goto('/hr-reports');
    await expect(main(page).getByRole('button', { name: position, exact: true })).toHaveCount(0);
    if (entrance === 'catalog') await main(page).getByRole('button', { name: quality, exact: true }).click();
    else {
      await page.getByRole('button', { name: '应用导航' }).click();
      const panel = page.getByRole('dialog', { name: '全部菜单' });
      await panel.getByRole('searchbox').fill('员工结构');
      await panel.getByRole('link', { name: /员工结构/ }).click();
      await expect(page).toHaveURL(/\/hr-structure-reports\/quality$/);
    }
    await expect(main(page).getByRole('heading', { name: quality, exact: true }).first()).toBeVisible();
    await expect(selectDepartment(page)).toBeEnabled();
    expect(reads.at(-1)).toEqual({ asOf: today, employType: 'internal', departmentIncludeChildren: 'true' });
    await dateInput(page).fill(past);
    await expect.poll(() => options.at(-1)).toEqual({ object: 'HrStructureReport', asOf: past });
    await pickDepartment(page, prefix + '部门');
    await expect(main(page).getByRole('checkbox', { name: '包含下级' })).toBeChecked();
    await main(page).getByRole('checkbox', { name: '包含下级' }).uncheck();
    await main(page).getByRole('combobox', { name: '雇佣关系' }).press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="实习生"]').click();
    await query(page).click();
    await expect(main(page).getByText(/当前结果条件.*2026-04-01.*实习生.*ZZ_FER2F_部门/)).toBeVisible();
    const applied = { asOf: past, employType: 'intern', departmentId: department, departmentIncludeChildren: 'false' };
    expect(reads.at(-1)).toEqual(applied);
    await dateInput(page).fill(draft);
    await expect(main(page).locator('tfoot')).toContainText('34.8');
    for (const [mode, label] of [
      ['formula', formula],
      ['data', dataOnly],
    ]) {
      const saved = page.waitForEvent('download');
      await startDownload(page, label!);
      await saved;
      expect(exports.at(-1)).toEqual({ ...applied, mode });
    }
  }

  await main(page).getByRole('link', { name: position, exact: true }).click();
  await expect(download(page)).toHaveCount(0);
  await expect(main(page).locator('thead th')).toHaveText([
    '一级组织',
    '合计',
    prefix + '来源',
    prefix + '类别',
    '实习生占比',
  ]);
  await expect(main(page).locator('tbody')).toContainText('16.67%');
  await expect(main(page).locator('tfoot td')).toHaveText(['合计', '21', '2', '3', '16.67%']);
});

test('AC-FE-R2f-11 候选失败后可用已应用部门查询，范围外空结果与无数据权限分开', async ({ page }) => {
  let fail = false;
  let scope = true;
  const reads: Record<string, string>[] = [];
  await page.route(candidates, (route) =>
    fail ? route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }) : route.fulfill({ json: nodes() }),
  );
  await page.route(path('position'), (route) => {
    const filters = params(route);
    reads.push(filters);
    return route.fulfill({ json: result(route, undefined, scope, !scope || filters.departmentId === outside) });
  });
  await page.goto(`${analytics}/position`);
  await expect(selectDepartment(page)).toBeEnabled();
  await expect(main(page).locator('table')).toBeVisible();
  await pickDepartment(page, prefix + '范围外（已停用）');
  await query(page).click();
  await expect(main(page).getByText('该报表暂无数据', { exact: true })).toBeVisible();
  await expect(main(page).getByText('无数据权限', { exact: true })).toHaveCount(0);
  expect(reads.at(-1)?.departmentId).toBe(outside);

  // 草稿里的另一部门随候选读失败停用，查询继续使用已应用的范围外部门。
  await pickDepartment(page, prefix + '部门');
  fail = true;
  await dateInput(page).fill(past);
  await expect(main(page).getByText('筛选项暂不可用', { exact: true })).toBeVisible();
  await expect(selectDepartment(page)).toBeDisabled();
  await query(page).click();
  await expect(main(page).getByText('该报表暂无数据', { exact: true })).toBeVisible();
  expect(reads.at(-1)).toMatchObject({ asOf: past, departmentId: outside });
  scope = false;
  await query(page).click();
  await expect(main(page).getByText('无数据权限', { exact: true })).toBeVisible();
  fail = false;
  await actionButton(main(page), '重试筛选项').click();
  await expect(selectDepartment(page)).toBeEnabled();
});

test('AC-FE-R2f-11 B53 错误清退统计和下载，429 等待后手动重试', async ({ page }) => {
  let status = 200;
  let code = '';
  let reads = 0;
  await page.route(path('quality'), (route) => {
    reads += 1;
    return route.fulfill(
      status === 200
        ? { json: result(route) }
        : { status, headers: status === 429 ? { 'Retry-After': '3' } : {}, json: { error: { code } } },
    );
  });
  await page.goto(`${analytics}/quality`);
  await expect(download(page)).toBeVisible();
  for (const [http, errorCode, message] of [
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围'],
    [413, 'PAYLOAD_TOO_LARGE', '请求内容过大，请缩小筛选范围'],
    [404, 'NOT_FOUND', '报表不存在'],
    [403, 'FORBIDDEN', '无权查看该报表'],
    [429, 'REQUEST_RATE_LIMITED', '请求过于频繁，请稍后重试'],
    [503, 'DEPENDENCY_UNAVAILABLE', '报表加载失败，请重试'],
    [401, 'UNAUTHENTICATED', '请选择演示身份或提供会话上下文'],
  ] as const) {
    status = http;
    code = errorCode;
    const count = reads;
    await query(page).click();
    await expect(main(page).getByText(message, { exact: true })).toBeVisible();
    await expect(main(page).locator('table')).toHaveCount(0);
    await expect(download(page)).toHaveCount(0);
    const retry = actionButton(main(page), '重试');
    if (http === 401) {
      await expect(query(page)).toHaveCount(0);
      break;
    }
    if (http === 429) {
      await expect(query(page)).toBeDisabled();
      await expect(retry).toBeDisabled();
      await expect(retry).toBeEnabled({ timeout: 6000 });
    } else if (http !== 503) await expect(retry).toHaveCount(0);
    expect(reads).toBe(count + 1);
    status = 200;
    await (http === 429 || http === 503 ? retry : query(page)).click();
    await expect(download(page)).toBeVisible();
    expect(reads).toBe(count + 2);
  }
});

test('AC-FE-R2f-11 素质下载 429 期间等待，手动再试，401 清退并进入共享登录态', async ({ page }) => {
  let status = 429;
  let requests = 0;
  await page.route(exportPath, (route) => {
    requests++;
    if (status === 200) return route.fulfill(file);
    return route.fulfill({
      status,
      headers: status === 429 ? { 'Retry-After': '3' } : {},
      json: { error: { code: status === 429 ? 'REQUEST_RATE_LIMITED' : 'UNAUTHENTICATED' } },
    });
  });
  await page.goto('/hr-reports/quality');
  await startDownload(page, dataOnly);
  await expect(main(page).getByText('请求过于频繁，请稍后重试', { exact: true })).toBeVisible();
  await expect(query(page)).toBeDisabled();
  await expect(download(page)).toBeDisabled();
  await expect(download(page)).toBeEnabled({ timeout: 6000 });
  expect(requests).toBe(1);
  status = 200;
  const saved = page.waitForEvent('download');
  await startDownload(page, dataOnly);
  await saved;
  status = 401;
  await startDownload(page, dataOnly);
  await expect(main(page).getByText('请选择演示身份或提供会话上下文', { exact: true })).toBeVisible();
  await expect(main(page).locator('table')).toHaveCount(0);
  await expect(download(page)).toHaveCount(0);
  expect(requests).toBe(3);
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test('AC-FE-R2f-07/11 切页丢弃迟到的素质表和下载，换租户只读取新租户数据', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) =>
      original(input, String(input).includes('/hr-structure/reports') ? { ...init, signal: undefined } : init);
  });
  const finish = gate();
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.route(exportPath, async (route) => {
    await finish.wait;
    return route.fulfill(file);
  });
  await page.route(path('quality'), async (route) => {
    if (requestTenant(route) === otherTenant) return route.fulfill({ json: result(route, prefix + '新租户') });
    const late = params(route).asOf === past;
    if (late) await finish.wait;
    return route.fulfill({ json: result(route, late ? prefix + '迟到' : prefix + '旧租户') });
  });
  try {
    await page.goto(`${analytics}/quality`);
    await expect(main(page).getByText(prefix + '旧租户', { exact: true })).toBeVisible();
    const exporting = page.waitForRequest(exportPath);
    await startDownload(page, dataOnly);
    await exporting;
    await dateInput(page).fill(past);
    const reading = page.waitForRequest(path('quality'));
    await query(page).click();
    await reading;
    await expect(main(page).locator('table')).toHaveCount(0);
    await main(page).getByRole('link', { name: position, exact: true }).click();
    await expect(main(page).locator('tbody')).toContainText('16.67%');
    const lateRead = page.waitForResponse(path('quality'));
    const lateExport = page.waitForResponse(exportPath);
    finish.release();
    for (const response of await Promise.all([lateRead, lateExport])) await response.finished();
    await expect(main(page).getByText(prefix + '迟到', { exact: true })).toHaveCount(0);
    await expect(download(page)).toHaveCount(0);
    expect(downloads).toBe(0);

    await allow(page, [object], otherTenant);
    const nextOptions = page.waitForRequest(candidates);
    await page.goto(`${analytics}/quality`);
    await expect(main(page).getByText(prefix + '新租户', { exact: true })).toBeVisible();
    expect((await nextOptions).headers()['x-tenant-id']).toBe(otherTenant);
    await expect(main(page).getByText(/ZZ_FER2F_(旧租户|迟到)/)).toHaveCount(0);
    await expect(download(page)).toBeEnabled();
  } finally {
    finish.release();
  }
});

test('AC-FE-R2f-11 员工结构入口按报表对象守卫，未知页签不请求统计', async ({ page }) => {
  let requests = 0;
  await page.route(`**${api}/**`, (route) => {
    requests++;
    return route.fallback();
  });
  await page.goto(`${analytics}/ZZ_FER2F_unknown`);
  await expect(main(page).getByText('页面或记录不存在', { exact: true })).toBeVisible();
  await allow(page, ['TenantBase.HrRoster']);
  await page.goto(`${analytics}/position`);
  await expect(main(page).getByText('暂无访问权限', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '应用导航' }).click();
  const panel = page.getByRole('dialog', { name: '全部菜单' });
  await panel.getByRole('searchbox').fill('员工结构');
  await expect(panel.getByRole('link', { name: /员工结构/ })).toHaveCount(0);
  expect(requests).toBe(0);
});
