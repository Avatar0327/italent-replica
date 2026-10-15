import { test, expect, user } from './fixtures.js';

for (const entry of [
  { path: '/staff', menu: '员工', note: '员工列表使用紧凑表格', button: '高级筛选' },
  { path: '/transfer', menu: '调动管理', note: '调动管理为横向三个视图', button: '调动中员工' },
  { path: '/approval', menu: '审批中心', note: '我的待办左侧为搜索', heading: '待处理' },
]) {
  test(`AC-FE-R1c-20 合 main 保留 ${entry.path} 的页面、菜单和注释`, async ({ page }) => {
    // 从不同地址切换，避免 waitForURL 在身份跳转前因旧地址已匹配而提前结束。
    await page.goto('/approval');
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(entry.path);
    await expect(page.getByRole('menuitem', { name: entry.menu, exact: true })).toBeVisible();
    if (entry.button) await expect(page.getByRole('button', { name: entry.button, exact: true })).toBeVisible();
    if (entry.heading) await expect(page.getByRole('heading', { name: entry.heading, exact: true })).toBeVisible();
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.locator('.decision-note').filter({ hasText: entry.note })).toBeVisible();
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.locator('.decision-note')).toHaveCount(0);
  });
}
