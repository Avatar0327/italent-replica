import type { Page, Route } from '@playwright/test';
import { HR_STRUCTURE_COMPONENTS, HR_STRUCTURE_OBJECT } from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, tenant, test } from './fixtures.js';

const base = '/api/tenant/analytics/hr-structure';
const boardPath = /\/analytics\/hr-structure(?:\?|$)/;
const detailPath = /\/analytics\/hr-structure\/components\//;
const managementPath = /\/analytics\/hr-dashboard(?:[/?]|$)/;
const candidatePath = '**/analytics/organization-candidates?*';
const prefix = 'ZZ_FER2F_';
const today = snapshotFixture.session.today;
const root = '10000000-0000-4000-8000-000000000081';
const child = '10000000-0000-4000-8000-000000000082';
const sequence = '10000000-0000-4000-8000-000000000083';
const group = '甲 & / +';
const form = `${prefix}FullTime`;
const category = `${prefix}人员 & 类别`;
const otherTenant = '10000000-0000-4000-8000-000000000092';

function snapshot(page: Page, objects: string[], tenantId = tenant) {
  return page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, tenantId, tenantName: `${prefix}${tenantId}` },
        apps: snapshotFixture.apps.map((app) => (app.app === 'staff' ? { ...app, entryObjects: objects } : app)),
      },
    }),
  );
}

function board(value = 24, hasDataPermission = true) {
  return {
    asOf: today,
    hasDataPermission,
    components: HR_STRUCTURE_COMPONENTS.map((component) => {
      if (component.kind === 'unavailable') return { ...component, value: null, groups: null };
      if (component.kind === 'average') return { ...component, value: value ? 36.5 : null, count: value, groups: null };
      const item = { key: group, label: '合成分组甲', count: value };
      const groups = component.kind === 'groups' ? [item] : null;
      if (component.code === '6.11') return { ...component, value, groups: [{ ...item, total: 25, ratio: 0.96 }] };
      return { ...component, value, groups };
    }),
  };
}

function detail(route: Route, id: string, total = 24) {
  const { pathname, searchParams } = new URL(route.request().url());
  return {
    ...HR_STRUCTURE_COMPONENTS.find(({ code }) => pathname.endsWith(`/${code}`)),
    asOf: today,
    hasDataPermission: true,
    group: searchParams.get('group'),
    total,
    page: Number(searchParams.get('page')),
    pageSize: Number(searchParams.get('pageSize')),
    items: total ? [{ id, employeeId: id, organizationId: child }] : [],
  };
}

const card = (page: Page, code = '6.01') =>
  page.getByRole('article', { name: HR_STRUCTURE_COMPONENTS.find((item) => item.code === code)!.name, exact: true });
const query = (page: Page) => page.getByRole('button', { name: /^查\s*询$/ });
const lookup = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true });
const open = (page: Page, code = '6.01') => card(page, code).getByRole('button', { name: '查看详情', exact: true });

async function select(page: Page, field: string, label: string) {
  await lookup(page, field).click();
  await page
    .locator('.ant-select-dropdown:visible, .ant-select-tree-dropdown:visible')
    .getByText(label, { exact: true })
    .click();
}

function hold() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await snapshot(page, [HR_STRUCTURE_OBJECT]);
  await page.route(boardPath, (route) => route.fulfill({ json: board() }));
  await page.route(candidatePath, (route) =>
    route.fulfill({
      json: {
        items: [
          { id: root, name: `${prefix}机构`, parentId: null, enabled: true },
          { id: child, name: `${prefix}部门`, parentId: root, enabled: false },
        ],
      },
    }),
  );
  await page.route('**/job/sequences?*', (route) =>
    route.fulfill({
      json: { page: 1, pageSize: 200, hasDataPermission: true, items: [{ id: sequence, name: `${prefix}序列` }] },
    }),
  );
  await page.route('**/employment/employment-forms', (route) =>
    route.fulfill({ json: { items: [{ code: form, name: `${prefix}用工` }] } }),
  );
  await page.route('**/employment/employment-types/options', (route) =>
    route.fulfill({ json: { items: [{ id: 'ignored', name: category }] } }),
  );
});

test('AC-FE-R2f-01 只授 B49 的身份直接进 B49，B48 无页签且直链无权、无 B48 请求', async ({ page }) => {
  const management: string[] = [];
  page.on('request', (request) => {
    if (managementPath.test(request.url())) management.push(request.url());
  });
  await page.goto('/hr-dashboard');
  await expect(page, 'B49 单授权访问根路径应打开人员结构页签').toHaveURL(/\/hr-dashboard\/structure$/, {
    timeout: 5000,
  });
  await expect(page.getByRole('heading', { name: '人员结构分析', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '人事管理看板' })).toHaveCount(0);
  await page.goto('/hr-dashboard/management');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  expect(management).toEqual([]);
});

