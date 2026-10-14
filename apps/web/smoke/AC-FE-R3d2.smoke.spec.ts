import type { Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';
import { mockIdp } from './r3d2-fixtures.js';
test.use({ viewport: { width: 1440, height: 1000 } });

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
async function openMenu(page: Page, name: string) {
  await page.goto('/idp');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('menuitem', { name: '人才发展计划', exact: true }).click();
  // 应用入口先落到第一张有权限的列表，再点下一层菜单，避免与入口重定向竞争
  await expect(page).toHaveURL(/\/idp\/plans$/);
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test('AC-FE-R3d2-01 发展计划：列表、流程干预菜单、详情抽屉与新增表单可渲染', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await openMenu(page, '发展计划');
  await expect(page).toHaveURL(/\/idp\/plans$/);
  await expect(page.getByRole('heading', { name: '未开始&进行中' })).toBeVisible();
  await expect(page.getByRole('button', { name: '合成发展计划', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '合成未开始计划', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '直线经理' }).first()).toBeVisible();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.locator('.idp-page .decision-note').first()).toContainText('DEC-494');
  await page.getByRole('switch', { name: '注释' }).click();
  await page.screenshot({ path: testInfo.outputPath('plans.png'), fullPage: true, animations: 'disabled' });

  await page
    .getByRole('row', { name: /合成发展计划/ })
    .getByRole('checkbox')
    .check();
  await page.getByRole('button', { name: '流程干预' }).click();
  for (const name of ['催办', '跳转', '开启下个阶段', '终止计划'])
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '合成发展计划', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '合成发展计划' });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: '发展目标', exact: true })).toBeVisible();
  await expect(detail.getByText('合成发展目标')).toBeVisible();
  await expect(detail.getByText('演示数据').first()).toBeVisible();
  await expect(detail.getByRole('button', { name: /转\s*交/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('plan-detail.png'), fullPage: true, animations: 'disabled' });
  await detail.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: /新\s*增/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增发展计划' });
  await expect(form.getByLabel('计划名称')).toBeVisible();
  await expect(form.getByLabel('指导人角色')).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-02 我的发展计划：员工自助下列表与详情抽屉可渲染', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await page.goto('/idp');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.goto('/self/idp');
  await expect(page.getByRole('heading', { name: '我的发展计划' })).toBeVisible();
  await page.getByRole('button', { name: '合成发展计划', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '合成发展计划' }).getByText('合成发展目标')).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-03 发展计划模板：列表、只读详情与新增表单可渲染', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await openMenu(page, '发展计划模板');
  await expect(page).toHaveURL(/\/idp\/templates$/);
  await expect(page.getByRole('heading', { name: '启用的模板' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '合成发展计划流程' })).toBeVisible();
  await page.getByRole('button', { name: '合成发展计划模板', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '合成发展计划模板' });
  await expect(detail.getByText('当前模板已被引用')).toBeVisible();
  await expect(detail.getByText('基本信息').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('template.png'), fullPage: true, animations: 'disabled' });
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: /新\s*增/, exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新增发展计划模板' }).getByLabel('模板名称')).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-04 发展计划流程：列表与编辑表单（含子流程）可渲染', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await openMenu(page, '发展计划流程');
  await expect(page).toHaveURL(/\/idp\/processes$/);
  await expect(page.getByRole('heading', { name: '启用的流程' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '合成发展计划流程' })).toBeVisible();
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  await expect(form.getByLabel('流程名称')).toHaveValue('合成发展计划流程');
  await expect(form.getByRole('cell', { name: '合成制定阶段' })).toBeVisible();
  await expect(form.getByRole('cell', { name: '制定计划' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-05 没有数据范围时列表显示空范围提示，不回退演示数据', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { hasDataPermission: false });
  await openMenu(page, '发展计划');
  await expect(page.getByText('当前没有可查看的数据范围')).toBeVisible();
  await expect(page.getByRole('button', { name: '合成发展计划', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
