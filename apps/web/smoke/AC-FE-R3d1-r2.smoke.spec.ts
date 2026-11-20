import type { Page } from '@playwright/test';
import type { LevelResult } from '../src/succession/types.js';
import { test, expect } from './fixtures.js';
import {
  button,
  choose,
  conflict,
  ids,
  ifMatch,
  mockSuccession,
  objectAccess,
  objectFields,
  openMenu,
  positionMap,
  preferences,
  saveAgain,
  settledConflict,
  unexpected,
  watchErrors,
} from './r3d1-fixtures.js';

// FE-R3d-1 第 2 轮：真实回执形状、冲突重读、字段只读、隐藏筛选字段与健康度规则页。
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeEach(async ({ page }) => mockSuccession(page));

async function openMap(page: Page, tab: string) {
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

async function openRiskDialog(page: Page) {
  const card = page.getByRole('article', { name: '合成研发总监', exact: true });
  await card.getByRole('button', { name: '卡片操作' }).click();
  await page.getByRole('menuitem', { name: '设置风险等级', exact: true }).click();
  return page.getByRole('dialog', { name: '设置风险等级', exact: true });
}

const riskResult = (revision: number, levelId: string | null) => ({
  id: ids.position,
  positionId: ids.position,
  levelId,
  levelName: levelId ? '高风险' : null,
  levelColor: '#E34D59',
  method: levelId ? 'manual' : 'computed',
  computedAt: null,
  revision,
});

async function mockPositionRisk(page: Page, read: () => LevelResult | undefined) {
  await page.route(/\/succession\/maps\/position(\?|$)/, (route) => {
    const [first, ...rest] = positionMap.items;
    const { risk: _risk, ...card } = first!;
    const risk = read();
    // position-map.ts：结果不披露时整个键省略；字段裁剪后仍可返回 risk 对象。
    return route.fulfill({ json: { ...positionMap, items: [risk === undefined ? card : { ...card, risk }, ...rest] } });
  });
}

const assignHint = '该继任地图条目缺少标识或版本，请关闭后重读地图。';
// position-map.ts 的默认色投影，computedAt 可见时会同时返回 resultAsOf。
const defaultPositionRisk = {
  positionId: ids.position,
  levelId: null,
  levelName: null,
  levelColor: '#7498FB',
  computedAt: null,
  resultAsOf: null,
};
const defaultRiskFields = ['positionId', 'levelId', 'levelName', 'levelColor', 'computedAt'];
const storedRiskFields = [...defaultRiskFields, 'id', 'method', 'revision'];

test('AC-FE-F534-04 有版本查看权时，职位默认色卡片首次手动指定带版本 0', async ({ page }) => {
  await objectAccess(page, 'Succession.RiskResult', storedRiskFields, ['levelId']);
  await mockPositionRisk(page, () => defaultPositionRisk);
  const puts: { revision?: string; body: unknown }[] = [];
  await page.route(`**/succession/risk-results/${ids.position}`, (route) => {
    const request = route.request();
    puts.push({ revision: ifMatch(request), body: request.postDataJSON() });
    return route.fulfill({ json: riskResult(1, ids.level) });
  });
  await openMap(page, '职位继任地图');
  const dialog = await openRiskDialog(page);
  await dialog.getByRole('radio', { name: '手动赋值' }).check();
  await choose(page, dialog, '指定风险等级', '高风险');
  await button(dialog, '保存').click();
  await expect.poll(async () => puts.length > 0 || (await dialog.getByText(assignHint).isVisible())).toBe(true);
  expect(puts).toEqual([{ revision: '0', body: { levelId: ids.level } }]);
  await expect(dialog).toBeHidden();
});

for (const { name, risk, revision } of [
  { name: '结果键缺席', risk: undefined, revision: '0' },
  { name: '正常版本', risk: riskResult(3, ids.level), revision: '3' },
]) {
  test(`AC-FE-F534-01 ${name}：指定等级带正确版本提交`, async ({ page }) => {
    await mockPositionRisk(page, () => risk);
    const puts: { revision?: string; body: unknown }[] = [];
    await page.route(`**/succession/risk-results/${ids.position}`, (route) => {
      const request = route.request();
      puts.push({ revision: ifMatch(request), body: request.postDataJSON() });
      return route.fulfill({ json: riskResult(Number(revision) + 1, null) });
    });
    await openMap(page, '职位继任地图');
    const dialog = await openRiskDialog(page);
    await dialog.getByRole('radio', { name: '按规则计算' }).check();
    await button(dialog, '保存').click();
    await expect(dialog).toBeHidden();
    expect(puts).toEqual([{ revision, body: { levelId: null } }]);
  });
}

test('AC-FE-F534-01 结果投影缺版本：提示重读且不发 PUT，关闭后重读地图', async ({ page }) => {
  let reads = 0;
  await objectAccess(page, 'Succession.RiskResult', ['levelId'], ['levelId']);
  await mockPositionRisk(page, () => (++reads, { levelId: ids.level }));
  const revisions: (string | undefined)[] = [];
  await page.route(`**/succession/risk-results/${ids.position}`, (route) => {
    revisions.push(ifMatch(route.request()));
    return route.fulfill({ json: { levelId: null } });
  });
  await openMap(page, '职位继任地图');
  const dialog = await openRiskDialog(page);
  await dialog.getByRole('radio', { name: '按规则计算' }).check();
  await button(dialog, '保存').click();
  await expect.poll(async () => revisions.length > 0 || (await dialog.getByText(assignHint).isVisible())).toBe(true);
  expect(revisions).toEqual([]);
  await expect(dialog.getByText(assignHint)).toBeVisible();
  const before = reads;
  await button(dialog, '取消').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => reads).toBeGreaterThan(before);
});

