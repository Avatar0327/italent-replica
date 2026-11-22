import type { Page } from '@playwright/test';
import { CONTRACT_BOARD_COMPONENTS, CONTRACT_BOARD_OBJECT, HR_STRUCTURE_OBJECT, SEGMENT_NONE } from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

const base = '/api/tenant/analytics/contract-board';
const path = '/hr-contract-board';
const boardPath = /\/analytics\/contract-board(?:\?|$)/;
const detailPath = /\/analytics\/contract-board\/components\//;
const companiesPath = '**/contracts/master-data/companies?*';
const typesPath = '**/contracts/master-data/types?*';
const prefix = 'ZZ_FER2F_S5_';
const today = snapshotFixture.session.today;
const companyId = '10000000-0000-4000-8000-000000000071';
const typeId = '10000000-0000-4000-8000-000000000072';

function snapshot(page: Page, objects: string[]) {
  return page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'staff' ? { ...app, visible: !!objects.length, entryObjects: objects } : app,
        ),
      },
    }),
  );
}

function board(hasDataPermission = true, value = 24) {
  const count = hasDataPermission ? value : 0;
  return {
    asOf: today,
    hasDataPermission,
    components: CONTRACT_BOARD_COMPONENTS.map((component) => {
      const options = {
        signByCompany: [{ key: companyId, label: `${prefix}公司`, count, ratio: 0.125 }],
        signByType: [{ key: typeId, label: `${prefix}类型`, count }],
        signByTermType: [
          { key: 'fixed', label: '固定期限', count },
          { key: SEGMENT_NONE, label: '空', count: 0 },
        ],
      };
      return {
        ...component,
        value: component.code === 'signByCompany' && hasDataPermission ? count * 8 : count,
        groups: component.kind === 'groups' ? options[component.code] : null,
      };
    }),
  };
}

const queries = (page: Page, pattern: RegExp) => {
  const seen: URL[] = [];
  page.on('request', (request) => {
    if (pattern.test(request.url())) seen.push(new URL(request.url()));
  });
  return seen;
};
const params = (request?: URL) => Object.fromEntries(request?.searchParams ?? []);
const query = (page: Page) => page.getByRole('button', { name: /^查\s*询$/ });
const select = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true });
const card = (page: Page, code: string) =>
  page.getByRole('article', { name: CONTRACT_BOARD_COMPONENTS.find((item) => item.code === code)!.name, exact: true });

async function choose(page: Page, field: string, label: string) {
  await select(page, field).click();
  await page.locator('.ant-select-dropdown:visible').getByText(label, { exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await snapshot(page, [CONTRACT_BOARD_OBJECT]);
  await page.route(boardPath, (route) => route.fulfill({ json: board() }));
  await page.route(companiesPath, (route) =>
    route.fulfill({ json: { items: [{ id: companyId, name: `${prefix}公司` }] } }),
  );
  await page.route(typesPath, (route) => route.fulfill({ json: { items: [{ id: typeId, name: `${prefix}类型` }] } }));
  await page.route(detailPath, (route) => {
    const url = new URL(route.request().url());
    const group = url.searchParams.get('group');
    const pageNumber = Number(url.searchParams.get('page'));
    const component = CONTRACT_BOARD_COMPONENTS.find(({ code }) => url.pathname === `${base}/components/${code}`);
    return route.fulfill({
      json: {
        ...component,
        asOf: today,
        hasDataPermission: true,
        page: pageNumber,
        pageSize: 20,
        total: group === SEGMENT_NONE ? 0 : 24,
        group,
        items:
          group === SEGMENT_NONE
            ? []
            : [
                {
                  id: `${prefix}${component?.code}_${pageNumber}`,
                  employeeId: `${prefix}员工`,
                  organizationId: null,
                },
              ],
      },
    });
  });
});

test('AC-FE-R2f-01/09 合同独立菜单、全年默认、已应用条件、申请单及空期限组下钻分页', async ({ page }) => {
  const overview = queries(page, boardPath);
  const details = queries(page, detailPath);
  await page.goto('/staff');
  const sidebar = page.locator('.shell-sidebar');
  await expect(sidebar.getByText('数据分析', { exact: true }), 'B55 单授权必须显示数据分析分组').toBeVisible();
  await sidebar.getByText('数据分析', { exact: true }).click();
  await sidebar.getByText('合同情况', { exact: true }).click();
  await expect(page).toHaveURL(/\/hr-contract-board$/);
  await expect(page.getByRole('heading', { name: '合同情况' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(8);
  const start = '变动日期起';
  const end = '变动日期止';
  await expect(page.getByLabel(start)).toHaveValue('2026-01-01');
  await expect(page.getByLabel(end)).toHaveValue('2026-12-31');
  expect(params(overview[0])).toEqual({ asOf: today, changeFrom: '2026-01-01', changeTo: '2026-12-31' });
  await expect(card(page, 'signByCompany').getByText(/12\.5%/)).toBeVisible();

  await page.getByLabel(start).fill('2026-07-01');
  await page.getByLabel(end).fill('2026-07-31');
  await choose(page, '公司', `${prefix}公司`);
  await choose(page, '合同类型', `${prefix}类型`);
  await choose(page, '合同期限类型', '固定期限');
  await query(page).click();
  const applied = {
    asOf: today,
    changeFrom: '2026-07-01',
    changeTo: '2026-07-31',
    companyId,
    typeId,
    termType: 'fixed',
  };
  await expect.poll(() => params(overview.at(-1))).toEqual(applied);
  await expect(card(page, 'changeCreate')).toBeVisible();
  await page.getByLabel(start).fill('2026-07-02');
  await card(page, 'changeCreate')
    .getByRole('button', { name: /查看详情.*24/ })
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('columnheader', { name: '申请单 ID' })).toBeVisible();
  await expect(drawer.getByText(`${prefix}changeCreate_1`)).toBeVisible();
  expect(params(details.at(-1))).toEqual({ ...applied, page: '1', pageSize: '20' });
  await drawer.getByTitle('2', { exact: true }).click();
  await expect(drawer.getByText(`${prefix}changeCreate_2`)).toBeVisible();
  expect(params(details.at(-1))).toEqual({ ...applied, page: '2', pageSize: '20' });
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await card(page, 'signByTermType')
    .getByRole('button', { name: /查看详情：空，0/ })
    .click();
  await expect(drawer.getByRole('columnheader', { name: '合同记录 ID' })).toBeVisible();
  expect(params(details.at(-1))).toEqual({ ...applied, group: SEGMENT_NONE, page: '1', pageSize: '20' });
});

test('AC-FE-R2f-01 只有 B49 或报表授权时，B55 直链无权且不发请求', async ({ page }) => {
  const requests = queries(page, /\/analytics\/contract-board/);
  for (const object of [HR_STRUCTURE_OBJECT, 'TenantBase.HrRoster']) {
    await snapshot(page, [object]);
    await page.goto(path);
    await expect(page.getByText('暂无访问权限')).toBeVisible();
    await expect(page.locator('.shell-sidebar').getByText('合同情况', { exact: true })).toHaveCount(0);
  }
  expect(requests).toHaveLength(0);
});
