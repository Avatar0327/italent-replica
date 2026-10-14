import type { Locator, Page, Request, Route } from '@playwright/test';
import { test, expect } from './fixtures.js';
import {
  button,
  cancel,
  choose,
  conflict,
  ids,
  ifMatch,
  mockSuccession,
  objectAccess,
  objectFields,
  openMenu,
  orgRecord,
  positionRecord,
  preferences,
  save,
  saveAgain,
  settledConflict,
  unexpected,
  watchErrors,
} from './r3d1-fixtures.js';

// FE-R3d-1 第 3 轮：冲突恢复统一入口（重读 / 关闭重开都能解锁）、混合记录、规则限定条件。
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeEach(async ({ page }) => mockSuccession(page));

const path = (request: Request) => new URL(request.url()).pathname;
const listPage = (items: unknown[]) => ({ page: 1, pageSize: 15, total: items.length, hasDataPermission: true, items });
/** 列表接口按服务端当前版本回记录（后注册的路由优先于夹具）。 */
async function serveRecords(page: Page, current: () => Record<string, unknown>) {
  await page.route(/\/succession\/records(\?|$)/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: listPage([current()]) }) : route.fallback(),
  );
}
async function confirmDelete(page: Page, scope: Page | Locator) {
  await button(scope, '删除').click();
  await button(page.locator('.ant-popover:not(.ant-popover-hidden)'), '确定').click();
}
const selectRow = (page: Page) => page.getByRole('checkbox').last().check();

test('AC-FE-R3d1-15 偏好冲突后重读：别处改的隐藏组织与关键岗位按最新值回写', async ({ page }) => {
  const errors = watchErrors(page);
  let server = { ...preferences, hiddenOrgIds: [] as string[], revision: 3 };
  let rejected = false;
  const puts: { revision?: string; body: Record<string, unknown> }[] = [];
  await page.route('**/succession/maps/position/preferences', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: server });
    puts.push({ revision: ifMatch(request), body: request.postDataJSON() });
    if (!rejected) {
      // 别处改了抽屉里没有的两项（隐藏组织、只看关键岗位），版本到 8。
      rejected = true;
      server = { ...server, hiddenOrgIds: [ids.childOrg], showKeyPositions: true, revision: 8 };
      return route.fulfill(conflict);
    }
    server = { ...server, ...request.postDataJSON(), revision: server.revision + 1 };
    return route.fulfill({ json: server });
  });
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '职位继任地图', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选', exact: true });
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await choose(page, drawer, '展示职位层级', '二级');
  await save(drawer).click();
  await settledConflict(drawer);
  await drawer.getByRole('button', { name: '重读最新版本' }).click();
  await drawer.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await saveAgain(drawer);
  await expect(drawer).toBeHidden();
  expect(puts).toHaveLength(2);
  expect(puts[1]).toMatchObject({
    revision: '8',
    body: { depth: 2, hiddenOrgIds: [ids.childOrg], showKeyPositions: true },
  });
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-16 批量结束冲突：关闭后列表刷新，重选即可保存，且只发一条新命令', async ({ page }) => {
  const errors = watchErrors(page);
  let revision = 2;
  const posts: { key?: string; body: { items: { expectedRevision: number }[] } }[] = [];
  await serveRecords(page, () => ({ ...positionRecord, revision }));
  await page.route('**/succession/records/end', (route) => {
    posts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    if (posts.length === 1) return ((revision = 3), route.fulfill(conflict));
    return route.fulfill({ json: { items: [{ ...positionRecord, status: 'ended', revision: 4 }] } });
  });
  let reads = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && path(request).endsWith('/succession/records')) reads += 1;
  });
  await openMenu(page, '继任地图与列表');
  await expect(page.locator('.list-card')).toContainText('合成研发总监');
  const dialog = page.getByRole('dialog', { name: '结束继任', exact: true });
  const openEnd = async () => {
    await selectRow(page);
    await button(page, '更多操作').click();
    await page.getByRole('menuitem', { name: '结束继任', exact: true }).click();
  };
  await openEnd();
  await save(dialog).click();
  await settledConflict(dialog);
  const before = reads;
  await cancel(page);
  await expect(dialog).toBeHidden();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await openEnd();
  await saveAgain(dialog);
  await expect(dialog).toBeHidden();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.items[0]!.expectedRevision).toBe(3);
  expect(posts[1]!.key).not.toBe(posts[0]!.key);
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-17 批量结束冲突：弹窗内重读逐条记录、核对后按最新版本保存', async ({ page }) => {
  const errors = watchErrors(page);
  const posts: { items: { id: string; expectedRevision: number }[] }[] = [];
  await page.route(`**/succession/records/${ids.record}`, (route) =>
    route.fulfill({ json: { ...positionRecord, revision: 3 } }),
  );
  await page.route('**/succession/records/end', (route) => {
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) return route.fulfill(conflict);
    return route.fulfill({ json: { items: [{ ...positionRecord, status: 'ended', revision: 4 }] } });
  });
  await openMenu(page, '继任地图与列表');
  await selectRow(page);
  await button(page, '更多操作').click();
  await page.getByRole('menuitem', { name: '结束继任', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '结束继任', exact: true });
  await save(dialog).click();
  await settledConflict(dialog);
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await saveAgain(dialog);
  await expect(dialog).toBeHidden();
  expect(posts.map((body) => body.items)).toEqual([
    [{ id: ids.record, expectedRevision: 2 }],
    [{ id: ids.record, expectedRevision: 3 }],
  ]);
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-18 编辑继任冲突后重读：只发改过的字段，版本取最新', async ({ page }) => {
  const errors = watchErrors(page);
  const second = { id: '54000000-0000-4000-8000-000000000002', name: '合成准备度二', color: '#146EFF' };
  await page.route('**/succession/readiness', (route) =>
    route.fulfill({ json: { items: [positionRecord.readiness, second] } }),
  );
  const puts: { revision?: string; body: Record<string, unknown> }[] = [];
  await page.route(`**/succession/records/${ids.record}`, (route) => {
    const request = route.request();
    // 别处把开始时间改了，版本到 3。
    const latest = { ...positionRecord, startDate: '2026-09-30', revision: 3 };
    if (request.method() === 'GET') return route.fulfill({ json: latest });
    puts.push({ revision: ifMatch(request), body: request.postDataJSON() });
    if (puts.length === 1) return route.fulfill(conflict);
    return route.fulfill({ json: { ...latest, ...request.postDataJSON(), revision: 4 } });
  });
  await openMenu(page, '继任地图与列表');
  await selectRow(page);
  await button(page, '编辑').click();
  const dialog = page.getByRole('dialog', { name: '编辑继任', exact: true });
  await choose(page, dialog, '准备度', '合成准备度二');
  await save(dialog).click();
  await settledConflict(dialog);
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await expect(dialog.getByRole('row', { name: /开始时间/ })).toBeVisible();
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await saveAgain(dialog);
  await expect(dialog).toBeHidden();
  expect(puts[1]).toEqual({ revision: '3', body: { readinessId: second.id } });
  expect(unexpected(errors)).toEqual([]);
});

