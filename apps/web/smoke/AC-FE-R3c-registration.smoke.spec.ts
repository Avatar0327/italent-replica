import { test, expect, user } from './fixtures.js';

for (const [label, path, selector, noteCount] of [
  ['员工', '/staff', '.staff-page', 2],
  ['人才盘点', '/talent-review', '.talent-review-page', 1],
] as const) {
  test(`AC-FE-R3c-10 合并后保留${label}菜单、页面与注释`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/staff');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    const content = page.locator(selector);
    await expect(content).toBeVisible();
    await expect(content.locator('.decision-note')).toHaveCount(0);
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(content.locator('.decision-note')).toHaveCount(noteCount);
    for (const note of await content.locator('.decision-note').all()) await expect(note).toContainText('DEC-456');
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(content.locator('.decision-note')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const [label, path, title, noteCount] of [
  ['人才评定', '/evaluation', '活动设置', 2],
  ['360 评估', '/survey360', '评估活动', 2],
  ['企业设置', '/settings/menu/users.all', '全部用户', 3],
] as const) {
  test(`AC-FE-R3c-10 串行合并保留${label}菜单、页面与注释`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/staff');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.getByRole('switch', { name: '注释' }).click();
    const notes = page.locator('.shell-content .decision-note');
    await expect(notes).toHaveCount(noteCount);
    for (const note of await notes.all()) await expect(note).toContainText('DEC-456');
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(notes).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
