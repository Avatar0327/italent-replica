import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { APP_ROUTES } from '../src/foundation/routes.js';

// 同一演示库分别在改造前后执行；基线只保存合成身份的菜单标签，不保存 Cookie。
test('AC-FE-F114 六类身份应用和企业设置菜单前后对照', async ({ page, request }, info) => {
  test.setTimeout(360_000);
  const visible = expect.configure({ timeout: 90_000 });
  const manifest = await (await request.get('/__demo/personas')).json();
  const roles = ['系统管理员', 'HR（HRBP）', '部门负责人（经理）', '普通员工', '审计管理员', '无权限用户'];
  const personas = roles.map((role) => manifest.personas.find((p: { role: string }) => p.role === role));
  expect(personas.every(Boolean)).toBe(true);
  const result: Record<string, { apps: string[]; settings: string[] }> = {};
  for (const persona of personas) {
    await page.goto('/approval');
    await page.getByLabel('切换演示身份').selectOption(persona.userId);
    await page.waitForURL(`**${persona.entry}`);
    await visible(page.locator('.shell-workspace h1, .shell-workspace .ant-result-title').first()).toBeVisible();
    await page.goto('/approval');
    await visible(page.locator('.shell-workspace h1')).toBeVisible();
    const apps = await page
      .locator('.shell-sidebar .ant-menu-item, .shell-sidebar .ant-menu-submenu-title')
      .allTextContents();
    const appLabels = apps.filter((label) => APP_ROUTES.some((app) => app.label === label));
    const settings = page.locator('.shell-sidebar .ant-menu-submenu-title').filter({ hasText: '企业设置' });
    let settingLabels: string[] = [];
    if (await settings.count()) {
      await settings.click();
      settingLabels = await page.locator('.shell-sidebar .ant-menu-sub .ant-menu-item').allTextContents();
    }
    result[persona.role] = { apps: appLabels, settings: settingLabels };
  }
  const report = JSON.stringify(result, null, 2);
  await info.attach('六类身份菜单', { body: report, contentType: 'application/json' });
  if (process.env.F114_BASELINE) writeFileSync(process.env.F114_BASELINE, report);
  if (process.env.F114_COMPARE) expect(result).toEqual(JSON.parse(readFileSync(process.env.F114_COMPARE, 'utf8')));
});
