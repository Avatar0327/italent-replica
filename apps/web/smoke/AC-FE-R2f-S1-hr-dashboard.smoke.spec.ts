import type { Page, Route } from '@playwright/test';
import { HR_DASHBOARD_INDICATORS } from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, tenant, test } from './fixtures.js';

const overviewPath = /\/api\/tenant\/analytics\/hr-dashboard(?:\?|$)/;
const detailPath = /\/api\/tenant\/analytics\/hr-dashboard\/indicators\//;
const boardObject = 'TenantBase.HrDashboard';
const today = snapshotFixture.session.today;
const appliedDay = '2026-06-25';
const draftDay = '2026-03-25';

async function snapshot(page: Page, entryObjects: string[], tenantId = tenant) {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, tenantId, tenantName: `ZZ_FER2F_${tenantId}` },
        apps: snapshotFixture.apps.map((app) => (app.app === 'staff' ? { ...app, entryObjects } : app)),
      },
    }),
  );
}

function dateOf(route: Route) {
  return new URL(route.request().url()).searchParams.get('asOf') ?? today;
}

function overview(asOf: string, hasDataPermission = true, pending = 24) {
  return {
    asOf,
    hasDataPermission,
    indicators: HR_DASHBOARD_INDICATORS.map((indicator) => ({
      ...indicator,
      value: indicator.code === 'offerPending' ? pending : 0,
    })),
  };
}

function detail(route: Route, id: string) {
  const url = new URL(route.request().url());
  return {
    ...HR_DASHBOARD_INDICATORS.find(({ code }) => url.pathname.endsWith(`/${code}`)),
    asOf: dateOf(route),
    hasDataPermission: true,
    total: 24,
    page: Number(url.searchParams.get('page')),
    pageSize: Number(url.searchParams.get('pageSize')),
    items: [{ id, employeeId: null }],
  };
}

const metric = (page: Page, title = '待发 Offer') => page.getByRole('article', { name: title, exact: true });
const detailButton = (page: Page, title?: string) => metric(page, title).getByRole('button', { name: '查看详情' });
const query = (page: Page) => page.getByRole('button', { name: '查 询', exact: true });
const dateInput = (page: Page) => page.getByLabel('时点日期', { exact: true });

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await snapshot(page, [boardObject]);
  await page.route(overviewPath, (route) => route.fulfill({ json: overview(dateOf(route)) }));
});

test('AC-FE-R2f-01 单授 B48 从数据分析进入，根页只打开已交付页签', async ({ page }) => {
  await page.goto('/staff');
  const sidebar = page.locator('.shell-sidebar');
  const directory = sidebar.getByText('数据分析', { exact: true });
  await expect(directory).toBeVisible({ timeout: 5000 });
  await directory.click();
  await sidebar.getByText('人事看板', { exact: true }).click();
  await expect(page).toHaveURL(/\/hr-dashboard\/management$/);
  await expect(page.getByRole('heading', { name: '人事管理看板' })).toBeVisible();
  await expect(page.getByRole('link', { name: '人事管理看板' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: '人员结构分析' })).toHaveCount(0);

  await page.goto('/hr-dashboard/ZZ_FER2F_unknown');
  await expect(page.getByText('页面或记录不存在')).toBeVisible();
});

test('AC-FE-R2f-02 23 码按序展示，应用时点分页与 Offer 详情保持已应用条件', async ({ page }) => {
  const paths: string[] = [];
  await page.route(detailPath, (route) => {
    const url = new URL(route.request().url());
    paths.push(`${url.pathname.split('/').at(-1)}?${url.searchParams}`);
    return route.fulfill({ json: detail(route, `ZZ_FER2F_offer_${url.searchParams.get('page')}`) });
  });
  await page.goto('/hr-dashboard/management');
  await expect(page.getByRole('article'), '首页渲染 23 个已登记的 B48 指标').toHaveCount(23, { timeout: 5000 });
  expect(
    await page.getByRole('article').evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label'))),
  ).toEqual(HR_DASHBOARD_INDICATORS.map(({ name }) => name));
  await expect(page.getByText(/合同已过期、合同审批中.*可能包含外部人员/)).toBeVisible();
  await expect(page.getByText(/调动中、离职中（含退休）.*可能包含外部人员/)).toBeVisible();
  await expect(dateInput(page)).toHaveValue(today);
  await dateInput(page).fill(appliedDay);
  await query(page).click();
  await expect(page.getByText(`统计日期 ${appliedDay}`, { exact: true })).toBeVisible();
  await dateInput(page).fill(draftDay);
  await detailButton(page).click();
  const drawer = page.getByRole('dialog', { name: '待发 Offer' });
  await expect(drawer.getByRole('columnheader', { name: 'Offer ID' })).toBeVisible();
  await expect(drawer.getByText('ZZ_FER2F_offer_1')).toBeVisible();
  await expect(drawer.getByText('—', { exact: true })).toBeVisible();
  await drawer.getByTitle('2', { exact: true }).click();
  await expect(drawer.getByText('ZZ_FER2F_offer_2')).toBeVisible();
  expect(paths).toEqual([
    `offerPending?asOf=${appliedDay}&page=1&pageSize=20`,
    `offerPending?asOf=${appliedDay}&page=2&pageSize=20`,
  ]);
});

