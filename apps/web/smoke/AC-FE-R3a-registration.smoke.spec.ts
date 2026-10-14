import { test, expect, user } from './fixtures.js';

for (const [label, path, title] of [
  ['人才标准', '/talent', '指标库'],
  ['任职资格', '/qualification', '任职类别'],
] as const) {
  test(`AC-FE-R3a 合并 main 后保留${label}菜单、路由与注释`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/staff');
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    const notes = page.locator('.catalog-page .decision-note');
    await expect(notes).toHaveCount(0);
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(notes).toHaveCount(1);
    await expect(notes).toContainText('DEC-456');
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(notes).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
