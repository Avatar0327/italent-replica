import type { Page, Route } from '@playwright/test';
import { HR_MOVEMENT_COMPONENTS, HR_MOVEMENT_OBJECT, HR_STRUCTURE_OBJECT, movementMonths } from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

const overview = /\/analytics\/hr-movement(?:\?|$)/;
const details = /\/analytics\/hr-movement\/components\//;
const candidates = '**/analytics/organization-candidates?*';
const prefix = 'ZZ_FER2F_S3_';
const today = '2026-10-26';
const root = '10000000-0000-4000-8000-000000000081';
const child = '10000000-0000-4000-8000-000000000082';
const capacity = '10000000-0000-4000-8000-000000000092';
const type = '["leave","甲 & / +"]';
const reason = '["leave","甲 & / +",null]';
const months = movementMonths(today)!;

function snapshot(page: Page, objects: string[]) {
  return page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, today },
        apps: snapshotFixture.apps.map((app) => (app.app === 'staff' ? { ...app, entryObjects: objects } : app)),
      },
    }),
  );
}

function board(asOf = today, hasDataPermission = true, count = 24) {
  const monthly = months.map(({ key }) => ({ key, label: key, count: key === '2026-02' ? count : 0 }));
  const parts = [
    { key: type, label: prefix + '类型', count, parent: null },
    { key: reason, label: prefix + '原因', count, parent: type },
  ];
  const groups = {
    '6.25': monthly,
    '6.26': monthly.flatMap(({ key, count }) => [
      { key: 'hire:' + key, label: key + ' 入职', count: 0 },
      { key: 'exit:' + key, label: key + ' 离职', count },
    ]),
    '6.27': [{ key: '["transfer"]', label: prefix + '调动', count }],
    '6.28': monthly.map((point) => ({
      ...point,
      opening: 1000,
      closing: 1000,
      rate: point.count ? 0.1308 : 0,
    })),
    '6.29': parts,
    '6.30': parts,
    '6.31': [{ key: 'under6m', label: prefix + '司龄', count }],
    '6.32': [{ key: child, label: prefix + '仅有未转正短司龄离职实习生的部门', count: 1, ratio: 1 }],
    '3.1.36': Array.from({ length: 21 }, (_, index) => ({
      key: index === 20 ? capacity : `10000000-0000-4000-8010-${String(index).padStart(12, '0')}`,
      orgId: index === 20 ? child : root,
      label: prefix + '编制' + index,
      localCapacity: null,
      inclusiveCapacity: index === 20 ? 30 : null,
      count,
      pendingIn: index === 20 ? 7 : 0,
      pendingOut: index === 20 ? 3 : 0,
      vacancy: index === 20 ? 2 : null,
      executionRate: index === 20 ? 0.9333 : null,
    })),
  };
  return {
    asOf,
    hasDataPermission,
    components: HR_MOVEMENT_COMPONENTS.map((item) => {
      const total = item.kind === 'series' || item.kind === 'table' ? null : count;
      return { ...item, value: item.code === '6.32' ? 1 : total, groups: groups[item.code] };
    }),
  };
}

const card = (page: Page, code: (typeof HR_MOVEMENT_COMPONENTS)[number]['code']) =>
  page.getByRole('article', { name: HR_MOVEMENT_COMPONENTS.find((item) => item.code === code)!.name, exact: true });
const query = (page: Page) => page.getByRole('button', { name: /^查\s*询$/ });
const open = (page: Page, code: Parameters<typeof card>[1]) =>
  card(page, code).getByRole('button', { name: '查看详情', exact: true });

async function select(page: Page, field: string, label: string) {
  const control = page.getByRole('combobox', { name: field, exact: true });
  await expect(control).toBeEnabled();
  await control.press('ArrowDown');
  await page
    .locator('.ant-select-dropdown:visible:not([class*="-leave"])')
    .locator('.ant-select-tree-title, .ant-select-item-option-content')
    .getByText(label, { exact: true })
    .click({ timeout: 8000 });
}

function detail(route: Route) {
  const url = new URL(route.request().url());
  const code = url.pathname.split('/').at(-1)!;
  const page = Number(url.searchParams.get('page'));
  const id = prefix + 'row_' + page;
  return {
    ...HR_MOVEMENT_COMPONENTS.find((item) => item.code === code),
    asOf: url.searchParams.get('asOf'),
    hasDataPermission: true,
    group: url.searchParams.get('group'),
    total: 24,
    page,
    pageSize: 20,
    items: [{ id, employeeId: id, organizationId: child }],
  };
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await snapshot(page, [HR_MOVEMENT_OBJECT]);
  await page.route(overview, (route) => route.fulfill({ json: board() }));
  await page.route(candidates, (route) =>
    route.fulfill({
      json: {
        items: [
          { id: root, name: prefix + '部门', parentId: null, enabled: true },
          { id: child, name: prefix + '未应用部门', parentId: null, enabled: true },
        ],
      },
    }),
  );
});

