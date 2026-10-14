import type { Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';
import { mockSuccession, orgMap } from './r3d1-fixtures.js';

test.use({ viewport: { width: 1440, height: 1000 } });

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
// antd 会在两个汉字的按钮文字中间插空格（“新 建”），按钮名按字间可有空白匹配。
const button = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${[...name].join('\\s*')}$`) });
async function openMenu(page: Page, item: string) {
  await page.goto('/succession');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('menuitem', { name: '继任管理', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
const cancel = (page: Page) =>
  page
    .getByRole('button', { name: /取\s*消/ })
    .last()
    .click();

test.beforeEach(async ({ page }) => mockSuccession(page));

test('AC-FE-R3d1-01 职位继任列表：列表、详情抽屉、编辑与新增表单、批量结束', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图与列表');
  await expect(page.getByRole('tab', { name: '职位继任列表', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(button(page, '合成研发总监')).toBeVisible();
  await expect(page.locator('.list-card')).toContainText('随时可继任');
  await expect(page.locator('.list-card')).toContainText('至今');
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.locator('.succession-page .decision-note').first()).toContainText('DEC-');
  await page.getByRole('switch', { name: '注释' }).click();
  await page.screenshot({ path: testInfo.outputPath('position-list.png'), fullPage: true, animations: 'disabled' });

  await button(page, '合成研发总监').click();
  await expect(page.getByRole('dialog', { name: '合成研发总监', exact: true })).toContainText('合成继任者');
  await button(page, '编辑').click();
  await expect(page.getByRole('dialog', { name: '编辑继任', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('record-form.png'), fullPage: true, animations: 'disabled' });
  await cancel(page);
  await page.getByRole('dialog', { name: '合成研发总监', exact: true }).getByRole('button', { name: '关闭' }).click();

  await button(page, '新增').click();
  await expect(page.getByRole('dialog', { name: '新增职位继任', exact: true })).toContainText('目标职位');
  await cancel(page);

  await page.getByRole('checkbox').last().check();
  await button(page, '结束继任').click();
  await expect(page.getByRole('dialog', { name: '结束继任', exact: true })).toContainText('结束日期');
  await cancel(page);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-02 组织继任列表与详情', async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '组织继任列表', exact: true }).click();
  await button(page, '合成研发中心').click();
  await expect(page.getByRole('dialog', { name: '合成研发中心', exact: true })).toContainText('合成负责人');
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-03 职位继任地图：风险色卡片、虚位以待、设置风险等级', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '职位继任地图', exact: true }).click();
  const card = page.locator('.succession-card', { hasText: '合成研发总监' });
  await expect(card).toContainText('继任者 1人');
  await expect(page.locator('.succession-card', { hasText: '合成架构师' })).toContainText('虚位以待');
  await button(page, '展开继任者').click();
  await expect(card).toContainText('随时可继任');
  await page.screenshot({ path: testInfo.outputPath('position-map.png'), fullPage: true, animations: 'disabled' });
  await card.getByRole('button', { name: '卡片操作' }).click();
  await page.getByRole('menuitem', { name: '设置风险等级', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置风险等级', exact: true });
  await expect(dialog).toContainText('赋值方式');
  await cancel(page);
  await button(page, '筛选').click();
  await expect(page.getByRole('dialog', { name: '职位地图筛选', exact: true })).toContainText('展示无继任者');
  await cancel(page);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-04 组织继任地图：健康度、绿化率与设置健康度', async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '组织继任地图', exact: true }).click();
  const card = page.locator('.succession-card', { hasText: '合成研发中心' });
  await expect(card).toContainText('绿化率');
  await expect(card).toContainText('50%');
  await expect(card).toContainText('合成继任者');
  await card.getByRole('button', { name: '卡片操作' }).click();
  await page.getByRole('menuitem', { name: '设置健康度', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置健康度', exact: true })).toContainText('赋值方式');
  await cancel(page);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-05 继任地图设置：风险等级列表与新建表单', async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图设置');
  await expect(page).toHaveURL(/\/succession\/settings\/map$/);
  await page.getByRole('tab', { name: '职位风险等级设置', exact: true }).click();
  await expect(page.locator('.list-card').first()).toContainText('高风险');
  await button(page, '新建').first().click();
  await expect(page.getByRole('dialog', { name: '新建职位风险等级', exact: true })).toContainText('颜色');
  await cancel(page);
  await page.getByRole('tab', { name: '继任地图显示设置', exact: true }).click();
  await expect(page.locator('.succession-page')).toContainText('演示数据');
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-06 关键岗位为演示数据，准备度可编辑', async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page, '关键岗位');
  await expect(page.locator('.succession-page')).toContainText('演示数据');
  await page.getByRole('menuitem', { name: '准备度', exact: true }).click();
  await expect(button(page, '随时可继任')).toBeVisible();
  await button(page, '随时可继任').click();
  await expect(page.getByRole('dialog', { name: '编辑准备度', exact: true })).toBeVisible();
  await cancel(page);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-07 无数据范围时列表与地图都不混入演示数据', async ({ page }) => {
  await page.route(/\/api\/tenant\/succession\/(records|maps\/position)(\?|$)/, (route) =>
    route.fulfill({ json: { items: [], roots: [], total: 0, hasDataPermission: false } }),
  );
  await openMenu(page, '继任地图与列表');
  await expect(page.locator('.list-card')).toContainText('当前没有可查看的数据范围');
  await page.getByRole('tab', { name: '职位继任地图', exact: true }).click();
  await expect(page.locator('.succession-page')).toContainText('当前没有可查看的数据范围');
  await expect(page.locator('.succession-page')).not.toContainText('演示数据');
});

test('AC-FE-R3d1-08 继任人数字段隐藏时，卡片不按继任者名单补算人数', async ({ page }) => {
  const items = orgMap.items.map(({ successorCount: _hidden, ...item }) => item);
  await page.route(/\/api\/tenant\/succession\/maps\/org(\?|$)/, (route) =>
    route.fulfill({ json: { ...orgMap, items } }),
  );
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '组织继任地图', exact: true }).click();
  const card = page.locator('.succession-card', { hasText: '合成研发中心' });
  await expect(card).toContainText('合成继任者');
  await expect(card).not.toContainText('继任者 1人');
});
