import { test, expect, tenant, user, mapPreferences } from './fixtures.js';
import { ui } from '../src/foundation/messages.js';
import { s } from '../src/succession/messages.js';

// F-180：偏好读回形状异常只影响筛选条——局部报错可见、可重读，地图其余区域照常，整页不进错误态。
test('F-180 /succession 偏好接口返回异常形状时局部报错，重读恢复后正常显示', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  let reply: unknown = { items: [], total: 0, hasDataPermission: true };
  await page.route('**/succession/maps/position/preferences', (route) => route.fulfill({ json: reply }));
  await page.goto('/succession');
  const workspace = page.locator('.shell-workspace');
  const toolbar = workspace.locator('.succession-toolbar');
  const failure = toolbar.getByRole('alert');
  await expect(failure).toContainText(s.map.preferencesInvalid);
  await expect(workspace.getByText(ui.failed)).toHaveCount(0);
  await expect(workspace.locator('h1').first()).toBeVisible();
  await expect(toolbar.getByRole('button', { name: s.map.expand })).toBeVisible();
  await expect(workspace.getByText(ui.empty)).toBeVisible();

  reply = mapPreferences;
  // antd 两字按钮文案中间自动加空格（“刷 新”）。
  await failure.getByRole('button', { name: /刷\s*新/ }).click();
  const depth = `${s.map.positionDepth}：${s.map.depthLabels[mapPreferences.depth]}`;
  await expect(toolbar.getByRole('button', { name: depth })).toBeVisible();
  await expect(toolbar.getByRole('alert')).toHaveCount(0);
});
