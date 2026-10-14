import { test, expect } from './fixtures.js';
import { button, cancel, ids, mockSuccession, openMenu, openShell, orgMap, watchErrors } from './r3d1-fixtures.js';

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeEach(async ({ page }) => mockSuccession(page));

test('AC-FE-R3d1-01 职位继任列表：勾选行编辑、新增表单、更多操作里批量结束', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图与列表');
  await expect(page.getByRole('tab', { name: '职位继任列表', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.list-card')).toContainText('合成研发总监');
  // 原站列表没有视图名下拉，筛选是列表上方一排字段（UI2 对照）。
  await expect(page.locator('.succession-records').getByRole('button', { name: '切换视图' })).toBeHidden();
  await expect(page.locator('.succession-filter', { hasText: '继任者' })).toBeVisible();
  await expect(page.locator('.list-card')).toContainText('随时可继任');
  await expect(page.locator('.list-card')).toContainText('至今');
  // 修改时间是 UTC 事件时间，按租户时区（上海）显示：02:00Z → 10:00（DEC-056）。
  await expect(page.locator('.list-card')).toContainText('2026-10-02 10:00');
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.locator('.succession-page .decision-note').first()).toContainText('DEC-');
  await page.getByRole('switch', { name: '注释' }).click();
  await page.screenshot({ path: testInfo.outputPath('position-list.png'), fullPage: true, animations: 'disabled' });

  await expect(button(page, '编辑')).toBeDisabled();
  await page.getByRole('checkbox').last().check();
  await button(page, '编辑').click();
  await expect(page.getByRole('dialog', { name: '编辑继任', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('record-form.png'), fullPage: true, animations: 'disabled' });
  await cancel(page);

  await button(page, '新增').click();
  await expect(page.getByRole('dialog', { name: '新增职位继任', exact: true })).toContainText('目标职位');
  await cancel(page);

  await button(page, '更多操作').click();
  await page.getByRole('menuitem', { name: '结束继任', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '结束继任', exact: true })).toContainText('结束日期');
  await cancel(page);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-02 组织继任列表：组织名称、部门负责人、后备类型', async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '组织继任列表', exact: true }).click();
  const list = page.locator('.list-card');
  await expect(list).toContainText('合成研发中心');
  await expect(list).toContainText('合成负责人');
  await expect(list).toContainText('正职');
  for (const header of ['组织名称', '部门负责人', '后备类型']) {
    await expect(list.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-03 职位继任地图：风险色卡片、虚位以待、设置风险等级', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '职位继任地图', exact: true }).click();
  const card = page.locator('.succession-card', { hasText: '合成研发总监' });
  await expect(card).toContainText('继任者 1人');
  // 职位卡显示现任姓名，不只显示人数（接口已回 incumbents）。
  await expect(card).toContainText('合成现任');
  await expect(page.locator('.succession-card', { hasText: '合成架构师' })).toContainText('虚位以待');
  // 原站是画布：父子之间有连线，可缩放（UI2 对照）。
  const canvas = page.locator('.succession-canvas');
  await expect(canvas.locator('.succession-link')).toHaveCount(1);
  await expect(canvas.locator('.succession-canvas-content')).toHaveAttribute('style', /scale\(1\)/);
  await button(page, '放大').click();
  await expect(canvas.locator('.succession-canvas-content')).toHaveAttribute('style', /scale\(1\.1\)/);
  await page.getByRole('button', { name: '重置缩放', exact: true }).click();
  await expect(canvas.locator('.succession-canvas-content')).toHaveAttribute('style', /scale\(1\)/);
  await button(page, '展开继任者').click();
  await expect(card).toContainText('随时可继任');
  await page.screenshot({ path: testInfo.outputPath('position-map.png'), fullPage: true, animations: 'disabled' });
  await card.getByRole('button', { name: '卡片操作' }).click();
  await page.getByRole('menuitem', { name: '设置风险等级', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置风险等级', exact: true });
  await expect(dialog).toContainText('赋值方式');
  await cancel(page);
  await expect(page.locator('.succession-page')).toContainText('展示职位层级：三级');
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '高级筛选', exact: true })).toContainText('展示无继任者的职位');
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
  // 组织地图用 keyPositions[] 建关键职位卡，带风险等级。
  await expect(page.locator('.succession-card', { hasText: '合成关键职位' })).toContainText('高风险');
  await card.getByRole('button', { name: '卡片操作' }).click();
  await page.getByRole('menuitem', { name: '设置健康度', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置健康度', exact: true })).toContainText('赋值方式');
  await cancel(page);
  // 组织根筛选：按组织读权限给出选择入口，选中后以 root 查询。
  const rooted = page.waitForRequest((request) => new URL(request.url()).searchParams.get('root') === ids.childOrg);
  await page.getByRole('combobox', { name: '组织', exact: true }).click();
  await page.getByTitle('合成测试部').click();
  await rooted;
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-05 继任地图设置：风险等级列表与新建表单', async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page, '继任地图设置');
  await expect(page).toHaveURL(/\/succession\/settings\/map$/);
  // 健康度挪到独立的“健康度规则设置”页（UI2 对照），这里只剩显示设置和风险等级。
  await expect(page.getByRole('tab', { name: '组织健康度设置', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '职位风险等级设置', exact: true }).click();
  await expect(page.locator('.list-card').first()).toContainText('高风险');
  // 规则只读也要显示条件行和表达式。
  const rules = page.locator('.succession-rules').first();
  await expect(rules).toContainText('1 and 2');
  await expect(rules).toContainText('现任人员');
  await expect(rules).toContainText('小于');
  await button(page, '新建').first().click();
  await expect(page.getByRole('dialog', { name: '新建职位风险等级', exact: true })).toContainText('颜色');
  await cancel(page);
  await page.getByRole('tab', { name: '继任地图显示设置', exact: true }).click();
  await expect(page.locator('.succession-page')).toContainText('演示数据');
  expect(errors).toEqual([]);
});

test('AC-FE-R3d1-06 关键岗位为演示数据，准备度可编辑、无启用开关、无总数分页', async ({ page }) => {
  const errors = watchErrors(page);
  await page.route('**/api/tenant/talent-review/readiness-levels**', (route) => {
    const current = Number(new URL(route.request().url()).searchParams.get('page'));
    const items = Array.from({ length: current === 1 ? 15 : 1 }, (_, index) => ({
      id: `54000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
      code: `R${current}-${index}`,
      name: index === 0 ? `随时可继任${current}` : `合成阶段${current}-${index}`,
      color: '#2BA471',
      sortNo: index,
      enabled: true,
      revision: 1,
    }));
    return route.fulfill({ json: { page: current, pageSize: 15, items } });
  });
  // 先等侧栏就绪，再只导航一次（不重复点击）。
  await openShell(page);
  await page.goto('/succession/settings/key-positions');
  await expect(page.locator('.succession-page')).toContainText('演示数据');
  await page.getByRole('menuitem', { name: '准备度', exact: true }).click();
  const row = page.getByRole('row', { name: /随时可继任1/ });
  await expect(row).toBeVisible();
  // 接口不给 total：满页时允许下一页。
  await button(page, '下一页').click();
  await expect(page.getByRole('row', { name: /随时可继任2/ })).toBeVisible();
  await expect(button(page, '下一页')).toBeDisabled();
  await button(page, '上一页').click();
  await button(page.getByRole('row', { name: /随时可继任1/ }), '编辑').click();
  const dialog = page.getByRole('dialog', { name: '编辑准备度', exact: true });
  await expect(dialog).toContainText('编码');
  await expect(dialog.getByRole('switch')).toHaveCount(0);
  await expect(dialog).not.toContainText('是否启用');
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
