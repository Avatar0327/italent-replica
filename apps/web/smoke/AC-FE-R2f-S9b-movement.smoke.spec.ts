import type { Page } from '@playwright/test';
import { actionButton } from './action-button.js';
import { expect, seedDemoUser, snapshotFixture, tenant, test } from './fixtures.js';

const prefix = 'ZZ_FER2F_S9B_';
const entry = '/hr-movement-reports';
const api = '/api/tenant/analytics/hr-movement/reports';
const today = snapshotFixture.session.today;
const departmentId = '10000000-0000-4000-8000-000000000002';
const department = prefix + '部门';
const names = {
  inflow: '员工流入统计',
  outflow: '员工流出统计',
  establishment: '组织编制统计',
};
type Code = keyof typeof names;
type Cells = Record<string, number | null>;
const path = (code: Code) => `**${api}/${code}?*`;
const main = (page: Page) => page.locator('.shell-workspace');
const group = (page: Page, name: string) => main(page).getByRole('region', { name, exact: true });
const body = (page: Page, name: string) => group(page, name).locator('tbody');

function row(key: string, label: string, cells: Cells) {
  return { key, label, cells };
}

function table(key: string, name: string, columns: [string, string][], rows: ReturnType<typeof row>[], cells: Cells) {
  return { key, name, columns: columns.map(([key, label]) => ({ key, label })), rows, summary: { cells } };
}

