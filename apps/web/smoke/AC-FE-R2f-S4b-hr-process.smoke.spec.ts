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
const fullWeek = '2026-11-09';
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
    // fullWeek / offerApprovalRate：分子等于分母（审查 P2-2）
    nonCompliantByWeek: [group(week, 4, 1), group(fullWeek, 2, 2)],
    lateSubmitByCategory: [group('transfer', 2)],
    lateSubmitByInitiator: [group(initiator, 1), group(prefix + '发起人', 3)],
    lateApprovalByCategory: [group('offer', 1)],
    lateApprovalByApprover: [group(approver, 2)],
    // 正、零、负同图（审查 P2-1）
    submitLagByCategory: [
      group('transfer', 2, null, 1.5),
      group('offer', 1, null, 0),
      group('contract', 1, null, -0.5),
    ],
    approveLagByCategory: [group('transfer', 2, null, -0.5), group('offer', 1, null, 0), group('contract', 1, null, 1)],
    transferApprovalRate: [group(org, 6, 5)],
    offerApprovalRate: [group(org, 1, 1)],
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

// 条形相对零轴的两端位置，按半幅归一：正值 [0, 正]，负值 [负, 0]，零值 [0, 0]
const diverging = (page: Page, code: Code) =>
  card(page, code)
    .locator('.board-chart-mark')
    .evaluateAll((marks) =>
      marks.map((mark) => {
        const track = mark.getBoundingClientRect();
        const bar = mark.firstElementChild!.getBoundingClientRect();
        const center = track.left + track.width / 2;
        // 亚像素误差会得到 -0，统一成 0
        const at = (x: number) => Math.round(((x - center) / (track.width / 2)) * 100) / 100 || 0;
        const axis = getComputedStyle(mark, '::before');
        return { from: at(bar.left), to: at(bar.right), axis: axis.content !== 'none' && axis.width !== 'auto' };
      }),
    );

test('AC-FE-R2f-05 7.2.17 与 7.2.19 差值图带零轴，负值向左、正值向右、零值无条', async ({ page }) => {
  await page.goto('/hr-dashboard/process');
  await expect(card(page, 'submitLagByCategory').getByText('-0.5 天', { exact: true })).toBeVisible({ timeout: 5000 });
  expect(await diverging(page, 'submitLagByCategory'), '1.5 / 0 / -0.5 天').toEqual([
    { from: 0, to: 1, axis: true },
    { from: 0, to: 0, axis: true },
    { from: -0.33, to: 0, axis: true },
  ]);
  expect(await diverging(page, 'approveLagByCategory'), '-0.5 / 0 / 1 天').toEqual([
    { from: -0.5, to: 0, axis: true },
    { from: 0, to: 0, axis: true },
    { from: 0, to: 1, axis: true },
  ]);
});

test('AC-FE-R2f-05 分子等于分母时分子、分母各有不被遮挡的入口，钻取分别带 / 不带 hit', async ({ page }) => {
  await page.goto('/hr-dashboard/process');
  const cases = [
    ['nonCompliantByWeek', fullWeek, '2', '不合规数', '已通过数'],
    ['offerApprovalRate', org, '1', '审批总量', '业务总量'],
  ] as const;
  for (const [code, key, value, hits, total] of cases) {
    const root = card(page, code);
    await expect(root.getByRole('button', { name: `查看详情：${key}，${value}，${hits}` })).toBeVisible({
      timeout: 5000,
    });
    // 卡内每个可点目标的中心点都必须落在它自己身上（不被别的图形盖住）
    const covered = await root.evaluate((element) =>
      [...element.querySelectorAll('button, .board-chart-clickable')].flatMap((target) => {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        const box = target.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top && target.contains(top) ? [] : [target.getAttribute('aria-label') ?? target.textContent];
      }),
    );
    expect(covered, `${code} 不应有被遮挡的钻取入口`).toEqual([]);
    for (const [name, filter] of [
      [hits, { group: key, hit: 'true' }],
      [total, { group: key }],
    ] as const) {
      const response = page.waitForResponse((r) => r.url().includes('/components/' + code + '?'));
      await root.getByRole('button', { name: `查看详情：${key}，${value}，${name}` }).click();
      expect(params(new URL((await response).url()))).toEqual({
        asOf: today,
        from,
        to: today,
        ...filter,
        page: '1',
        pageSize: '20',
      });
      await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
      await expect(drawer(page)).toHaveCount(0);
    }
  }
});

test('AC-FE-R2f-05 键盘打开钻取后按 Escape 或点「关闭」，焦点回到原入口', async ({ page }) => {
  await page.goto('/hr-dashboard/process');
  const entry = card(page, 'transferApprovalRate').getByRole('button', { name: /^查看详情：审批总量/ });
  const closers = [
    () => page.keyboard.press('Escape'),
    () => drawer(page).getByRole('button', { name: '关闭', exact: true }).click(),
  ];
  for (const close of closers) {
    await entry.focus();
    await page.keyboard.press('Enter');
    await expect(drawer(page).getByText(prefix + '业务单', { exact: true })).toBeVisible({ timeout: 5000 });
    await close();
    await expect(drawer(page)).toHaveCount(0);
    await expect(entry, '关闭抽屉后焦点应回到打开它的入口').toBeFocused();
  }
});