test('AC-FE-R2f-01 B50 单授权入口、无权和未知后缀', async ({ page }) => {
  const forbidden: string[] = [];
  page.on('request', (request) => {
    if (/\/analytics\/(hr-dashboard|hr-structure)(?:[/?]|$)/.test(request.url())) forbidden.push(request.url());
  });
  await page.goto('/hr-dashboard');
  await expect(page, 'B50 单授权访问根路径应打开人员流动分析').toHaveURL(/\/hr-dashboard\/movement$/, {
    timeout: 5000,
  });
  const tabs = page.getByRole('navigation', { name: '人事看板' });
  await expect(tabs.getByRole('link')).toHaveText(['人员流动分析']);
  for (const suffix of ['management', 'structure']) {
    await page.goto('/hr-dashboard/' + suffix);
    await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  }
  await page.goto('/hr-dashboard/unknown');
  await expect(page.getByText('页面或记录不存在', { exact: true })).toBeVisible();
  expect(forbidden).toEqual([]);
});

test('AC-FE-R2f-04 部门、月份、双环、独立编制和实习生占位', async ({ page }) => {
  const queries: URL[] = [];
  const calls: URL[] = [];
  await page.route(overview, (route) => {
    queries.push(new URL(route.request().url()));
    return route.fulfill({ json: board(queries.length === 1 ? today : '2026-10-27') });
  });
  await page.route(details, (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    if (url.pathname.endsWith('/6.32') || !url.searchParams.has('group')) return route.fulfill({ status: 400 });
    return route.fulfill({ json: detail(route) });
  });
  await page.goto('/hr-dashboard/movement');
  await expect(page.getByRole('article'), 'B50 应展示 9 个组件').toHaveCount(9, { timeout: 5000 });
  expect(
    await page.getByRole('article').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
  ).toEqual(HR_MOVEMENT_COMPONENTS.map(({ name }) => name));
  await select(page, '部门', prefix + '部门');
  await query(page).click();
  await expect(page.getByText(/部门 ZZ_FER2F_S3_部门（包含下级）/)).toBeVisible();
  expect(Object.fromEntries(queries[1]!.searchParams)).toEqual({ asOf: today, departmentId: root });

  const suppressed = card(page, '6.32');
  await expect(suppressed.getByText('统计口径暂不可用', { exact: true })).toBeVisible();
  await expect(suppressed.getByText(/^(1|100%|共 1 人)$/)).toHaveCount(0);
  await expect(suppressed.getByRole('button')).toHaveCount(0);
  await expect(card(page, '6.28').getByText('13.08%', { exact: true })).toBeVisible();

  const drawer = page.getByRole('dialog');
  async function close() {
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(drawer).toHaveCount(0);
  }
  await select(page, '部门', prefix + '未应用部门');
  await open(page, '6.26').click();
  await expect(drawer.getByText(/部门 ZZ_FER2F_S3_部门（包含下级）/)).toBeVisible();
  await expect(drawer.getByRole('combobox', { name: '分组' })).toBeVisible();
  expect(calls).toEqual([]);
  await select(page, '分组', '2026-02 离职');
  await expect(drawer.getByText(prefix + 'row_1')).toBeVisible();
  await expect(drawer.getByRole('columnheader', { name: '员工 ID' })).toBeVisible();
  await drawer.getByTitle('2', { exact: true }).click();
  await expect(drawer.getByText(prefix + 'row_2')).toBeVisible();
  await close();

  await card(page, '6.28')
    .getByRole('button', { name: /查看详情.*2026-02.*13\.08%/ })
    .click();
  await expect(drawer.getByText('共 24 条')).toBeVisible();
  await close();

  await card(page, '6.29')
    .getByRole('button', { name: /查看详情.*ZZ_FER2F_S3_原因/ })
    .click();
  await expect(drawer.getByText(prefix + 'row_1')).toBeVisible();
  await close();

  const table = card(page, '3.1.36');
  await expect(table.getByText('按分析范围统计', { exact: false }).first()).toBeVisible();
  await expect(table.getByText(prefix + '编制20', { exact: true })).toHaveCount(0);
  await table.getByTitle('2', { exact: true }).click();
  await expect(table.getByText(prefix + '编制20', { exact: true })).toBeVisible();
  for (const n of ['7', '3', '2', '93.33%'])
    await expect(table.getByRole('cell', { name: n, exact: true })).toBeVisible();
  await table.getByRole('button', { name: /查看详情.*ZZ_FER2F_S3_编制20/ }).click();
  await expect(drawer.getByText(prefix + 'row_1')).toBeVisible();
  expect(calls.map((url) => [url.pathname.split('/').at(-1), Object.fromEntries(url.searchParams)])).toEqual(
    [
      ['6.26', 'exit:2026-02', '1'],
      ['6.26', 'exit:2026-02', '2'],
      ['6.28', '2026-02', '1'],
      ['6.29', reason, '1'],
      ['3.1.36', capacity, '1'],
    ].map(([code, group, page]) => [code, { asOf: '2026-10-27', departmentId: root, group, page, pageSize: '20' }]),
  );
  await page.locator('.hr-dashboard-filters form').evaluate((element: HTMLFormElement) => element.requestSubmit());
  await expect(drawer).toHaveCount(0);
  await expect(table.getByText(prefix + '编制0', { exact: true })).toBeVisible();
  expect(queries[2]?.searchParams.get('departmentId')).toBe(child);
});

