import { test, expect, tenant, user } from './fixtures.js';

test('AC-FE-F114 首屏一次快照，失败可重试且 401 显示登录态', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  const calls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/tenant/')) calls.push(path);
  });
  let status = 503;
  await page.route('**/permission/me/snapshot', async (route) => {
    if (status !== 200) return route.fulfill({ status, json: { error: { code: 'FAILED' } } });
    return route.fallback();
  });
  await page.goto('/approval');
  await expect(page.getByRole('alert')).toContainText('加载失败');
  await expect(page.locator('.shell-sidebar [role="menuitem"]')).toHaveCount(0);
  expect(calls).toEqual(['/api/tenant/permission/me/snapshot']);
  status = 200;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.locator('.approval-list-panel')).toBeVisible();
  expect(calls.filter((path) => path === '/api/tenant/permission/me/snapshot')).toEqual(
    Array(2).fill('/api/tenant/permission/me/snapshot'),
  );
  status = 401;
  await page.reload();
  await expect(page.locator('.shell-workspace')).toContainText('请选择演示身份或提供会话上下文');
  await expect(page.locator('.shell-sidebar [role="menuitem"]')).toHaveCount(0);
});
