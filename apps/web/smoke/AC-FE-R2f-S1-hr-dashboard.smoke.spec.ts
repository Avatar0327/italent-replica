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
  await expect(page.getByRole('dialog').getByText('暂无数据', { exact: true })).toBeVisible();
});
