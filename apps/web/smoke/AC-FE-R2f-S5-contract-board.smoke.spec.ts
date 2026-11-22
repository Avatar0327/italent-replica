import type { Page, Route } from '@playwright/test';
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
const otherTenant = '10000000-0000-4000-8000-000000000091';
const companyId = '10000000-0000-4000-8000-000000000071';
const typeId = '10000000-0000-4000-8000-000000000072';

function snapshot(page: Page, objects: string[], tenantId = snapshotFixture.session.tenantId) {
  return page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, tenantId },
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
  await expect(select(page, field)).toBeEnabled();
  await select(page, field).press('ArrowDown');
  await page.locator('.ant-select-dropdown:visible:not([class*="-leave"])').getByText(label, { exact: true }).click();
}

function detailResponse(route: Route) {
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
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await snapshot(page, [CONTRACT_BOARD_OBJECT]);
  await page.route(boardPath, (route) => route.fulfill({ json: board() }));
  await page.route(companiesPath, (route) =>
    route.fulfill({ json: { items: [{ id: companyId, name: `${prefix}公司` }] } }),
  );
  await page.route(typesPath, (route) => route.fulfill({ json: { items: [{ id: typeId, name: `${prefix}类型` }] } }));
  await page.route(detailPath, detailResponse);
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
  await expect.soft(drawer.locator(':focus'), '详情翻到第 2 页后焦点应留在抽屉内').toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await card(page, 'signByTermType')
    .getByRole('button', { name: /查看详情：空，0/ })
    .click();
  await expect(drawer.getByRole('columnheader', { name: '合同记录 ID' })).toBeVisible();
  expect(params(details.at(-1))).toEqual({ ...applied, group: SEGMENT_NONE, page: '1', pageSize: '20' });
  await choose(page, '分组', '固定期限');
  await expect(drawer.getByText(`${prefix}signByTermType_1`)).toBeVisible();
  expect(params(details.at(-1))).toEqual({ ...applied, group: 'fixed', page: '1', pageSize: '20' });
  await expect(drawer.getByText(/当前结果条件.*2026-07-01/)).toBeVisible();
});

test('AC-FE-R2f-01 B49 和人事管理员不能访问 B55，全无权时菜单搜索无结果', async ({ page }) => {
  const requests = queries(page, /\/analytics\/contract-board|\/contracts\/master-data/);
  await snapshot(page, [HR_STRUCTURE_OBJECT]);
  await page.goto(path);
  await expect(page.getByText('暂无访问权限')).toBeVisible();

  await snapshot(page, ['TenantBase.HrRoster', 'TenantBase.HrStructureReport', 'TenantBase.HrMovementReport']);
  await page.goto('/hr-reports');
  await expect(page.getByRole('heading', { name: '报表', exact: true })).toBeVisible();
  await page.goto(path);
  await expect(page.getByText('暂无访问权限')).toBeVisible();
  const sidebar = page.locator('.shell-sidebar');
  await sidebar.getByText('数据分析', { exact: true }).click();
  await expect(sidebar.getByText('员工名册', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('合同情况', { exact: true })).toHaveCount(0);

  await snapshot(page, []);
  await page.reload();
  await expect(page.getByText('暂无访问权限')).toBeVisible();
  await expect(sidebar.getByText('数据分析', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '应用导航' }).click();
  const panel = page.getByRole('dialog', { name: '全部菜单' });
  await panel.getByRole('searchbox', { name: '搜索菜单' }).fill('合同情况');
  await expect(panel.getByText('没有匹配的菜单')).toBeVisible();
  expect(requests).toHaveLength(0);
});

test('AC-FE-R2f-11 主数据拒绝、字段裁剪及候选末页失败独立降级', async ({ page }) => {
  await page.route(companiesPath, (route) => route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }));
  const item = { id: typeId, name: `${prefix}类型` };
  let repair = false;
  let complete = false;
  const requested: string[] = [];
  await page.route(typesPath, (route) => {
    const p = new URL(route.request().url()).searchParams.get('page')!;
    requested.push(p);
    if (p === '1') {
      const items = complete
        ? [item]
        : Array.from({ length: 200 }, (_, index) => ({
            id: `10000000-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`,
            name: `${prefix}分段类型${index}`,
          }));
      return route.fulfill({ json: { items } });
    }
    return repair
      ? route.fulfill({ json: { items: [item, { id: companyId }] } })
      : route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  const overview = queries(page, boardPath);
  await page.goto(path);
  await expect(card(page, 'changeCreate')).toBeVisible();
  await expect(select(page, '公司')).toBeDisabled();
  await expect(select(page, '合同类型')).toBeDisabled();
  await expect(page.getByText('筛选项暂不可用')).toHaveCount(2);
  expect(requested).toEqual(['1', '2']);
  expect(overview).toHaveLength(1);

  repair = true;
  await page.getByRole('button', { name: '重试合同类型候选' }).click();
  await expect.poll(() => requested.length).toBe(4);
  await expect(page.getByText('筛选项暂不可用')).toHaveCount(2);
  await expect(select(page, '合同类型')).toBeDisabled();

  complete = true;
  await page.reload();
  await choose(page, '合同类型', item.name);
  await choose(page, '合同期限类型', '无固定期限');
  await query(page).click();
  await expect.poll(() => params(overview.at(-1))).toMatchObject({ typeId, termType: 'indefinite' });
  expect(params(overview.at(-1))).not.toHaveProperty('companyId');
});

test('AC-FE-R2f-11 无数据权限与真实零值分别处理，详情 403 清退旧结果', async ({ page }) => {
  await page.route(boardPath, (route) => route.fulfill({ json: board(false) }));
  await page.goto(path);
  await expect(page.getByText('无数据权限')).toBeVisible();
  await expect(card(page, 'changeCreate').getByRole('button', { name: /查看详情.*0/ })).toBeDisabled();
  await expect(card(page, 'signByTermType').getByRole('button')).toHaveCount(1);

  await page.route(boardPath, (route) => route.fulfill({ json: board(true, 0) }));
  await query(page).click();
  await expect(page.getByText('无数据权限')).toHaveCount(0);
  await expect(card(page, 'changeCreate').getByRole('button', { name: /查看详情.*0/ })).toBeEnabled();
  await page.route(detailPath, (route) => route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }));
  await card(page, 'changeCreate').getByRole('button').click();
  await expect(page.getByRole('dialog').getByText('无权查看该组件')).toBeVisible();
  await expect(card(page, 'changeCreate')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByText('无权查看该看板')).toBeVisible();
});

