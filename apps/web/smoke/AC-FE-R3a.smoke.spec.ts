import { test, expect, user } from './fixtures.js';

const rows = [
  {
    id: '30000000-0000-4000-8000-000000000011',
    revision: 1,
    name: '合成配置',
    code: 'DEMO',
    type: 'ability',
    enabled: true,
    displayOrder: 1,
    categoryId: '30000000-0000-4000-8000-000000000011',
    levelIds: [],
    details: [],
    dimensions: [],
  },
];

test.beforeEach(async ({ page }) => {
  await page.route('**/api/tenant/permission/me/objects/**', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { view: true, create: true, update: true },
        viewableFields: [
          'name',
          'code',
          'type',
          'enabled',
          'displayOrder',
          'classId',
          'categoryId',
          'levelIds',
          'details',
          'dimensions',
          'libraryId',
          'definition',
        ],
        editableFields: [
          'name',
          'code',
          'type',
          'enabled',
          'displayOrder',
          'classId',
          'categoryId',
          'levelIds',
          'libraryId',
          'definition',
        ],
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
        ],
      },
    }),
  );
  for (const module of ['talent', 'qualification']) {
    await page.route(`**/api/tenant/${module}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('development-channel'))
        return route.fulfill({ json: { current: null, vertical: [], horizontal: [] } });
      if (path.includes('/forms/'))
        return route.fulfill({
          json: {
            editableFields: [
              'name',
              'code',
              'type',
              'enabled',
              'displayOrder',
              'libraryId',
              'categoryId',
              'definition',
            ],
            requiredFields: ['name'],
          },
        });
      return route.fulfill({ json: path.endsWith(rows[0]!.id) ? rows[0] : { items: rows, hasDataPermission: true } });
    });
  }
});

for (const [path, title] of [
  ['/talent?view=libraries', '指标库'],
  ['/talent?view=dimensions', '指标'],
  ['/talent?view=criteria', '人才标准'],
  ['/qualification?view=categories', '任职类别'],
  ['/qualification?view=levels', '任职级别'],
  ['/qualification?view=standards', '任职资格标准'],
]) {
  test(`AC-FE-R3a ${title} 身份切换、列表、详情、表单抽屉`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/staff');
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.goto(path!);
    await expect(page.getByRole('heading', { name: title!, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '合成配置', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '关闭详情' }).click();
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('名称', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.locator('.catalog-page .decision-note')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('AC-FE-R3a 员工发展通道空态，无资格不伪造路径', async ({ page }) => {
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/qualification?view=channels');
  await expect(page.getByRole('heading', { name: '员工发展通道', exact: true })).toBeVisible();
  await expect(page.getByText('选择员工后查看当前任职资格与发展路径')).toBeVisible();
});
