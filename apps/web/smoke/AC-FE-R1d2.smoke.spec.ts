import { test, expect, user } from './fixtures.js';

const menus = [
  ['users.internal', '内部员工'],
  ['users.all', '全部用户'],
  ['users.external', '外部用户'],
  ['permission.profiles', '身份管理'],
  ['permission.user_grant', '用户授权'],
  ['permission.mous', '管理单元'],
  ['audit.business', '数据变更日志'],
];
for (const [code, title] of menus) {
  test(`AC-FE-R1d2 ${title} 切换身份后列表、抽屉与注释可用`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/permission/admin-menus', (route) =>
      route.fulfill({
        json: {
          items: menus.map(([code, path]) => ({ code, path, editable: true, implemented: true })),
        },
      }),
    );
    await page.goto(`/settings/menu/${code}`);
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('.ant-table')).toBeVisible();
    const create = page.getByRole('button', { name: '新增', exact: true });
    if (await create.count()) {
      await create.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: '取消', exact: true }).click();
    }
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.getByText('DEC-043', { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