const reasonName = '离职类型与原因';
const sequenceName = '离职人员属性';
const syntheticReasons = Array.from({ length: 21 }, (_, i) =>
  row(JSON.stringify(['leave', prefix + '类型', `${prefix}原因${i + 1}`]), `${prefix}类型 / 原因${i + 1}`, {
    count: 2,
  }),
);
const syntheticSequences = Array.from({ length: 22 }, (_, i) =>
  row(`10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, `${prefix}序列${i + 1}`, { total: i < 20 ? 2 : 1 }),
);
const tables = {
  inflow: [
    table(
      'inflow',
      names.inflow,
      [
        ['total', '合计'],
        ['age:25to30', '25～30岁'],
        ['averageAge', '平均年龄'],
      ],
      [row(departmentId, prefix + '流入序列', { total: 2, 'age:25to30': 1, averageAge: 26.5 })],
      { total: 2, 'age:25to30': 1, averageAge: 26.5 },
    ),
  ],
  outflow: [
    table('reasons', reasonName, [['count', '人数']], syntheticReasons, { count: 42 }),
    table('sequences', sequenceName, [['total', '合计']], syntheticSequences, { total: 42 }),
  ],
  establishment: [
    table(
      'establishment',
      names.establishment,
      [
        ['localCapacity', '本级编制'],
        ['inclusiveCapacity', '含下级编制'],
        ['actual', '实有人员（含下级）'],
        ['pendingIn', '预增员'],
        ['pendingOut', '预减员'],
        ['vacancy', '缺编数'],
        ['executionRate', '执行率'],
      ],
      [
        row(departmentId, department, {
          localCapacity: 8,
          inclusiveCapacity: 8,
          actual: 1,
          pendingIn: 0,
          pendingOut: 0,
          vacancy: 7,
          executionRate: 0.125,
        }),
      ],
      {
        localCapacity: 8,
        inclusiveCapacity: null,
        actual: null,
        pendingIn: null,
        pendingOut: null,
        vacancy: null,
        executionRate: null,
      },
    ),
  ],
};

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'staff' ? { ...app, entryObjects: ['TenantBase.HrMovementReport'] } : app,
        ),
      },
    }),
  );
  await page.route('**/analytics/organization-candidates?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: tenant, parentId: null, name: prefix + '根', enabled: true },
          { id: departmentId, parentId: tenant, name: department, enabled: true },
        ],
      },
    }),
  );
  for (const code of Object.keys(names) as Code[])
    await page.route(path(code), (route) => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({
        json: {
          asOf: params.get('asOf'),
          year: Number(params.get('year')),
          month: null,
          hasDataPermission: true,
          report: code,
          kind: 'table',
          name: names[code],
          tables: tables[code],
        },
      });
    });
});

test('AC-FE-R2f-08 从页签访问流入、流出和编制，三页复用时点、年度和部门筛选且无下载', async ({ page }) => {
  await page.goto(`${entry}/inflow`);
  const tabs = main(page).getByRole('navigation', { name: '流动情况' });
  for (const [code, name] of Object.entries(names) as [Code, string][]) {
    const tab = tabs.getByRole('link', { name, exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(page).toHaveURL(`${entry}/${code}`);
    const reportGroup = group(page, code === 'outflow' ? reasonName : name);
    await expect(reportGroup.getByRole('table')).toBeVisible();
    await expect(main(page).getByLabel('时点日期', { exact: true })).toHaveValue(today);
    await expect(main(page).getByLabel('月份', { exact: true })).toHaveCount(0);
    await expect(main(page).getByLabel('包含下级', { exact: true })).toHaveCount(0);
    await expect(main(page).getByRole('navigation', { name: '组织层级' })).toHaveCount(0);
    await expect(main(page).getByRole('button', { name: /下载|导出/ })).toHaveCount(0);
    const expectedLabel = code === 'inflow' ? '职务序列' : code === 'outflow' ? '离职类型 / 原因' : '组织';
    await expect(reportGroup.getByRole('columnheader').first()).toHaveText(expectedLabel);
    if (code === 'outflow')
      await expect(group(page, sequenceName).getByRole('columnheader').first()).toHaveText('职务序列');
    if (code === 'inflow') await expect(reportGroup.locator('tbody')).toContainText('26.5');
    if (code === 'establishment') {
      await expect(main(page).getByText('按分析范围统计', { exact: false })).toBeVisible();
      await expect(reportGroup.locator('tbody')).toContainText('12.5%');
      await expect(reportGroup.locator('tfoot td')).toHaveText(['合计', '8', '—', '—', '—', '—', '—', '—']);
    }

    await main(page).getByLabel('时点日期', { exact: true }).fill('2026-04-15');
    await main(page).getByLabel('年度', { exact: true }).fill('2025');
    const picker = main(page).getByRole('combobox', { name: '部门', exact: true });
    await expect(picker).toBeEnabled();
    await picker.press('ArrowDown');
    await page.locator('.ant-select-tree').getByText(department, { exact: true }).click();
    const reading = page.waitForRequest(path(code));
    await actionButton(main(page), '查询').click();
    expect(Object.fromEntries(new URL((await reading).url()).searchParams)).toEqual({
      asOf: '2026-04-15',
      year: '2025',
      departmentId,
    });
    await expect(main(page).getByText(new RegExp(`当前结果条件.*2026-04-15.*2025.*${department}`))).toBeVisible();
  }
});

test('AC-FE-R2f-08 流出两表独立分页，逐表合计留在原表，重新查询回到第一页', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `${api}/outflow`) requests.push(request.url());
  });
  await page.goto(`${entry}/outflow`);
  const expectPage = async (name: string, pageNumber: number, count: number) => {
    const section = group(page, name);
    await expect(section.locator('.ant-pagination-item-active')).toHaveText(String(pageNumber));
    await expect(body(page, name).getByRole('row')).toHaveCount(count);
    await expect(section.locator('tfoot td')).toHaveText(['合计', '42']);
  };
  await expectPage(reasonName, 1, 20);
  await expectPage(sequenceName, 1, 20);
  await group(page, reasonName).locator('.ant-pagination-item-2').click();
  await expectPage(reasonName, 2, 1);
  await expect(body(page, reasonName)).toContainText('原因21');
  await expectPage(sequenceName, 1, 20);
  await group(page, sequenceName).locator('.ant-pagination-item-2').click();
  await expectPage(sequenceName, 2, 2);
  await expect(body(page, sequenceName)).toContainText('序列22');
  await group(page, reasonName).locator('.ant-pagination-item-1').click();
  await expectPage(reasonName, 1, 20);
  await expectPage(sequenceName, 2, 2);
  expect(requests).toHaveLength(1);
  await group(page, reasonName).locator('.ant-pagination-item-2').click();
  await expectPage(reasonName, 2, 1);
  await actionButton(main(page), '查询').click();
  await expectPage(reasonName, 1, 20);
  await expectPage(sequenceName, 1, 20);
  expect(requests).toHaveLength(2);
});