test('AC-FE-R2f-11 限频到期才允许手动重试，当前 401 交给会话态', async ({ page }) => {
  const overview = queries(page, boardPath);
  await page.goto(path);
  await expect(card(page, 'changeCreate')).toBeVisible();
  await page.route(boardPath, (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '2' },
      json: { error: { code: 'RATE_LIMITED' } },
    }),
  );
  await query(page).click();
  await expect(page.getByText('请求过于频繁，请稍后重试')).toBeVisible();
  await expect(card(page, 'changeCreate')).toHaveCount(0);
  const retry = page.getByRole('button', { name: /^重\s*试$/ });
  await expect(retry).toBeDisabled();
  await expect(query(page)).toBeDisabled();
  await expect(retry).toBeEnabled();
  expect(overview).toHaveLength(2);

  await page.route(boardPath, (route) => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } }));
  await retry.click();
  await expect(page.getByText('请选择演示身份或提供会话上下文')).toBeVisible();
  expect(overview).toHaveLength(3);
});

test('AC-FE-R2f-11 换页和换租户清退迟到的概览、详情与候选', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) => {
      const url = String(input);
      return fetch(
        input,
        /contract-board|contracts\/master-data/.test(url) ? { ...options, signal: undefined } : options,
      );
    };
  });
  await snapshot(page, [CONTRACT_BOARD_OBJECT, 'TenantBase.HrRoster']);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let read = 0;
  await page.route(companiesPath, async (route) => {
    const next = route.request().headers()['x-tenant-id'] === otherTenant;
    if (!next) await hold;
    return route.fulfill({ json: { items: [{ id: companyId, name: `${prefix}${next ? '新' : '旧'}租户公司` }] } });
  });
  await page.route(boardPath, async (route) => {
    if (route.request().headers()['x-tenant-id'] === otherTenant) return route.fulfill({ json: board(true, 7) });
    if (++read > 1) await hold;
    return route.fulfill({ json: board(true, read > 1 ? 91 : 24) });
  });
  await page.route(detailPath, async (route) => {
    await hold;
    return detailResponse(route);
  });

  const candidateRequested = page.waitForRequest(companiesPath);
  await page.goto(path);
  await candidateRequested;
  const detailRequested = page.waitForRequest(detailPath);
  await card(page, 'changeCreate').getByRole('button').click();
  await detailRequested;
  await page.keyboard.press('Escape');
  const overviewRequested = page.waitForRequest(boardPath);
  await query(page).click();
  await overviewRequested;
  await page.locator('.shell-sidebar').getByText('报表', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '报表', exact: true })).toBeVisible();

  const settled = [
    page.waitForResponse(boardPath),
    page.waitForResponse(detailPath),
    page.waitForResponse(companiesPath),
  ];
  release();
  await Promise.all(settled);
  await expect(card(page, 'changeCreate')).toHaveCount(0);
  await expect(page.getByText(`${prefix}changeCreate_1`)).toHaveCount(0);
  await snapshot(page, [CONTRACT_BOARD_OBJECT], otherTenant);
  await page.goto(path);
  await expect(card(page, 'changeCreate').getByRole('button', { name: /查看详情.*7/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await select(page, '公司').press('ArrowDown');
  await expect(page.getByText(`${prefix}新租户公司`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${prefix}旧租户公司`, { exact: true })).toHaveCount(0);
});
