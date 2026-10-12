import { test, expect, user } from './fixtures.js';

const id = '40000000-0000-4000-8000-000000000001';
const fields = [
  'name',
  'code',
  'enabled',
  'parents',
  'remarks',
  'establishedOn',
  'effectiveDate',
  'startDate',
  'stopDate',
  'layerLevel',
  'grade',
  'level',
  'orgId',
  'postId',
  'periodType',
  'maintenanceMode',
];
test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
        ],
      },
    }),
  );
  await page.route('**/api/tenant/org/organizations**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id)
        ? { id, revision: 1, name: '合成组织', code: 'ORG-001', enabled: true, establishedOn: '2026-01-01' }
        : { items: [{ id, revision: 1, name: '合成组织', code: 'ORG-001', enabled: true }], hasDataPermission: true },
    }),
  );
  await page.route('**/api/tenant/job/**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id)
        ? { id, revision: 1, name: '合成条目', code: 'JOB-001', enabled: true }
        : { items: [{ id, revision: 1, name: '合成条目', code: 'JOB-001', enabled: true }], today: '2026-10-12' },
    }),
  );
  await page.route('**/api/tenant/establishment/schemes**', (route) =>
    route.fulfill({
      json: {
        items: [{ id, revision: 1, name: '合成年度方案', periodType: 'annual', maintenanceMode: 'local' }],
      },
    }),
  );
});

for (const kind of [
  'layers',
  'grades',
  'level-types',
  'levels',
  'sequences',
  'professional-lines',
  'posts',
  'positions',
]) {
  test(`AC-FE-R1a-03 ${kind} 身份切换、列表、详情、新建与编辑抽屉`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`/job?kind=${kind}`);
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page.getByRole('button', { name: '合成条目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '合成条目', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '编辑', exact: true }).last().click();
    await expect(page.getByRole('dialog').getByLabel('名称', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('名称', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
for (const tab of ['list', 'tree', 'changes', 'establishment']) {
  test(`AC-FE-R1a-04 组织 ${tab} 页面与抽屉`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`/org?tab=${tab}`);
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (tab === 'establishment') await expect(page.getByText('合成年度方案')).toBeVisible();
    else {
      await page.getByText('合成组织', { exact: true }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page
        .getByRole('button', { name: tab === 'changes' ? '变更' : '编辑', exact: true })
        .last()
        .click();
      await expect(page.getByRole('dialog').getByText('保存', { exact: true })).toBeVisible();
    }
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.locator('.decision-note')).toHaveCount(2);
    expect(errors).toEqual([]);
  });
}
