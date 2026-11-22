import type { Page, Route } from '@playwright/test';
import { actionButton } from './action-button.js';
import { expect, seedDemoUser, snapshotFixture, tenant, test } from './fixtures.js';
import { reportCatalog } from './hr-reports-fixtures.js';

const prefix = 'ZZ_FER2F_';
const object = 'TenantBase.HrMovementReport';
const entry = '/hr-movement-reports';
const api = '/api/tenant/analytics/hr-movement/reports';
const candidates = '**/analytics/organization-candidates?*';
const path = (code: string) => `**${api}/${code}?*`;
const parent = '10000000-0000-4000-8000-000000000002';
const child = '10000000-0000-4000-8000-000000000003';
const outside = '10000000-0000-4000-8000-000000000004';
const otherTenant = '10000000-0000-4000-8000-000000000005';
const grandchild = '10000000-0000-4000-8000-000000000006';
const today = snapshotFixture.session.today;
const past = '2026-04-15';
const flow = '员工流动统计';
const monthly = '各月入离职统计';
const institution = '各机构入离职统计';
const reportNames = { flow, monthly, institution };
const file = { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'PK' };
const modes = { formula: '下载（含公式、隐藏行/列）', data: '仅下载数据' };
const labels = { parent: prefix + '上级', child: prefix + '中级', leaf: prefix + '末级', outside: prefix + '范围外' };
const nodes = {
  items: [
    { id: tenant, parentId: null, name: prefix + '根', enabled: true },
    { id: parent, parentId: tenant, name: labels.parent, enabled: true },
    { id: child, parentId: parent, name: labels.child, enabled: true },
    { id: grandchild, parentId: child, name: labels.leaf, enabled: true },
    { id: outside, parentId: tenant, name: labels.outside, enabled: false },
  ],
};

const main = (page: Page) => page.locator('.shell-workspace');
const query = (page: Page) => actionButton(main(page), '查询');
const download = (page: Page) => actionButton(main(page), '下载 ▾');
const input = (page: Page, label: string) => main(page).getByLabel(label, { exact: true });
const department = (page: Page) => main(page).getByRole('combobox', { name: '部门', exact: true });
const params = (route: Route) => Object.fromEntries(new URL(route.request().url()).searchParams);
const requestTenant = (route: Route) => route.request().headers()['x-tenant-id'];

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
async function pick(page: Page, label: string) {
  await expect(department(page)).toBeEnabled();
  await department(page).press('ArrowDown');
  await page.locator('.ant-select-tree').getByText(label, { exact: true }).click();
}
async function startDownload(page: Page, mode: keyof typeof modes) {
  await download(page).click();
  await page.getByRole('menuitem', { name: modes[mode], exact: true }).click();
}