/** 风险等级字典：列表按服务端当前版本回行；PUT / DELETE 交给各用例。 */
async function serveRiskLevels(page: Page, level: () => Record<string, unknown>, write: (route: Route) => unknown) {
  await page.route(/\/succession\/risk-levels(\/[^/?]+)?(\?|$)/, (route) => {
    const tail = path(route.request()).replace(/^.*\/risk-levels/, '');
    if (route.request().method() !== 'GET') return write(route);
    if (tail === '/options') return route.fallback();
    return route.fulfill({ json: { ...listPage([level()]), collectionRevision: 1 } });
  });
}
async function openRiskLevels(page: Page) {
  await openMenu(page, '继任地图设置');
  await page.getByRole('tab', { name: '职位风险等级设置', exact: true }).click();
  const row = page.getByRole('row', { name: /高风险/ });
  await expect(row).toBeVisible();
  return row;
}

test('AC-FE-R3d1-19 风险等级编辑冲突：关闭后列表刷新，重开即可按新版本保存', async ({ page }) => {
  const errors = watchErrors(page);
  const base = { id: ids.level, code: 'HIGH', name: '高风险', color: '#E34D59', enabled: true, displayOrder: 1 };
  let server = { ...base, description: '合成说明', revision: 1 };
  const puts: { revision?: string; body: Record<string, unknown> }[] = [];
  await serveRiskLevels(
    page,
    () => server,
    (route) => {
      puts.push({ revision: ifMatch(route.request()), body: route.request().postDataJSON() });
      if (puts.length === 1)
        return ((server = { ...server, description: '别处改过', revision: 2 }), route.fulfill(conflict));
      server = { ...server, ...route.request().postDataJSON(), revision: 3 };
      return route.fulfill({ json: server });
    },
  );
  const row = await openRiskLevels(page);
  const dialog = page.getByRole('dialog', { name: '编辑职位风险等级', exact: true });
  await button(row, '编辑').click();
  await dialog.getByLabel('名称', { exact: true }).fill('合成高风险');
  await save(dialog).click();
  await settledConflict(dialog);
  await cancel(page);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /别处改过/ })).toBeVisible();
  await button(page.getByRole('row', { name: /高风险/ }), '编辑').click();
  await dialog.getByLabel('名称', { exact: true }).fill('合成高风险');
  await saveAgain(dialog);
  await expect(dialog).toBeHidden();
  expect(puts).toHaveLength(2);
  expect(puts[1]).toEqual({ revision: '2', body: { name: '合成高风险' } });
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-20 继任记录删除冲突：自动刷新列表，重选后按新版本删除', async ({ page }) => {
  const errors = watchErrors(page);
  let revision = 2;
  const deletes: (string | undefined)[] = [];
  await serveRecords(page, () => ({ ...positionRecord, revision }));
  await page.route(`**/succession/records/${ids.record}`, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deletes.push(ifMatch(route.request()));
    if (deletes.length === 1) return ((revision = 3), route.fulfill(conflict));
    return route.fulfill({ json: { id: ids.record, deleted: true } });
  });
  await openMenu(page, '继任地图与列表');
  await selectRow(page);
  await confirmDelete(page, page.locator('.succession-records'));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(button(page, '编辑')).toBeDisabled();
  await selectRow(page);
  await confirmDelete(page, page.locator('.succession-records'));
  await expect.poll(() => deletes).toEqual(['2', '3']);
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-21 风险等级删除冲突：自动刷新列表，再删带新版本', async ({ page }) => {
  const errors = watchErrors(page);
  const base = { id: ids.level, code: 'HIGH', name: '高风险', color: '#E34D59', enabled: true, displayOrder: 1 };
  let revision = 1;
  const deletes: (string | undefined)[] = [];
  await serveRiskLevels(
    page,
    () => ({ ...base, revision }),
    (route) => {
      deletes.push(ifMatch(route.request()));
      if (deletes.length === 1) return ((revision = 2), route.fulfill(conflict));
      return route.fulfill({ json: { id: ids.level, deleted: true } });
    },
  );
  const row = await openRiskLevels(page);
  await confirmDelete(page, row);
  await expect(page.getByRole('alert')).toBeVisible();
  await confirmDelete(page, page.getByRole('row', { name: /高风险/ }));
  await expect.poll(() => deletes).toEqual(['1', '2']);
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-22 无权查看继任类型：两张表都不错列另一类记录，无法区分的明确标出', async ({ page }) => {
  const record = objectFields['Succession.Record']!.filter((field) => field !== 'successionType');
  await objectAccess(page, 'Succession.Record', record, record);
  const strip = ({ successionType: _type, ...rest }: Record<string, unknown>) => rest;
  const unknown: Record<string, unknown> = { ...strip(positionRecord), id: '50000000-0000-4000-8000-000000000003' };
  delete unknown.targetPositionId;
  delete unknown.targetPosition;
  delete unknown.incumbents;
  await page.route(/\/succession\/records(\?|$)/, (route) =>
    route.fulfill({ json: listPage([strip(positionRecord), strip(orgRecord), unknown]) }),
  );
  await openMenu(page, '继任地图与列表');
  const list = page.locator('.succession-records');
  await expect(list).toContainText('合成研发总监');
  await expect(list).not.toContainText('合成研发中心');
  await expect(list).not.toContainText('合成负责人');
  await expect(list).toContainText('无法区分');
  await expect(list).toContainText('无权查看继任类型');

  await page.getByRole('tab', { name: '组织继任列表', exact: true }).click();
  await expect(list).toContainText('合成研发中心');
  await expect(list).toContainText('合成负责人');
  await expect(list).not.toContainText('合成研发总监');
  await expect(list).not.toContainText('合成现任');
  await expect(list).toContainText('无法区分');
});