test('AC-FE-R2f-11 候选拒绝及无数据权限区别于真实零值，详情拒绝清退旧看板', async ({ page }) => {
  let reads = 0;
  await page.route(overview, (route) => route.fulfill({ json: board(today, ++reads !== 1, 0) }));
  await page.route(candidates, (route) => route.fulfill({ status: 403 }));
  await page.route(details, (route) => route.fulfill({ status: 403 }));
  await page.goto('/hr-dashboard/movement');
  await expect(page.getByText('无数据权限', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('combobox', { name: '部门' })).toBeDisabled();
  await expect(page.getByText('筛选项暂不可用', { exact: true })).toBeVisible();
  await expect(open(page, '6.28')).toBeDisabled();
  await query(page).click();
  await expect(page.getByText('无数据权限', { exact: true })).toHaveCount(0);
  await card(page, '6.28')
    .getByRole('button', { name: /查看详情.*2026-02.*0%/ })
    .click();
  await expect(page.getByText('无权查看该组件', { exact: true })).toBeVisible();
  await expect(page.getByText('无权查看该看板', { exact: true })).toBeVisible();
  await expect(card(page, '6.28')).toHaveCount(0);
});

test('AC-FE-R2f-11 切至 B49 后迟到的 B50 概览不得显示', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) =>
      fetch(input, String(input).includes('/hr-movement?') ? { ...options, signal: undefined } : options);
  });
  await snapshot(page, [HR_MOVEMENT_OBJECT, HR_STRUCTURE_OBJECT]);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(overview, async (route) => {
    await waiting;
    await route.fulfill({ json: board() });
  });
  await page.route('**/analytics/hr-structure?*', (route) =>
    route.fulfill({ json: { asOf: today, hasDataPermission: true, components: [] } }),
  );
  await page.goto('/hr-dashboard/movement');
  await expect(page.getByRole('heading', { name: '人员流动分析', exact: true })).toBeVisible({ timeout: 5000 });
  const tabs = page.getByRole('navigation', { name: '人事看板' });
  const late = page.waitForResponse(overview);
  try {
    await tabs.getByRole('link', { name: '人员结构分析' }).click();
    await expect(page.getByRole('heading', { name: '人员结构分析', exact: true })).toBeVisible();
  } finally {
    release();
  }
  expect((await late).status()).toBe(200);
  await expect(card(page, '6.25')).toHaveCount(0);
});

test('AC-FE-R2f-11 看板 400、404、413、429、503 清退结果并按错误语义重试', async ({ page }) => {
  const errors = [
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围'],
    [404, 'NOT_FOUND', '看板不存在'],
    [413, 'PAYLOAD_TOO_LARGE', '请缩小筛选范围后重试'],
    [429, 'RATE_LIMITED', '请求过于频繁，请稍后重试'],
    [503, 'UNAVAILABLE', '看板加载失败，请重试'],
  ] as const;
  let fault: (typeof errors)[number] | undefined;
  let reads = 0;
  await page.route(overview, (route) => {
    reads++;
    return fault
      ? route.fulfill({
          status: fault[0],
          headers: fault[0] === 429 ? { 'Retry-After': '2' } : undefined,
          json: { error: { code: fault[1], message: prefix + 'internal' } },
        })
      : route.fulfill({ json: board() });
  });
  await page.goto('/hr-dashboard/movement');
  await expect(card(page, '6.25')).toBeVisible();
  for (const error of errors) {
    fault = error;
    await query(page).click();
    const alert = page.getByRole('alert').filter({ hasText: error[2] });
    await expect(alert).toBeVisible();
    await expect(card(page, '6.25')).toHaveCount(0);
    await expect(page.getByText(prefix + 'internal')).toHaveCount(0);
    const retry = alert.getByRole('button', { name: /重\s*试/ });
    fault = undefined;
    if (error[0] === 429) {
      await expect(retry).toBeDisabled();
      await expect(query(page)).toBeDisabled();
      const prior = reads;
      await expect(retry).toBeEnabled({ timeout: 5000 });
      expect(reads).toBe(prior);
    }
    if (error[0] >= 429) await retry.click();
    else {
      await expect(retry).toHaveCount(0);
      await query(page).click();
    }
    await expect(card(page, '6.25')).toBeVisible();
  }
});

test('AC-FE-R2f-11 明细 401 切回共享会话态并清退本次概览和抽屉', async ({ page }) => {
  await page.route(details, (route) => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } }));
  await page.goto('/hr-dashboard/movement');
  await open(page, '6.27').click();
  await expect(page.getByText('请选择演示身份或提供会话上下文', { exact: true })).toBeVisible();
  await expect(card(page, '6.25')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