function result(
  route: Route,
  code: keyof typeof reportNames,
  options: { label?: string; scope?: boolean; empty?: boolean } = {},
) {
  const { asOf = today, year = asOf.slice(0, 4), parentId, month } = params(route);
  const lastMonth = year === asOf.slice(0, 4) ? asOf.slice(5, 7) : '12';
  const cells: Record<string, number | null> =
    code === 'flow'
      ? { yearStart: 100, yearEnd: 120, growthRate: 0.1818 }
      : { opening: 10, hires: 2, exits: 1, closing: 11, rate: 0.0952 };
  const title = reportNames[code];
  const row = (key: string, label: string, values = cells) => ({ key, label, cells: values });
  let rows = [row(parent, options.label ?? labels.parent)];
  if (code === 'flow' && parentId === parent) rows = [row(parent, labels.parent), row(child, labels.child)];
  if (code === 'flow' && parentId === child) rows = [row(child, labels.child), row(grandchild, labels.leaf)];
  if (code === 'monthly')
    rows = Array.from({ length: 12 }, (_, i) => {
      const key = `${year}-${String(i + 1).padStart(2, '0')}`;
      return {
        key,
        label: key,
        cells: key > asOf.slice(0, 7) ? { opening: null, hires: null, exits: null, closing: null, rate: null } : cells,
      };
    });
  const columns =
    code === 'flow'
      ? [
          { key: 'yearStart', label: '年初人数' },
          { key: 'yearEnd', label: '年底人数' },
          { key: 'growthRate', label: '绝对增长率' },
        ]
      : [
          { key: 'opening', label: '期初人数' },
          { key: 'hires', label: '入职人数' },
          { key: 'exits', label: '离职人数' },
          { key: 'closing', label: '期末人数' },
          { key: 'rate', label: '离职率' },
        ];
  return {
    asOf,
    year: Number(year),
    month: code === 'institution' ? Number(month ?? lastMonth) : null,
    kind: 'table',
    report: code,
    name: title,
    hasDataPermission: options.scope ?? true,
    tables: [
      {
        key: code,
        name: title,
        columns,
        rows: options.empty ? [] : rows,
        summary: { cells: options.empty ? { opening: 0, hires: 0, exits: 0, closing: 0, rate: 0 } : cells },
      },
    ],
  };
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await allow(page);
  await page.route('**/hr-analysis/reports', (route) => route.fulfill({ json: reportCatalog() }));
  for (const code of ['flow', 'monthly', 'institution'] as const)
    await page.route(path(code), (route) => route.fulfill({ json: result(route, code) }));
  await page.route(candidates, (route) => route.fulfill({ json: nodes }));
});

test('AC-FE-R2f-08 菜单打开年度流动，连续下钻与逐层返回都保留已运行的年度和部门', async ({ page }) => {
  const reads: Record<string, string>[] = [];
  await page.route(path('flow'), (route) => {
    reads.push(params(route));
    return route.fulfill({ json: result(route, 'flow') });
  });
  await page.goto('/hr-reports');
  await page.getByRole('button', { name: '应用导航' }).click();
  const panel = page.getByRole('dialog', { name: '全部菜单' });
  await panel.getByRole('searchbox').fill('流动情况');
  await panel.getByRole('link', { name: /流动情况/ }).click();
  await expect(page).toHaveURL(`${entry}/flow`);
  await expect(main(page).getByRole('navigation', { name: '流动情况' }).getByRole('link')).toHaveText([
    flow,
    monthly,
    institution,
    '员工流入统计',
    '员工流出统计',
    '组织编制统计',
  ]);
  await expect(main(page).locator('tbody')).toContainText('18.2%');
  await expect(download(page)).toHaveCount(0);
  await expect(main(page).getByRole('checkbox', { name: '包含下级' })).toHaveCount(0);
  expect(reads.at(-1)).toEqual({ asOf: today, year: '2026' });

  await input(page, '时点日期').fill(past);
  await input(page, '年度').fill('2025');
  await pick(page, labels.parent);
  await query(page).click();
  const table = main(page).locator('tbody');
  await expect(table).toContainText(labels.parent);
  const applied = { asOf: past, year: '2025', departmentId: parent };
  expect(reads.at(-1)).toEqual(applied);
  // 尚未运行的草稿不能进入下钻条件。
  await input(page, '年度').fill('2024');
  await actionButton(table, labels.parent).click();
  await expect(table.getByText(labels.parent, { exact: true })).toBeVisible();
  await expect(actionButton(table, labels.parent)).toHaveCount(0);
  await actionButton(table, labels.child).click();
  await expect(table).toContainText(labels.leaf);
  const trail = main(page).getByRole('navigation', { name: '组织层级' });
  await actionButton(trail, labels.parent).click();
  await expect(table).toContainText(labels.child);
  await actionButton(trail, '一级组织').click();
  await expect(actionButton(table, labels.parent)).toBeVisible();
  expect(reads.slice(-5)).toEqual([
    applied,
    { ...applied, parentId: parent },
    { ...applied, parentId: child },
    { ...applied, parentId: parent },
    applied,
  ]);
});

