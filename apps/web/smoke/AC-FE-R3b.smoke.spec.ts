import { test, expect, user } from './fixtures.js';

for (const entry of [
  { path: '/evaluation', title: '活动设置', create: '新建评定活动' },
  { path: '/survey360', title: '评估活动', create: '新增活动' },
]) {
  test(`AC-FE-R3b-03 ${entry.path} 切换身份后打开列表与表单`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/permission/me/objects/*', (route) =>
      route.fulfill({
        json: {
          objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
          dataOperations: { read: true, create: true, update: true },
          viewableFields: [
            'name',
            'status',
            'year',
            'typeId',
            'cycleId',
            'ownerOrgId',
            'managerEmployeeId',
            'startDate',
            'endDate',
            'effectiveDate',
            'orgRange',
            'categoryIds',
            'levelIds',
            'applicants',
            'maxLevelJump',
            'conditions',
            'chains',
            'scene',
            'form',
            'welcome',
            'showAppraiserName',
            'roleDisplay',
          ],
          editableFields: [
            'name',
            'year',
            'typeId',
            'cycleId',
            'ownerOrgId',
            'managerEmployeeId',
            'startDate',
            'endDate',
            'effectiveDate',
            'orgRange',
            'categoryIds',
            'levelIds',
            'applicants',
            'maxLevelJump',
            'conditions',
            'chains',
            'scene',
            'form',
            'welcome',
            'showAppraiserName',
            'roleDisplay',
          ],
          buttons: [{ buttonCode: 'create', level: 'list' }],
        },
      }),
    );
    await page.goto(entry.path);
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page.getByRole('heading', { name: entry.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: entry.create, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('名称', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