test('AC-FE-R2f-11 空范围禁用详情，有范围的真实零值可查空明细', async ({ page }) => {
  await page.route(overviewPath, (route) => {
    const day = dateOf(route);
    return route.fulfill({ json: overview(day, day !== today, 0) });
  });
  await page.route(detailPath, (route) =>
    route.fulfill({ json: { ...detail(route, 'ZZ_FER2F_unused'), total: 0, items: [] } }),
  );
  await page.goto('/hr-dashboard/management');
  await expect(page.getByText('无数据权限', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(metric(page).getByText('0', { exact: true })).toBeVisible();
  await expect(detailButton(page)).toBeDisabled();
  await dateInput(page).fill(appliedDay);
  await query(page).click();
  await expect(page.getByText('无数据权限', { exact: true })).toHaveCount(0);
  await expect(metric(page).getByText('0', { exact: true })).toBeVisible();
  await detailButton(page).click();
  await expect(
    page.getByRole('dialog').locator('.ant-empty-description').getByText('暂无数据', { exact: true }),
  ).toBeVisible();
});

test('AC-FE-R2f-01 人事管理员仅能进入报表，直链看板无权且菜单搜索无结果', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (overviewPath.test(request.url()) || detailPath.test(request.url())) requests.push(request.url());
  });
  await snapshot(page, ['TenantBase.HrRoster', 'TenantBase.HrStructureReport', 'TenantBase.HrMovementReport']);
  await page.route('**/hr-analysis/reports', (route) => route.fulfill({ json: { items: [] } }));
  await page.goto('/hr-reports');
  await expect(page.getByRole('heading', { name: '报表', exact: true })).toBeVisible();
  await expect(page.locator('.shell-sidebar').getByText('数据分析', { exact: true })).toHaveCount(0);
  await expect(page.locator('.shell-sidebar').getByText('人事看板', { exact: true })).toHaveCount(0);
  await page.goto('/hr-dashboard/management');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();

  await snapshot(page, []);
  await page.reload();
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '应用导航' }).click();
  const panel = page.getByRole('dialog', { name: '全部菜单' });
  await panel.getByRole('searchbox', { name: '搜索菜单' }).fill('人事看板');
  await expect(panel.getByText('没有匹配的菜单')).toBeVisible();
  expect(requests).toEqual([]);
});

const candidatePath =
  /\/api\/tenant\/(?:org\/organizations\/tree|job\/sequences|employment\/employment-(?:forms|types))/;

function holdResponse() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { release, promise };
}

