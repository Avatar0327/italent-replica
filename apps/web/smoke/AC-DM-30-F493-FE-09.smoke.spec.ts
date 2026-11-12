import { test, expect, switchDemoUser } from './fixtures.js';

test('FE-09 全部人员选择离职，null 工号显示 --，字符串 0 原样，其他空值保持 —', async ({ page }) => {
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true },
        viewableFields: ['name', 'code', 'email', 'employeeStatus'],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  const statuses: string[] = [];
  await page.route('**/employment/all-people?*', (route) => {
    const status = new URL(route.request().url()).searchParams.get('employeeStatus') ?? '';
    statuses.push(status);
    const items =
      status === '8'
        ? [
            { employeeId: 'synthetic-null', employeeName: '合成离职空工号', code: null, email: null },
            { employeeId: 'synthetic-zero', employeeName: '合成离职零工号', code: '0', email: null },
          ]
        : [];
    return route.fulfill({
      json: {
        columns: [
          { key: 'employeeName', label: '姓名' },
          { key: 'code', label: '工号' },
          { key: 'email', label: '邮箱' },
        ],
        items,
        total: items.length,
        page: 1,
        pageSize: 15,
        hasDataPermission: true,
      },
    });
  });
  await switchDemoUser(page);
  await page.goto('/all-people');
  await page.getByRole('combobox', { name: '人员状态', exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').getByText('离职', { exact: true }).click();
  await page.keyboard.press('Escape');
  const select = page
    .getByRole('combobox', { name: '人员状态', exact: true })
    .locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," ant-select ")][1]');
  for (const title of ['试用', '正式'])
    await select.locator(`.ant-select-selection-item[title="${title}"] .ant-select-selection-item-remove`).click();
  await expect.poll(() => statuses.at(-1)).toBe('8');
  const blank = page.getByRole('row', { name: /合成离职空工号/ });
  const zero = page.getByRole('row', { name: /合成离职零工号/ });
  await expect(blank.locator('td').nth(2)).toHaveText('--');
  await expect(zero.locator('td').nth(2)).toHaveText('0');
  await expect(blank.locator('td').nth(3)).toHaveText('—');
});