test('AC-FE-R2f-03 全部组件、组织开关、编码和名称、按组分页且换筛选关闭详情', async ({ page }) => {
  const calls: URL[] = [];
  await page.route(boardPath, (route) => {
    calls.push(new URL(route.request().url()));
    return route.fulfill({ json: board() });
  });
  await page.route(detailPath, (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    return route.fulfill({ json: detail(route, `${prefix}row_${url.searchParams.get('page')}`) });
  });
  await page.goto('/hr-dashboard/structure');
  await expect(page.getByRole('article'), 'B49 应按设计展示 14 个组件').toHaveCount(14, { timeout: 5000 });
  expect(
    await page.getByRole('article').evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label'))),
  ).toEqual(HR_STRUCTURE_COMPONENTS.map(({ name }) => name));
  for (const code of ['6.09', '6.10']) {
    await expect(card(page, code).getByText('暂无可用数据源')).toBeVisible();
    await expect(card(page, code).getByRole('button')).toHaveCount(0);
  }
  await expect(card(page, '6.02').getByText('36.5', { exact: false })).toBeVisible();
  await expect(card(page, '6.11').getByText(/96%/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '任职机构包含下级' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '任职部门包含下级' })).toBeChecked();
  await select(page, '任职机构', `${prefix}机构`);
  await select(page, '任职部门', `${prefix}机构`);
  await select(page, '职位序列', `${prefix}序列`);
  await select(page, '用工形式', `${prefix}用工`);
  await select(page, '人员类别', category);
  await page.getByRole('checkbox', { name: '任职机构包含下级' }).uncheck();
  await page.getByRole('checkbox', { name: '任职部门包含下级' }).uncheck();
  await query(page).click();
  const expected = {
    asOf: today,
    institutionId: root,
    institutionIncludeChildren: 'false',
    departmentId: root,
    departmentIncludeChildren: 'false',
    sequenceId: sequence,
    employmentForm: form,
    employmentType: category,
  };
  await expect.poll(() => calls[1] && Object.fromEntries(calls[1].searchParams)).toEqual(expected);
  await card(page, '6.14')
    .getByRole('button', { name: /查看详情.*合成分组甲/ })
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText(`${prefix}row_1`)).toBeVisible();
  await expect(drawer.getByRole('columnheader', { name: '员工 ID' })).toBeVisible();
  await expect(drawer.getByText('共 24 条')).toBeVisible();
  await drawer.getByTitle('2', { exact: true }).click();
  await expect(drawer.getByText(`${prefix}row_2`)).toBeVisible();
  expect(calls.slice(2).map((url) => [url.pathname, Object.fromEntries(url.searchParams)])).toEqual(
    ['1', '2'].map((page) => [`${base}/components/6.14`, { ...expected, group, page, pageSize: '20' }]),
  );

  // 触发页内查询提交，验证即使明细仍打开也会清除旧上下文。
  const formElement = page.locator('.hr-dashboard-filters form');
  await formElement.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await expect(drawer).toHaveCount(0);
  await expect(card(page)).toBeVisible();
});

test('AC-FE-R2f-11 候选分别降级，可选范围外组织，区分空范围与有范围的零值', async ({ page }) => {
  await page.route('**/job/sequences?*', (route) => route.fulfill({ status: 403 }));
  await page.route('**/employment/employment-types/options', (route) => route.fulfill({ status: 503 }));
  await page.route(boardPath, (route) => {
    const org = new URL(route.request().url()).searchParams.get('departmentId');
    return route.fulfill({ json: board(0, org === root) });
  });
  await page.route(detailPath, (route) => route.fulfill({ json: detail(route, 'unused', 0) }));
  await page.goto('/hr-dashboard/structure');
  await expect(card(page), '候选拒绝时仍显示概览').toBeVisible({ timeout: 5000 });
  await expect(lookup(page, '职位序列')).toBeDisabled();
  await expect(lookup(page, '人员类别')).toBeDisabled();
  await expect(page.getByText('筛选项暂不可用', { exact: true })).toHaveCount(2);
  await expect(lookup(page, '用工形式')).toBeEnabled();
  await expect(page.getByText('无数据权限', { exact: true })).toBeVisible();
  await expect(open(page)).toBeDisabled();
  await select(page, '任职部门', `${prefix}机构`);
  await query(page).click();
  await expect(page.getByText('无数据权限', { exact: true })).toHaveCount(0);
  await expect(card(page).getByText('0', { exact: false })).toBeVisible();
  await open(page).click();
  await expect(page.getByRole('dialog').locator('.ant-empty-description')).toHaveText('暂无数据');
});

