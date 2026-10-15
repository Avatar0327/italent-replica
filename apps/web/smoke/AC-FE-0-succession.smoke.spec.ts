import { test, expect, tenant, user, mapPreferences } from './fixtures.js';
import { s } from '../src/succession/messages.js';

// F-176：职位筛选要等个人偏好读回才渲染，AC-FE-0-05 只断言一次标题会和偏好响应赛跑；
// 这里等筛选条出现后再确认整页未被错误边界替换。
test('AC-FE-0-05 /succession 职位地图读回个人偏好后不进错误态', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.goto('/succession');
  const workspace = page.locator('.shell-workspace');
  const depth = `${s.map.positionDepth}：${s.map.depthLabels[mapPreferences.depth]}`;
  await expect(workspace.getByRole('button', { name: depth })).toBeVisible();
  await expect(workspace.getByRole('alert')).toHaveCount(0);
  await expect(workspace.locator('h1').first()).toBeVisible();
});
