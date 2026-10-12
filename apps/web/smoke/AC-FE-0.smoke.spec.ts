import { test, expect, tenant, user } from './fixtures.js';
import { APP_ROUTES } from '../src/foundation/routes.js';

test('AC-FE-0-04 通过现有演示身份选择器进入应用，注释可切换', async ({ page }) => {
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('heading', { name: '员工管理', exact: true })).toBeVisible();
  expect((await page.context().cookies()).find((cookie) => cookie.name === 'italent_demo_tenant')?.value).toBe(tenant);
  await expect(page.getByText('DEC-456', { exact: true })).toHaveCount(0);
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.getByText('DEC-456', { exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
  await expect(page).toHaveURL(/\/talent-review$/);
  await expect(page.getByText('DEC-456', { exact: true })).toBeVisible();
});

for (const app of APP_ROUTES) {
  test(`AC-FE-0-05 ${app.path} 应用首页无运行时错误`, async ({ page, baseURL }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().addCookies([
      { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
      { name: 'italent_demo_user', value: user, url: baseURL! },
    ]);
    await page.goto(app.path);
    await expect(page.locator('.shell-workspace h1').first()).toBeVisible();
    await expect(page.locator('.shell-context')).toContainText(app.label);
    await expect(page.locator('.shell-workspace')).not.toContainText('正在加载');
    expect(errors).toEqual([]);
  });
}

test('AC-FE-0-06 旧路径保留参数与锚点，无权限页和未知页面均可恢复', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.goto('/jobs?page=2#list');
  await expect(page).toHaveURL(/\/job\?page=2#list$/);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.route('**/permission/me/objects/TenantBase.Organization', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'FORBIDDEN' } },
    }),
  );
  await page.goto('/org');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  await page.goto('/not-a-page');
  await expect(page.getByText('页面或记录不存在', { exact: true })).toBeVisible();
});