test('AC-FE-R2f-11 400、404、413、429、503 回收旧图，限流到期后只能手动重试', async ({ page }) => {
  const errors = [
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围'],
    [404, 'NOT_FOUND', '看板不存在'],
    [413, 'PAYLOAD_TOO_LARGE', '请缩小筛选范围后重试'],
    [429, 'RATE_LIMITED', '请求过于频繁，请稍后重试'],
    [503, 'TEMPORARILY_UNAVAILABLE', '看板加载失败，请重试'],
  ] as const;
  let fault: (typeof errors)[number] | undefined;
  let reads = 0;
  await page.route(boardPath, (route) => {
    reads++;
    return route.fulfill(
      fault
        ? {
            status: fault[0],
            headers: fault[0] === 429 ? { 'Retry-After': '2' } : undefined,
            json: { error: { code: fault[1], message: `${prefix}internal` } },
          }
        : { json: board() },
    );
  });
  await page.goto('/hr-dashboard/structure');
  await expect(card(page), 'B49 有权时展示本次查询结果').toBeVisible({ timeout: 5000 });
  for (const error of errors) {
    fault = error;
    await query(page).click();
    const alert = page.getByRole('alert').filter({ hasText: error[2] });
    await expect(alert).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByText(`${prefix}internal`)).toHaveCount(0);
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
    await expect(card(page)).toBeVisible();
  }
});

for (const status of [401, 403]) {
  test(`AC-FE-R2f-11 明细 ${status} 清退概览及旧明细`, async ({ page }) => {
    await page.route(detailPath, (route) =>
      new URL(route.request().url()).searchParams.get('page') === '2'
        ? route.fulfill({ status, json: { error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' } } })
        : route.fulfill({ json: detail(route, `${prefix}old_detail`) }),
    );
    await page.goto('/hr-dashboard/structure');
    await expect(open(page), 'B49 有范围时可打开组件详情').toBeVisible({ timeout: 5000 });
    await open(page).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(`${prefix}old_detail`)).toBeVisible();
    await drawer.getByTitle('2', { exact: true }).click();
    await expect(page.getByText(`${prefix}old_detail`)).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
    if (status === 403) {
      await expect(drawer.getByText('无权查看该组件')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByText('无权查看该看板')).toBeVisible();
    } else {
      await expect(drawer).toHaveCount(0);
      await expect(page.getByText('请选择演示身份或提供会话上下文')).toBeVisible();
    }
  });
}

test('AC-FE-R2f-11 切页和换租户后拒绝迟到的旧图、明细与候选', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) => {
      const path = String(input);
      return fetch(input, path.includes('/analytics/') ? { ...options, signal: undefined } : options);
    };
  });
  await snapshot(page, [HR_STRUCTURE_OBJECT, 'TenantBase.HrDashboard']);
  const lateDetail = hold();
  const lateBoard = hold();
  const lateCandidates = hold();
  let reads = 0;
  await page.route(managementPath, (route) =>
    route.fulfill({ json: { indicators: [], asOf: today, hasDataPermission: true } }),
  );
  await page.route(candidatePath, async (route) => {
    if (route.request().headers()['x-tenant-id'] === otherTenant) {
      return route.fulfill({ json: { items: [{ id: root, name: `${prefix}新租户`, parentId: null, enabled: true }] } });
    }
    await lateCandidates.wait;
    return route.fulfill({ json: { items: [{ id: root, name: `${prefix}旧租户`, parentId: null, enabled: true }] } });
  });
  await page.route(boardPath, async (route) => {
    if (route.request().headers()['x-tenant-id'] === otherTenant) return route.fulfill({ json: board(7) });
    if (++reads > 1) await lateBoard.wait;
    return route.fulfill({ json: board(reads > 1 ? 91 : 24) });
  });
  await page.route(detailPath, async (route) => {
    await lateDetail.wait;
    return route.fulfill({ json: detail(route, `${prefix}late_row`) });
  });
  await page.goto('/hr-dashboard/structure');
  await expect(open(page), 'B49 查询成功即可打开详情').toBeVisible({ timeout: 5000 });
  const requested = page.waitForRequest(detailPath);
  await open(page).click();
  await requested;
  await page.keyboard.press('Escape');
  const pending = page.waitForRequest(boardPath);
  await query(page).click();
  await pending;
  await page.getByRole('link', { name: '人事管理看板' }).click();
  await expect(page.getByRole('heading', { name: '人事管理看板' })).toBeVisible();
  const finished = [
    page.waitForResponse(detailPath),
    page.waitForResponse(boardPath),
    page.waitForResponse(candidatePath),
  ];
  lateDetail.release();
  lateBoard.release();
  lateCandidates.release();
  await Promise.all(finished);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText(`${prefix}late_row`)).toHaveCount(0);
  await snapshot(page, [HR_STRUCTURE_OBJECT], otherTenant);
  await page.goto('/hr-dashboard/structure');
  await expect(card(page).getByText(/\b7\b/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await lookup(page, '任职机构').click();
  await expect(page.getByText(`${prefix}新租户`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${prefix}旧租户`, { exact: true })).toHaveCount(0);
});
