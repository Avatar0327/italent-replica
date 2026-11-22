import type { Page } from '@playwright/test';
import { HR_MOVEMENT_OBJECT, HR_PROCESS_COMPONENTS, HR_PROCESS_DASHBOARD_OBJECT } from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

const base = '/api/tenant/analytics/hr-process-dashboard';
const overview = /\/analytics\/hr-process-dashboard(?:\?|$)/;
const details = /\/analytics\/hr-process-dashboard\/components\//;
const list = '**/analytics/hr-process-dashboard/components/inFlightList?*';
const candidates = '**/analytics/organization-candidates?*';
const prefix = 'ZZ_FER2F_S4A_';
const today = '2026-11-22';
const from = '2026-10-24';
const department = '10000000-0000-4000-8000-100000000051';
const approver = '10000000-0000-4000-8000-100000000052';
const node = prefix + '经理审批 & / +';
const active = HR_PROCESS_COMPONENTS.slice(0, 10);
type Code = (typeof HR_PROCESS_COMPONENTS)[number]['code'];

const names = Object.fromEntries(HR_PROCESS_COMPONENTS.map(({ code, name }) => [code, name]));
const card = (page: Page, code: Code) => page.getByRole('article', { name: names[code], exact: true });
const query = (page: Page) => page.getByRole('button', { name: /^查\s*询$/ });
const drawer = (page: Page) => page.getByRole('dialog');
const params = (url: URL) => Object.fromEntries(url.searchParams);
const group = (
  key: string,
  count: number,
  average: number | null = null,
  series: string | null = null,
  label: string | null = null,
) => ({
  key,
  label,
  count,
  average,
  series,
  hits: null,
  rate: null,
});

function board(hasDataPermission = true, empty = false) {
  const n = empty ? 0 : 24;
  const hits = empty ? 0 : 12;
  const groups: Partial<Record<Code, ReturnType<typeof group>[]>> = {
    inFlightAbnormal: [group('expired', 1)],
    inFlightByApprover: [group(approver, 6, null, 'transfer'), group(approver, 2, null, 'offer')],
    durationByWeek: [group('2026-11-16', 3, 2.5)],
    durationByCategory: [group('transfer', 3, 2.5)],
    taskDurationByNode: [group(node, 3, 1.25, null, node)],
    taskDurationByApprover: [group(approver, 3, 1.25)],
    durationByOrg: [group(department, 3, 2.5)],
  };
  return {
    asOf: today,
    from,
    to: today,
    hasDataPermission,
    components: HR_PROCESS_COMPONENTS.map((item) => ({
      ...item,
      total: n,
      hits: item.code === 'inFlightCount' || item.code === 'inFlightWaiting' ? hits : null,
      rate: null,
      average: null,
      groups: empty ? [] : (groups[item.code] ?? []),
    })),
  };
}

function detail(url: URL, hasDataPermission = true) {
  const code = url.pathname.split('/').at(-1);
  const page = Number(url.searchParams.get('page'));
  const item = {
    id: prefix + 'id_' + page,
    instanceId: null,
    group: url.searchParams.get('group'),
    series: url.searchParams.get('series'),
    value: code?.includes('Duration') ? 1.25 : null,
    hit: url.searchParams.has('hit') ? url.searchParams.get('hit') === 'true' : null,
  };
  return {
    ...HR_PROCESS_COMPONENTS.find((it) => it.code === code),
    asOf: today,
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    hasDataPermission,
    total: 24,
    page,
    pageSize: 20,
    items:
      code === 'inFlightList'
        ? [
            {
              ...item,
              instanceId: prefix + 'instance_' + page,
              title: prefix + '实例_' + page,
              category: 'transfer',
              currentNode: node,
              currentApproverUserId: approver,
              approverStatus: 'left',
              departmentId: department,
              directManagerId: null,
              initiatorUserId: prefix + '发起人',
              startedAt: '2026-11-19T17:12:00.000Z',
              arrivedAt: null,
              businessDate: '2026-11-21',
              abnormalTypes: ['approverLeft', 'expired'],
              waitBucket: 'gt7',
              approvedCount: 0,
            },
          ]
        : [item],
  };
}

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

async function choose(page: Page, field: string, label: string) {
  const control = page.getByRole('combobox', { name: field, exact: true });
  await expect(control).toBeEnabled();
  await control.press('ArrowDown');
  await page
    .locator('.ant-select-dropdown:visible:not([class*="-leave"])')
    .locator('.ant-select-tree-title, .ant-select-item-option-content')
    .getByText(label, { exact: true })
    .click();
}