test('AC-FE-R3d1-23 规则只读展示限定条件：指定人员值、盘点字段与自定义人员范围', async ({ page }) => {
  const errors = watchErrors(page);
  const level = (rows: unknown[]) => ({
    id: ids.level,
    code: 'HIGH',
    name: '高风险',
    color: '#E34D59',
    enabled: true,
    displayOrder: 1,
    revision: 1,
    rules: { expression: '1', rows },
  });
  const risk = level([
    {
      rowNo: 1,
      subject: 'incumbent',
      fieldCode: 'employee_id',
      filterOperator: 'eq',
      filterValues: ['合成甲'],
      measure: 'count',
      comparator: 'ge',
      threshold: 1,
      isPercent: false,
    },
  ]);
  const health = level([
    {
      rowNo: 1,
      population: 'custom',
      populationId: ids.population,
      fieldSource: 'review',
      fieldCode: 'calibrated_perf',
      filterOperator: 'not_empty',
      filterValues: [],
      measure: 'review_result_ratio',
      comparator: 'ge',
      threshold: 20,
      isPercent: true,
    },
  ]);
  await page.route(/\/succession\/(risk|health)-levels(\?|$)/, (route) =>
    route.fulfill({ json: { ...listPage([path(route.request()).includes('risk') ? risk : health]) } }),
  );
  await openMenu(page, '继任地图设置');
  await page.getByRole('tab', { name: '职位风险等级设置', exact: true }).click();
  await expect(page.locator('.succession-rules').first()).toContainText(
    '1. 现任人员 employee_id 等于 合成甲 的 人数 大于等于 1',
  );
  await page.getByRole('menuitem', { name: '健康度规则设置', exact: true }).click();
  await page.getByRole('tab', { name: '继任地图健康度', exact: true }).click();
  await expect(page.locator('.succession-rules').first()).toContainText(
    '1. 自定义人员范围「合成青年人才」 盘点字段 calibrated_perf 不为空 的 盘点结果占比 大于等于 20%',
  );
  expect(errors).toEqual([]);
});
