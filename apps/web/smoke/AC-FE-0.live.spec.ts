import { test, expect, type Page } from '@playwright/test';
import { APP_ROUTES } from './page-registry.js';

const expectLive = expect.configure({ timeout: 15_000 });
// 先在本 worktree 运行 pnpm demo；本测试不拦截 API、不改业务数据，只切换演示身份与打开页面。
async function enterHr(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption({ label: 'HR专员（演示）（HR（HRBP））' });
  await expectLive(page.locator('.shell-workspace h1')).toHaveText('调动管理');
  return errors;
}

for (const app of APP_ROUTES) {
  test(`AC-FE-0-08 真实演示身份打开 ${app.path}`, async ({ page }) => {
    const errors = await enterHr(page);
    await page.goto(app.path);
    await expectLive(page.locator('.shell-workspace h1, .shell-workspace .ant-result-title').first()).toBeVisible();
    await expectLive(page.locator('.shell-workspace')).not.toContainText('加载失败');
    await expectLive(page.locator('.shell-workspace')).not.toContainText('正在加载');
    expect(errors).toEqual([]);
  });
}

test('AC-FE-0-08 真实 HR 与员工身份切换，员工不能继承职务入口', async ({ page }, testInfo) => {
  const errors = await enterHr(page);
  await page.goto('/staff');
  await expectLive(page.locator('.shell-workspace h1')).toHaveText('员工');
  await page.screenshot({ path: testInfo.outputPath('staff.png'), fullPage: true });
  await page.getByLabel('切换演示身份').selectOption({ label: '平台研发员工甲（演示）（普通员工）' });
  await expectLive(page).toHaveURL(/\/self$/);
  await expectLive(page.locator('.shell-workspace h1')).toBeVisible();
  await expectLive(page.getByRole('menuitem', { name: '职务体系', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