test('AC-FE-F534-03 结果待确认：地图刷新后版本被裁剪，同一对象重开仍锁定', async ({ page }) => {
  let putCount = 0;
  await mockPositionRisk(page, () => (putCount ? { levelId: ids.level } : riskResult(1, ids.level)));
  await page.route(`**/succession/risk-results/${ids.position}`, (route) => {
    putCount += 1;
    return route.abort();
  });
  await openMap(page, '职位继任地图');
  const dialog = await openRiskDialog(page);
  await dialog.getByRole('radio', { name: '按规则计算' }).check();
  await button(dialog, '保存').click();
  await expect(dialog.getByText(/结果待确认/)).toBeVisible();
  await button(dialog, '取消').click();
  await expect(dialog).toBeHidden();
  const reopened = await openRiskDialog(page);
  await expect(reopened.getByText(/结果待确认/)).toBeVisible();
  await expect(reopened.getByRole('button', { name: '回查原单', exact: true })).toBeVisible();
  await expect(button(reopened, '保存')).toBeDisabled();
  expect(putCount).toBe(1);
});

test('AC-FE-R3d1-09 批量结束回执是 {items}：判为成功、关闭弹窗并刷新列表', async ({ page }) => {
  const errors = watchErrors(page);
  let reads = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/succession/records')) reads += 1;
  });
  await openMenu(page, '继任地图与列表');
  await expect(page.locator('.list-card')).toContainText('合成研发总监');
  const before = reads;
  await page.getByRole('checkbox').last().check();
  await button(page, '更多操作').click();
  await page.getByRole('menuitem', { name: '结束继任', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '结束继任', exact: true });
  const ended = page.waitForResponse((response) => response.url().endsWith('/succession/records/end'));
  await button(dialog, '保存').click();
  await ended;
  await expect(dialog).toBeHidden();
  await expect.poll(() => reads).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-10 个人筛选偏好：无 id 回执可连续保存，冲突后重读、核对、继续保存', async ({ page }) => {
  const errors = watchErrors(page);
  let server = { ...preferences, revision: 3 };
  let reject = false;
  const puts: { revision?: string; body: Record<string, unknown> }[] = [];
  await page.route('**/succession/maps/position/preferences', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: server });
    puts.push({ revision: ifMatch(request), body: request.postDataJSON() });
    if (reject) {
      // 别处已改成四级（版本 7）：本次 409，重读后看到差异。
      reject = false;
      server = { ...server, depth: 4, revision: 7 };
      return route.fulfill(conflict);
    }
    server = { ...server, ...request.postDataJSON(), revision: server.revision + 1 };
    return route.fulfill({ json: server });
  });
  await openMap(page, '职位继任地图');
  const drawer = page.getByRole('dialog', { name: '高级筛选', exact: true });
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await choose(page, drawer, '展示职位层级', '二级');
  await choose(page, drawer, '组织', '合成测试部');
  await button(drawer, '保存').click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.succession-page')).toContainText('展示职位层级：二级');
  expect(puts[0]).toMatchObject({ revision: '3', body: { depth: 2, rootOrgId: ids.childOrg } });

  reject = true;
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await choose(page, drawer, '展示职位层级', '三级');
  await button(drawer, '保存').click();
  await settledConflict(drawer);
  await drawer.getByRole('button', { name: '重读最新版本' }).click();
  await expect(drawer.getByRole('row', { name: /展示职位层级/ })).toBeVisible();
  await drawer.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await saveAgain(drawer);
  await expect(drawer).toBeHidden();
  expect(puts.at(-1)).toMatchObject({ revision: '7', body: { depth: 3 } });
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-11 / AC-FE-F534-02 风险等级冲突后重读，裁剪版本时保留冲突，读到版本再保存', async ({ page }) => {
  const errors = watchErrors(page);
  let risk: LevelResult = riskResult(1, ids.level);
  await objectAccess(page, 'Succession.RiskResult', storedRiskFields, ['levelId']);
  const revisions: (string | undefined)[] = [];
  await page.route(`**/succession/risk-results/${ids.position}`, async (route) => {
    revisions.push(ifMatch(route.request()));
    if (revisions.length === 1) {
      // 结果变为未命中等级，权限又隐藏 id/method/revision，投影与默认色完全相同。
      risk = defaultPositionRisk;
      await objectAccess(page, 'Succession.RiskResult', defaultRiskFields, ['levelId']);
      return route.fulfill(conflict);
    }
    return route.fulfill({ json: riskResult(5, null) });
  });
  await mockPositionRisk(page, () => risk);
  await openMap(page, '职位继任地图');
  const dialog = await openRiskDialog(page);
  await dialog.getByRole('radio', { name: '按规则计算' }).check();
  await button(dialog, '保存').click();
  await settledConflict(dialog);
  const reload = dialog.getByRole('button', { name: '重读最新版本' });
  const confirm = dialog.getByRole('button', { name: '已核对差异，继续编辑' });
  await reload.click();
  const readError = dialog.getByText('读取失败，输入已保留，请重新读取。');
  await expect.poll(async () => (await confirm.isVisible()) || (await readError.isVisible())).toBe(true);
  await expect(confirm).toBeHidden();
  await expect(readError).toBeVisible();
  await expect(button(dialog, '保存')).toBeDisabled();
  expect(revisions).toEqual(['1']);

  risk = riskResult(4, ids.level);
  await objectAccess(page, 'Succession.RiskResult', storedRiskFields, ['levelId']);
  await reload.click();
  await confirm.click();
  await saveAgain(dialog);
  await expect(dialog).toBeHidden();
  expect(revisions).toEqual(['1', '4']);
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-12 editableFields 为空时赋值与批量结束都只读', async ({ page }) => {
  await objectAccess(page, 'Succession.RiskResult', ['levelId'], []);
  const record = objectFields['Succession.Record']!;
  await objectAccess(
    page,
    'Succession.Record',
    record,
    record.filter((field) => !['endDate', 'endReason'].includes(field)),
  );
  await openMenu(page, '继任地图与列表');
  await page.getByRole('checkbox').last().check();
  await button(page, '更多操作').click();
  await page.getByRole('menuitem', { name: '结束继任', exact: true }).click();
  const end = page.getByRole('dialog', { name: '结束继任', exact: true });
  await expect(end).toContainText('结束日期');
  await expect(end.locator('input')).toHaveCount(0);
  await button(end, '取消').click();

  await page.getByRole('tab', { name: '职位继任地图', exact: true }).click();
  const card = page.locator('.succession-card', { hasText: '合成研发总监' });
  await card.getByRole('button', { name: '卡片操作' }).click();
  await page.getByRole('menuitem', { name: '设置风险等级', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置风险等级', exact: true });
  await expect(dialog).toContainText('指定风险等级');
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(dialog.locator('input')).toHaveCount(0);
});

