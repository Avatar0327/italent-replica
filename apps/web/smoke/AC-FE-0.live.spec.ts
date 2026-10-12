import { test, expect } from '@playwright/test';
import { APP_ROUTES } from '../src/foundation/routes.js';

const expectLive = expect.configure({ timeout: 15_000 });
// 先在本 worktree 运行 pnpm demo；本测试不拦截 API、不改业务数据，只切换演示身份与打开页面。
test('AC-FE-0-08 真实演示身份与现有后端集成', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption({ label: 'HR专员（演示）（HR（HRBP））' });
  await expectLive(page.locator('.shell-workspace h1')).toHaveText('调动管理');
  for (const app of APP_ROUTES) {
    await page.goto(app.path);
    await expectLive(page.locator('.shell-workspace h1, .shell-workspace .ant-result-title').first()).toBeVisible();
    await expectLive(page.locator('.shell-workspace')).not.toContainText('加载失败');
    await expectLive(page.locator('.shell-workspace')).not.toContainText('正在加载');
  }
  await page.goto('/staff');
  await expectLive(page.locator('.shell-workspace h1')).toHaveText('员工');
  await page.screenshot({ path: testInfo.outputPath('staff.png'), fullPage: true });
  await page.getByLabel('切换演示身份').selectOption({ label: '平台研发员工甲（演示）（普通员工）' });
  await expectLive(page).toHaveURL(/\/self$/);
  await expectLive(page.locator('.shell-workspace h1')).toBeVisible();
  await expectLive(page.getByRole('menuitem', { name: '职务体系', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
