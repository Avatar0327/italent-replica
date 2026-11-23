import type { Page } from '@playwright/test';
import { HR_PROCESS_COMPONENTS, HR_PROCESS_DASHBOARD_OBJECT } from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

// 回执形状照 apps/api/src/modules/analytics/hr-process-dashboard.ts（hrProcessOverview / hrProcessPage）
const base = '/api/tenant/analytics/hr-process-dashboard';
const overview = /\/analytics\/hr-process-dashboard(?:\?|$)/;
const details = /\/analytics\/hr-process-dashboard\/components\//;
const candidates = '**/analytics/organization-candidates?*';
const prefix = 'ZZ_FER2F_S4B_';
const today = '2026-11-22';
const from = '2026-10-24';
const week = '2026-11-16';
const org = '10000000-0000-4000-8000-100000000061';
const initiator = '10000000-0000-4000-8000-100000000062';
const approver = '10000000-0000-4000-8000-100000000063';
type Code = (typeof HR_PROCESS_COMPONENTS)[number]['code'];
const WITH_HITS = new Set<string>([
  'inFlightCount',
  'inFlightWaiting',
  'nonCompliantByWeek',
  ...HR_PROCESS_COMPONENTS.filter(({ module }) => module === 'usage').map(({ code }) => code),
]);

const names = Object.fromEntries(HR_PROCESS_COMPONENTS.map(({ code, name }) => [code, name]));
const card = (page: Page, code: Code) => page.getByRole('article', { name: names[code], exact: true });
const drawer = (page: Page) => page.getByRole('dialog');
const params = (url: URL) => Object.fromEntries(url.searchParams);
const ratio = (hits: number | null, count: number) =>
  hits === null || count === 0 ? null : Math.round((hits / count) * 10_000) / 10_000;
const group = (key: string, count: number, hits: number | null = null, average: number | null = null) => ({
  key,
  label: null,
  series: null,
  count,
  hits,
  rate: ratio(hits, count),
  average,
});

function board() {
  const groups: Partial<Record<Code, ReturnType<typeof group>[]>> = {
    nonCompliantByWeek: [group(week, 4, 1)],
    lateSubmitByCategory: [group('transfer', 2)],
    lateSubmitByInitiator: [group(initiator, 1), group(prefix + '发起人', 3)],
    lateApprovalByCategory: [group('offer', 1)],
    lateApprovalByApprover: [group(approver, 2)],
    submitLagByCategory: [group('transfer', 2, null, 1.5)],
    approveLagByCategory: [group('transfer', 2, null, -0.5)],
    transferApprovalRate: [group(org, 6, 5)],
  };
  return {
    asOf: today,
    from,
    to: today,
    hasDataPermission: true,
    components: HR_PROCESS_COMPONENTS.map((item) => {
      const mine = groups[item.code] ?? [];
      const total = mine.reduce((sum, row) => sum + row.count, 0);
      const hits = WITH_HITS.has(item.code) ? mine.reduce((sum, row) => sum + (row.hits ?? 0), 0) : null;
      const average = item.code === 'submitLag' ? 1.5 : item.code === 'approveLag' ? -0.5 : null;
      return { ...item, total, hits, rate: ratio(hits, total), average, groups: mine };
    }),
  };
}

function detail(url: URL) {
  const code = url.pathname.split('/').at(-1);
  const component = HR_PROCESS_COMPONENTS.find((it) => it.code === code)!;
  const business = component.subject === 'business';
  const hit = url.searchParams.has('hit') ? url.searchParams.get('hit') === 'true' : null;
  const item = {
    id: prefix + (business ? '业务单' : '实例'),
    // 业务单行：调用者看不到对应审批实例时为 null（F-415）
    instanceId: business ? null : prefix + '实例',
    group: url.searchParams.get('group') ?? (business ? org : week),
    series: null,
    value: code?.includes('Lag') ? 1.5 : null,
    hit: WITH_HITS.has(code!) ? (hit ?? true) : null,
  };
  return {
    ...component,
    asOf: today,
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    hasDataPermission: true,
    total: 1,
    page: Number(url.searchParams.get('page')),
    pageSize: 20,
    items: [item],
  };
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, today },
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'staff' ? { ...app, entryObjects: [HR_PROCESS_DASHBOARD_OBJECT] } : app,
        ),
      },
    }),
  );
  await page.route(overview, (r) => r.fulfill({ json: board() }));
  await page.route(details, (r) => r.fulfill({ json: detail(new URL(r.request().url())) }));
  await page.route(candidates, (r) => r.fulfill({ json: { items: [] } }));
});