async function start(page: Page) {
  await page.goto('/hr-dashboard/process');
  await expect(
    page.getByRole('heading', { name: '人事流程看板', exact: true }),
    'B51 应在流程路径显示已交付看板',
  ).toBeVisible({ timeout: 5000 });
}

test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await snapshot(page, [HR_PROCESS_DASHBOARD_OBJECT]);
  await page.route(overview, (r) => {
    const window = new URL(r.request().url()).searchParams;
    return r.fulfill({ json: { ...board(), from: window.get('from') ?? from, to: window.get('to') ?? today } });
  });
  await page.route(details, (r) => r.fulfill({ json: detail(new URL(r.request().url())) }));
  await page.route(candidates, (r) =>
    r.fulfill({ json: { items: [{ id: department, name: prefix + '部门', parentId: null, enabled: true }] } }),
  );
});

test('AC-FE-R2f-05 B51 单授权根入口，仅在途与时效两组十项，筛选、图表与分页明细', async ({ page }) => {
  const reads: URL[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith(base)) reads.push(url);
  });
  await page.goto('/hr-dashboard');
  await expect(page, 'B51 单授权访问根路径应打开人事流程看板').toHaveURL(/\/hr-dashboard\/process$/, { timeout: 5000 });
  await expect(page.getByRole('navigation', { name: '人事看板' }).getByRole('link')).toHaveText(['人事流程看板']);
  for (const name of ['在途流程监控', '流程时效分析'])
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(10);
  expect(
    await page.getByRole('article').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
  ).toEqual(active.map(({ name }) => name));
  expect(params(reads[0]!)).toEqual({ asOf: today, from, to: today });
  const table = card(page, 'inFlightList');
  await expect(table.getByText(prefix + '实例_1')).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText([
    '实例 ID',
    '流程实例名称',
    '审批类别',
    '当前节点',
    '当前审批人 ID',
    '审批人状态',
    '部门 ID',
    '直线经理 ID',
    '发起人 ID',
    '发起时间',
    '任务到达时间',
    '业务日期',
    '在途异常类型',
    '等待时间段',
    '审批计数',
  ]);
  await expect(table.getByRole('cell', { name: /2026.*11.*20.*01:12/ })).toBeVisible();
  await expect(table.getByRole('cell', { name: '已离职', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(table.getByRole('link')).toHaveCount(0);
  await table.getByTitle('2', { exact: true }).click();
  await expect(table.getByText(prefix + '实例_2')).toBeVisible();

  await choose(page, '审批类别', '调动');
  await choose(page, '流程所属部门', prefix + '部门');
  await page.getByLabel('开始日期', { exact: true }).fill('2026-11-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-11-20');
  await query(page).click();
  await expect(table.getByText(prefix + '实例_1')).toBeVisible();
  const applied = { asOf: today, from: '2026-11-01', to: '2026-11-20', category: 'transfer', departmentId: department };
  expect(params(reads.findLast((url) => url.pathname === base)!)).toEqual(applied);

  // 草稿变化后，图表仍钻取上一次成功查询的语境。
  await choose(page, '审批类别', '合同');
  const open = async (code: Code, name: RegExp, filter: Record<string, string>) => {
    const response = page.waitForResponse((r) => r.url().includes('/components/' + code + '?'));
    await card(page, code).getByRole('button', { name }).click();
    expect(params(new URL((await response).url()))).toEqual({ ...applied, ...filter, page: '1', pageSize: '20' });
    await expect(drawer(page).getByText(prefix + '部门', { exact: false })).toBeVisible();
    await expect(drawer(page).getByRole('link')).toHaveCount(0);
    await drawer(page).getByRole('button', { name: '关闭', exact: true }).click();
    await expect(drawer(page)).toHaveCount(0);
  };
  await open('inFlightCount', /查看详情.*非在途/, { hit: 'false' });
  await open('inFlightWaiting', /查看详情.*超过 7 天/, { hit: 'true' });
  await open('inFlightByApprover', /查看详情.*调动/, { group: approver, series: 'transfer' });
  await open('taskDurationByNode', /查看详情.*经理审批/, { group: node });
  await open('taskDurationByApprover', /查看详情.*1\.25/, { group: approver });
});

test('AC-FE-R2f-11 无范围与零匹配分开，候选失败只降级筛选，在途表失败和权限拒绝', async ({ page }) => {
  let scoped = false;
  let empty = true;
  let status = 503;
  let listReads = 0;
  await page.route(overview, (r) => r.fulfill({ json: board(scoped, empty) }));
  await page.route(candidates, (r) => r.fulfill({ status: 503 }));
  await page.route(list, (r) => {
    listReads++;
    return status
      ? r.fulfill({ status, json: { error: { code: 'UNAVAILABLE' } } })
      : r.fulfill({ json: detail(new URL(r.request().url())) });
  });
  await start(page);
  await expect(page.getByText('无数据权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '流程所属部门' })).toBeDisabled();
  await expect(page.getByText('筛选项暂不可用', { exact: true })).toBeVisible();
  expect(listReads).toBe(0);
  scoped = true;
  await query(page).click();
  await expect(page.getByText('无数据权限', { exact: true })).toHaveCount(0);
  await expect(card(page, 'inFlightByApprover').getByText('暂无数据', { exact: true })).toBeVisible();
  const table = card(page, 'inFlightList');
  await expect(table.getByText('明细加载失败，请重试')).toBeVisible();
  status = 0;
  await table.getByRole('button', { name: /重\s*试/ }).click();
  await expect(table.getByText(prefix + '实例_1')).toBeVisible();
  empty = false;
  status = 403;
  await table.getByTitle('2', { exact: true }).click();
  await expect(page.getByText('无权查看该看板', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
});

test('AC-FE-R2f-11 切换看板后迟到的在途分页不得显示', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, options) =>
      fetch(input, String(input).includes('/inFlightList?') ? { ...options, signal: undefined } : options);
  });
  await snapshot(page, [HR_PROCESS_DASHBOARD_OBJECT, HR_MOVEMENT_OBJECT]);
  await page.route('**/analytics/hr-movement?*', (r) =>
    r.fulfill({ json: { asOf: today, hasDataPermission: true, components: [] } }),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(list, async (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get('page') === '2') await held;
    await r.fulfill({ json: detail(url) });
  });
  await start(page);
  const pending = page.waitForRequest((r) => r.url().includes('/inFlightList?') && r.url().includes('page=2'));
  const late = page.waitForResponse((r) => r.url().includes('/inFlightList?') && r.url().includes('page=2'));
  try {
    await card(page, 'inFlightList').getByTitle('2', { exact: true }).click();
    await pending;
    await page.getByRole('link', { name: '人员流动分析', exact: true }).click();
    await expect(page.getByRole('heading', { name: '人员流动分析', exact: true })).toBeVisible();
  } finally {
    release();
  }
  expect((await late).status()).toBe(200);
  await expect(page.getByText(prefix + '实例_2')).toHaveCount(0);
});

test('AC-FE-R2f-11 查询错误清退旧数据，429 到期才能手动重试，在途表 401 回共享会话态', async ({ page }) => {
  const errors = [
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围'],
    [404, 'NOT_FOUND', '看板不存在'],
    [413, 'PAYLOAD_TOO_LARGE', '请缩小筛选范围后重试'],
    [429, 'RATE_LIMITED', '请求过于频繁，请稍后重试'],
    [503, 'UNAVAILABLE', '看板加载失败，请重试'],
  ] as const;
  let fault: (typeof errors)[number] | undefined;
  let reads = 0;
  await page.route(overview, (r) => {
    reads++;
    const headers = fault?.[0] === 429 ? { 'Retry-After': '2' } : undefined;
    return fault
      ? r.fulfill({
          status: fault[0],
          headers,
          json: { error: { code: fault[1], message: prefix + 'internal' } },
        })
      : r.fulfill({ json: board() });
  });
  await start(page);
  const table = card(page, 'inFlightList');
  for (const error of errors) {
    await expect(table.getByText(prefix + '实例_1')).toBeVisible();
    fault = error;
    await query(page).click();
    const alert = page.getByRole('alert').filter({ hasText: error[2] });
    await expect(alert).toBeVisible();
    await expect(table).toHaveCount(0);
    await expect(drawer(page)).toHaveCount(0);
    await expect(page.getByText(prefix + 'internal')).toHaveCount(0);
    fault = undefined;
    const retry = alert.getByRole('button', { name: /重\s*试/ });
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
  }
  await expect(table.getByText(prefix + '实例_1')).toBeVisible();
  await page.route(list, (r) => r.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } }));
  await table.getByTitle('2', { exact: true }).click();
  await expect(page.getByText('请选择演示身份或提供会话上下文', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
});

test('AC-FE-R2f-05 无 B51 权限的相邻看板身份直链不读流程概览、候选或明细', async ({ page }) => {
  await snapshot(page, [HR_MOVEMENT_OBJECT]);
  const calls: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (
      url.pathname.startsWith(base) ||
      (url.pathname === '/api/tenant/analytics/organization-candidates' &&
        url.searchParams.get('object') === 'HrProcessDashboard')
    )
      calls.push(r.url());
  });
  await page.goto('/hr-dashboard/process');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '人事流程看板' })).toHaveCount(0);
  expect(calls).toEqual([]);
});