test('AC-FE-R3d1-13 状态、继任类型字段隐藏时查询不带这两个参数', async ({ page }) => {
  const record = objectFields['Succession.Record']!.filter((field) => !['status', 'successionType'].includes(field));
  await objectAccess(page, 'Succession.Record', record, record);
  const queries: URLSearchParams[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/succession/records')) queries.push(url.searchParams);
  });
  await openMenu(page, '继任地图与列表');
  await expect(page.locator('.list-card')).toContainText('合成研发总监');
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query.has('status')).toBe(false);
    expect(query.has('successionType')).toBe(false);
  }
});

test('AC-FE-R3d1-14 健康度规则设置：人员范围与继任地图健康度两个页签', async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page, '健康度规则设置');
  await expect(page).toHaveURL(/\/succession\/settings\/health$/);
  await expect(page.getByRole('tab', { name: '人员范围', exact: true })).toHaveAttribute('aria-selected', 'true');
  const populations = page.locator('.succession-page .list-card').first();
  await expect(populations).toContainText('合成青年人才');
  await expect(page.locator('.succession-rules').first()).toContainText('年龄');
  await page.getByRole('tab', { name: '继任地图健康度', exact: true }).click();
  await expect(page.locator('.succession-page')).toContainText('高风险');
  await expect(page.locator('.succession-rules').first()).toContainText('1 and 2');
  expect(errors).toEqual([]);
});