test('AC-FE-R2f-08 各月和各机构在两个入口使用相同条件，两种下载只带已运行筛选', async ({ page }) => {
  const requests: { filters: Record<string, string>; tenant: string | undefined }[] = [];
  await page.route(`**${api}/*/export?*`, (route) => {
    requests.push({ filters: params(route), tenant: requestTenant(route) });
    return route.fulfill(file);
  });
  for (const [code, name] of [
    ['monthly', monthly],
    ['institution', institution],
  ] as const) {
    for (const source of [entry, '/hr-reports']) {
      await page.goto(`${source}/${code}`);
      await expect(main(page).getByRole('heading', { name, exact: true }).first()).toBeVisible();
      await expect(main(page).locator('table')).toBeVisible();
      if (code === 'monthly') {
        const future = main(page).getByRole('row').filter({ hasText: '2026-11' });
        await expect(future.getByRole('cell')).toHaveText(['2026-11', '—', '—', '—', '—', '—']);
      } else {
        await expect(input(page, '月份')).toHaveValue('10');
        await input(page, '月份').fill('4');
      }
      await input(page, '时点日期').fill(past);
      await pick(page, labels.parent);
      await query(page).click();
      await expect(main(page).getByText(/当前结果条件.*2026-04-15.*ZZ_FER2F_上级/)).toBeVisible();
      await input(page, '年度').fill('2025');
      if (code === 'institution') await input(page, '月份').fill('2');
      await expect(main(page).locator('tbody').getByRole('button')).toHaveCount(0);
      for (const mode of ['formula', 'data'] as const) {
        const saved = page.waitForEvent('download');
        await startDownload(page, mode);
        expect((await saved).suggestedFilename()).toBe(`${name}.xlsx`);
        expect(requests.at(-1)).toEqual({
          tenant,
          filters: {
            asOf: past,
            year: '2026',
            departmentId: parent,
            ...(code === 'institution' ? { month: '4' } : {}),
            mode,
          },
        });
      }
    }
  }
});

test('AC-FE-R2f-08 各机构月份越界保留草稿，确认有效月份后查询', async ({ page }) => {
  let reads = 0;
  await page.route(path('institution'), (route) => {
    reads++;
    return route.fulfill({ json: result(route, 'institution') });
  });
  await page.goto(`${entry}/institution`);
  await expect(input(page, '月份')).toHaveValue('10');
  await input(page, '时点日期').fill(past);
  await expect(input(page, '月份')).toHaveAttribute('max', '4');
  await query(page).click();
  await expect(main(page).getByText('请检查筛选条件和日期范围', { exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await expect(input(page, '月份')).toHaveValue('10');
  await input(page, '月份').fill('4');
  await query(page).click();
  await expect(main(page).getByText(/当前结果条件.*2026-04-15.*月份 4/)).toBeVisible();
  expect(reads).toBe(2);

  await input(page, '年度').fill('2025');
  await expect(input(page, '月份')).toHaveAttribute('max', '12');
  await input(page, '月份').fill('');
  await query(page).click();
  await expect(main(page).getByText(/当前结果条件.*年度 2025.*月份 12/)).toBeVisible();
  expect(reads).toBe(3);
});

test('AC-FE-R2f-11 B54 候选失败保留已应用部门，范围外空结果和无数据权限分别显示', async ({ page }) => {
  let failed = false;
  let scope = true;
  const options: Record<string, string>[] = [];
  const reads: Record<string, string>[] = [];
  await page.route(candidates, (route) => {
    options.push(params(route));
    return failed
      ? route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } })
      : route.fulfill({ json: nodes });
  });
  await page.route(path('institution'), (route) => {
    const filters = params(route);
    reads.push(filters);
    return route.fulfill({ json: result(route, 'institution', { scope, empty: filters.departmentId === outside }) });
  });
  await page.goto(`${entry}/institution`);
  await expect(download(page)).toBeVisible();
  await pick(page, `${labels.outside}（已停用）`);
  expect(options.at(-1)).toEqual({ object: 'HrMovementReport', asOf: today });
  await query(page).click();
  await expect(main(page).getByText('该报表暂无数据', { exact: true })).toBeVisible();
  await expect(main(page).getByText('无数据权限', { exact: true })).toHaveCount(0);
  await expect(main(page).locator('tfoot')).toContainText('0%');
  expect(reads.at(-1)?.departmentId).toBe(outside);

  // 草稿改了部门，但候选拒绝后只能用已应用的部门查询。
  await pick(page, labels.parent);
  failed = true;
  await input(page, '时点日期').fill(past);
  await input(page, '月份').fill('4');
  await expect(main(page).getByText('筛选项暂不可用', { exact: true })).toBeVisible();
  await expect(department(page)).toBeDisabled();
  await query(page).click();
  await expect(main(page).getByText(/当前结果条件.*2026-04-15.*ZZ_FER2F_范围外/)).toBeVisible();
  expect(reads.at(-1)).toEqual({ asOf: past, year: '2026', month: '4', departmentId: outside });
  scope = false;
  await query(page).click();
  await expect(main(page).getByText('无数据权限', { exact: true })).toBeVisible();
  await expect(main(page).locator('tbody').getByText(labels.parent, { exact: true })).toHaveCount(0);
  await expect(download(page)).toBeVisible();
  failed = false;
  await actionButton(main(page), '重试筛选项').click();
  await expect(department(page)).toBeEnabled();
});