test('AC-FE-R2f-11 时点筛选不依赖候选，响应错误清退指标并按状态恢复', async ({ page }) => {
  const faults = [
    { status: 400, code: 'VALIDATION_FAILED', message: '请检查筛选条件和日期范围' },
    { status: 413, code: 'PAYLOAD_TOO_LARGE', message: '请缩小筛选范围后重试' },
    { status: 404, code: 'NOT_FOUND', message: '看板不存在' },
    { status: 429, code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' },
    { status: 503, code: 'TEMPORARILY_UNAVAILABLE', message: '看板加载失败，请重试' },
  ];
  let fault: (typeof faults)[number] | undefined;
  const reads: string[] = [];
  const candidates: string[] = [];
  await page.route(candidatePath, (route) => {
    candidates.push(route.request().url());
    return route.fulfill({ status: 403 });
  });
  await page.route(overviewPath, (route) => {
    const day = dateOf(route);
    reads.push(day);
    return route.fulfill(
      fault
        ? {
            status: fault.status,
            headers: fault.status === 429 ? { 'Retry-After': '2' } : undefined,
            json: { error: { code: fault.code, message: 'ZZ_FER2F_internal_error' } },
          }
        : { json: overview(day) },
    );
  });
  await page.goto('/hr-dashboard/management');
  await expect(metric(page).getByText('24', { exact: true })).toBeVisible();
  // 非法时点在表单中提示，不产生一次新的数据读取。
  await dateInput(page).fill('');
  await query(page).click();
  await expect(page.getByRole('alert')).toHaveText('请检查筛选条件和日期范围');
  expect(reads).toEqual([today]);
  await dateInput(page).fill(appliedDay);
  for (const scenario of faults) {
    fault = scenario;
    await query(page).click();
    const alert = page.getByRole('alert').filter({ hasText: scenario.message });
    await expect(alert).toBeVisible();
    await expect(metric(page)).toHaveCount(0);
    await expect(page.getByText('ZZ_FER2F_internal_error')).toHaveCount(0);
    const retry = alert.getByRole('button', { name: /重\s*试/ });
    fault = undefined;
    if (scenario.status === 429) {
      await expect(retry).toBeDisabled();
      await expect(query(page)).toBeDisabled();
      const afterLimit = reads.length;
      await dateInput(page).fill(draftDay);
      await expect(retry).toBeEnabled({ timeout: 5000 });
      expect(reads).toHaveLength(afterLimit);
    }
    if (scenario.status === 429 || scenario.status === 503) await retry.click();
    else {
      await expect(retry).toHaveCount(0);
      await query(page).click();
    }
    const expectedDay = scenario.status === 503 ? draftDay : appliedDay;
    await expect(page.getByText(`统计日期 ${expectedDay}`, { exact: true })).toBeVisible();
    await expect(metric(page).getByText('24', { exact: true })).toBeVisible();
  }
  expect(candidates).toEqual([]);
});

for (const status of [401, 403]) {
  test(`AC-FE-R2f-11 分页收到 ${status} 清退概览与明细`, async ({ page }) => {
    await page.route(detailPath, (route) =>
      new URL(route.request().url()).searchParams.get('page') === '2'
        ? route.fulfill({ status, json: { error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' } } })
        : route.fulfill({ json: detail(route, 'ZZ_FER2F_prior_detail') }),
    );
    await page.goto('/hr-dashboard/management');
    await detailButton(page).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('ZZ_FER2F_prior_detail')).toBeVisible();
    await drawer.getByTitle('2', { exact: true }).click();
    await expect(page.getByText('ZZ_FER2F_prior_detail')).toHaveCount(0);
    await expect(metric(page)).toHaveCount(0);
    if (status === 401) {
      await expect(page.getByText('请选择演示身份或提供会话上下文')).toBeVisible();
      await expect(drawer).toHaveCount(0);
    } else {
      await expect(drawer.getByText('无权查看该组件')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByText('无权查看该看板')).toBeVisible();
      await expect(metric(page)).toHaveCount(0);
    }
  });
}

test('AC-FE-R2f-11 旧查询与旧租户的迟到回执无法重现指标或明细', async ({ page }) => {
  // 让响应真实回到浏览器，验证请求隔离，不用浏览器替我们取消旧网络请求。
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) => {
      const path = String(input);
      return fetch(input, path.includes('/analytics/hr-dashboard') ? { ...options, signal: undefined } : options);
    };
  });
  const otherTenant = '10000000-0000-4000-8000-000000000002';
  const lateDetail = holdResponse();
  const lateOverview = holdResponse();
  await page.route(overviewPath, async (route) => {
    const day = dateOf(route);
    const requestTenant = route.request().headers()['x-tenant-id'];
    if (day === appliedDay) await lateOverview.promise;
    const oldTenantCount = day === appliedDay ? 91 : 24;
    return route.fulfill({
      json: overview(day, true, requestTenant === otherTenant ? 7 : oldTenantCount),
    });
  });
  await page.route(detailPath, async (route) => {
    await lateDetail.promise;
    return route.fulfill({ json: detail(route, 'ZZ_FER2F_late_row') });
  });

  await page.goto('/hr-dashboard/management');
  const pendingDetail = page.waitForRequest(detailPath);
  await detailButton(page).click();
  await pendingDetail;
  await page.keyboard.press('Escape');
  const pendingOverview = page.waitForRequest(overviewPath);
  await dateInput(page).fill(appliedDay);
  await query(page).click();
  await pendingOverview;
  await expect(metric(page)).toHaveCount(0);

  // 用 SPA 导航离开，旧 fetch 和浏览器文档保持存活。
  await snapshot(page, [boardObject], otherTenant);
  await page.evaluate(() => {
    history.pushState(history.state, '', '/hr-dashboard/ZZ_FER2F_unknown');
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(page.getByText('页面或记录不存在')).toBeVisible();
  const finishedOverview = page.waitForResponse(overviewPath);
  const finishedDetail = page.waitForResponse(detailPath);
  lateOverview.release();
  lateDetail.release();
  await Promise.all([finishedOverview, finishedDetail]);
  await expect(metric(page)).toHaveCount(0);
  await expect(page.getByText('ZZ_FER2F_late_row')).toHaveCount(0);

  // 401/403 以外的权限代次更新由公共权限快照控制，切租户后的首次读取应使用新租户头。
  await page.goto('/hr-dashboard/management');
  await expect(metric(page).getByText('7', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('ZZ_FER2F_late_row')).toHaveCount(0);
});
