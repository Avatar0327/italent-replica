import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { APP_ROUTES } from './page-registry.js';

const roles = ['系统管理员', 'HR（HRBP）', '部门负责人（经理）', '普通员工', '审计管理员', '无权限用户'];
// 同一演示库分别在改造前后执行；基线只保存合成身份的菜单标签，不保存 Cookie。
for (const role of roles) {
  test(`AC-FE-F114 ${role} 应用和企业设置菜单前后对照`, async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const manifest = await (await request.get('/__demo/personas')).json();
    const persona = manifest.personas.find((p: { role: string }) => p.role === role);
    expect(persona).toBeDefined();
    await page.goto('/approval');
    await page.getByLabel('切换演示身份').selectOption(persona.userId);
    await page.waitForURL(`**${persona.entry}`);
    await expect(page.locator('.shell-workspace h1, .shell-workspace .ant-result-title').first()).toBeVisible({
      timeout: 120_000,
    });
    const apps = await page
      .locator('.shell-sidebar .ant-menu-item, .shell-sidebar .ant-menu-submenu-title')
      .allTextContents();
    const appLabels = apps.filter((label) => APP_ROUTES.some((app) => app.label === label));
    const settings = page.locator('.shell-sidebar .ant-menu-submenu-title').filter({ hasText: '企业设置' });
    let settingLabels: string[] = [];
    if (await settings.count()) {
      if (!(await settings.locator('..').getAttribute('class'))?.includes('ant-menu-submenu-open'))
        await settings.click();
      settingLabels = await page.locator('.shell-sidebar .ant-menu-sub .ant-menu-item').allTextContents();
    }
    const result = { apps: appLabels, settings: settingLabels };
    await info.attach('身份菜单', { body: JSON.stringify(result), contentType: 'application/json' });
    if (process.env.F114_BASELINE) {
      const path = process.env.F114_BASELINE;
      const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      writeFileSync(path, JSON.stringify({ ...previous, [role]: result }, null, 2));
    }
    if (process.env.F114_COMPARE)
      expect(result).toEqual(JSON.parse(readFileSync(process.env.F114_COMPARE, 'utf8'))[role]);
  });
}