test('AC-FE-R2f-11 B54 读取失败清退表和下载，429 到期前禁止重试，503 手动重试', async ({ page }) => {
  let failure: { status: number; code: string } | undefined;
  let reads = 0;
  await page.route(path('monthly'), (route) => {
    reads++;
    if (!failure) return route.fulfill({ json: result(route, 'monthly') });
    return route.fulfill({
      status: failure.status,
      headers: failure.status === 429 ? { 'Retry-After': '2' } : {},
      json: { error: { code: failure.code } },
    });
  });
  await page.goto(`${entry}/monthly`);
  await expect(download(page)).toBeVisible();
  for (const [status, code, message] of [
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围'],
    [413, 'PAYLOAD_TOO_LARGE', '请求内容过大，请缩小筛选范围'],
    [404, 'NOT_FOUND', '报表不存在'],
    [403, 'FORBIDDEN', '无权查看该报表'],
    [429, 'REQUEST_RATE_LIMITED', '请求过于频繁，请稍后重试'],
    [503, 'DEPENDENCY_UNAVAILABLE', '报表加载失败，请重试'],
    [401, 'UNAUTHENTICATED', '请选择演示身份或提供会话上下文'],
  ] as const) {
    failure = { status, code };
    const before = reads;
    await query(page).click();
    await expect(main(page).getByText(message, { exact: true })).toBeVisible();
    await expect(main(page).locator('table')).toHaveCount(0);
    await expect(download(page)).toHaveCount(0);
    const retry = actionButton(main(page), '重试');
    if (status === 401) {
      await expect(query(page)).toHaveCount(0);
      break;
    }
    if (status === 429) {
      await expect(query(page)).toBeDisabled();
      await expect(retry).toBeDisabled();
      await expect(retry).toBeEnabled();
    } else if (status !== 503) await expect(retry).toHaveCount(0);
    expect(reads).toBe(before + 1);
    failure = undefined;
    await (status === 429 || status === 503 ? retry : query(page)).click();
    await expect(download(page)).toBeVisible();
    expect(reads).toBe(before + 2);
  }
});