test('AC-FE-R2f-05 质量与应用补全四分区，7.2.15 只占位，比率命中钻取带 hit 且业务单不可见实例无跳转', async ({
  page,
}) => {
  const reads: URL[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith(base + '/components/')) reads.push(url);
  });
  await page.goto('/hr-dashboard/process');
  const headings = ['在途流程监控', '流程时效分析', '流程质量分析', '流程应用情况'];
  await expect(page.getByRole('heading', { level: 2 }), 'B51 应按规格顺序显示四个分区').toHaveText(headings, {
    timeout: 5000,
  });
  await expect(page.getByRole('article')).toHaveCount(24);
  expect(
    await page.getByRole('article').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
  ).toEqual(HR_PROCESS_COMPONENTS.map(({ name }) => name));

  const placeholder = card(page, 'lateApprovalByApprover');
  await expect(placeholder.getByText('统计口径暂不可用', { exact: true })).toBeVisible();
  await expect(placeholder.getByRole('button'), '7.2.15 不应有图表或查看详情入口').toHaveCount(0);
  await expect(placeholder.getByText(approver)).toHaveCount(0);

  const ranking = card(page, 'lateSubmitByInitiator');
  await expect(ranking.getByRole('button', { name: /^查看详情：/ })).toHaveText([/发起人.*3/, /1/]);
  await expect(card(page, 'submitLag').getByText('1.5 天', { exact: true })).toBeVisible();
  await expect(card(page, 'approveLagByCategory').getByText('-0.5 天')).toBeVisible();

  const open = async (code: Code, name: RegExp, filter: Record<string, string>) => {
    const response = page.waitForResponse((r) => r.url().includes('/components/' + code + '?'));
    await card(page, code).getByRole('button', { name }).click();
    expect(params(new URL((await response).url()))).toEqual({
      asOf: today,
      from,
      to: today,
      ...filter,
      page: '1',
      pageSize: '20',
    });
  };
  await open('nonCompliantByWeek', /查看详情：不合规数/, { hit: 'true' });
  await expect(drawer(page).getByText(/不合规数/)).toBeVisible();
  await expect(drawer(page).getByRole('columnheader')).toHaveText(['实例 ID', '分组', '不合规']);
  await expect(drawer(page).getByRole('cell', { name: '是', exact: true })).toBeVisible();
  // 抽屉内换分组保留命中条件，只改 group
  const regroup = page.waitForResponse((r) => r.url().includes('/components/nonCompliantByWeek?'));
  await drawer(page).getByRole('combobox', { name: '分组' }).press('ArrowDown');
  await page.locator('.ant-select-dropdown:visible').getByText(week, { exact: true }).click();
  expect(params(new URL((await regroup).url()))).toMatchObject({ group: week, hit: 'true' });
  await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);

  await open('nonCompliantByWeek', new RegExp(`查看详情：${week}，1，不合规数`), { group: week, hit: 'true' });
  await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
  await open('nonCompliantByWeek', new RegExp(`查看详情：${week}，4，已通过数`), { group: week });
  await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();

  await open('transferApprovalRate', /查看详情：审批总量/, { hit: 'true' });
  await expect(drawer(page).getByRole('columnheader')).toHaveText(['业务单 ID', '实例 ID', '二级组织 ID', '经审批']);
  await expect(drawer(page).getByText(prefix + '业务单', { exact: true })).toBeVisible();
  await expect(drawer(page).getByRole('link'), '不可见实例 ID 不得出现跳转').toHaveCount(0);
  await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
  await open('transferApprovalRate', new RegExp(`查看详情：${org}，83.33%，占比`), { group: org, hit: 'true' });
  await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
  await open('transferApprovalRate', /查看详情：业务总量/, {});
  await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();

  expect(reads.filter((url) => url.pathname.endsWith('/lateApprovalByApprover'))).toEqual([]);
});