test('AC-FE-R2f-11 目录详情应用 B54 下载退避和撤权规则', async ({ page }) => {
  let status = 429;
  let requests = 0;
  await page.route(path('institution/export'), (route) => {
    requests++;
    if (status === 200) return route.fulfill(file);
    return route.fulfill({
      status,
      headers: status === 429 ? { 'Retry-After': '2' } : {},
      json: { error: { code: status === 429 ? 'REQUEST_RATE_LIMITED' : 'FORBIDDEN' } },
    });
  });
  await page.goto('/hr-reports/institution');
  await startDownload(page, 'data');
  await expect(main(page).getByText('请求过于频繁，请稍后重试', { exact: true })).toBeVisible();
  await expect(download(page)).toBeDisabled();
  await expect(query(page)).toBeDisabled();
  await expect(download(page)).toBeEnabled();
  expect(requests).toBe(1);
  status = 200;
  const saved = page.waitForEvent('download');
  await startDownload(page, 'data');
  await saved;
  status = 403;
  await startDownload(page, 'formula');
  await expect(main(page).getByText('无权导出该报表', { exact: true })).toBeVisible();
  await expect(main(page).locator('table')).toHaveCount(0);
  await expect(download(page)).toHaveCount(0);
  expect(requests).toBe(3);
});

test('AC-FE-R2f-11 B54 切页拒绝迟到的读取和文件，切到新租户重读候选', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) =>
      original(input, String(input).includes('/hr-movement/reports') ? { ...init, signal: undefined } : init);
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.route(path('institution/export'), async (route) => {
    await wait;
    return route.fulfill(file);
  });
  await page.route(path('institution'), async (route) => {
    if (requestTenant(route) === otherTenant)
      return route.fulfill({ json: result(route, 'institution', { label: prefix + '新租户' }) });
    const late = params(route).asOf === past;
    if (late) await wait;
    return route.fulfill({ json: result(route, 'institution', { label: prefix + (late ? '迟到结果' : '旧租户') }) });
  });
  try {
    await page.goto(`${entry}/institution`);
    await expect(main(page).locator('tbody')).toContainText(prefix + '旧租户');
    const exporting = page.waitForRequest(path('institution/export'));
    await startDownload(page, 'data');
    await exporting;
    await input(page, '时点日期').fill(past);
    await input(page, '月份').fill('4');
    const reading = page.waitForRequest(path('institution'));
    await query(page).click();
    await reading;
    await expect(main(page).locator('table')).toHaveCount(0);
    await main(page).getByRole('link', { name: flow, exact: true }).click();
    await expect(main(page).locator('tbody')).toContainText('18.2%');
    const lateRead = page.waitForResponse(path('institution'));
    const lateExport = page.waitForResponse(path('institution/export'));
    release();
    for (const response of await Promise.all([lateRead, lateExport])) await response.finished();
    await expect(main(page).locator('tbody')).toContainText('18.2%');
    await expect(main(page).getByText(prefix + '迟到结果')).toHaveCount(0);
    await expect(download(page)).toHaveCount(0);
    expect(downloads).toBe(0);

    await allow(page, [object], otherTenant);
    const nextOptions = page.waitForRequest(candidates);
    await page.goto(`${entry}/institution`);
    await expect(main(page).locator('tbody')).toContainText(prefix + '新租户');
    expect((await nextOptions).headers()['x-tenant-id']).toBe(otherTenant);
    await expect(main(page).getByText(/ZZ_FER2F_(旧租户|迟到结果)/)).toHaveCount(0);
  } finally {
    release();
  }
});

test('AC-FE-R2f-11 B54 入口按流动报表对象守卫，未知页签和无权直链均不请求统计', async ({ page }) => {
  let reads = 0;
  await page.route(`**${api}/**`, (route) => {
    reads++;
    return route.fulfill({ json: result(route, 'flow') });
  });
  await page.goto(`${entry}/flow`);
  await expect(main(page).locator('tbody')).toContainText('18.2%');
  expect(reads).toBe(1);
  await page.goto(`${entry}/unknown`);
  await expect(main(page).getByText('页面或记录不存在', { exact: true })).toBeVisible();
  await allow(page, ['TenantBase.HrStructureReport']);
  for (const code of ['flow', 'inflow', 'outflow', 'establishment']) {
    await page.goto(`${entry}/${code}`);
    await expect(main(page).getByText('暂无访问权限', { exact: true })).toBeVisible();
  }
  expect(reads).toBe(1);
});
