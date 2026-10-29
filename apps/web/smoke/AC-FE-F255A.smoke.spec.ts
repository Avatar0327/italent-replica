import { test, expect } from './fixtures.js';
import { setup, listRecord, fields } from './part-time-fixtures.js';

const institutionId = '60000000-0000-4000-8000-000000000009';

test('AC-FE-F255A 六视图显示机构存值并可排序', async ({ page }) => {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        viewableFields: [...fields, 'institutionId', 'requestSource'],
        dataOperations: { read: true },
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.route('**/employment/part-times?*', (route) =>
    route.fulfill({
      json: {
        items: [{ ...listRecord, institutionId }],
        total: 1,
        page: 1,
        pageSize: 30,
      },
    }),
  );
  await page.route(`**/org/organizations/${institutionId}?*`, (route) =>
    route.fulfill({ json: { id: institutionId, name: '合成存值机构' } }),
  );
  await page.reload();
  for (const view of ['兼职中', '即将到期', '未开始', '已结束', '全部兼职记录', '审批中的兼职']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('cell', { name: '合成存值机构', exact: true })).toBeVisible();
    const read = page.waitForRequest((r) => new URL(r.url()).searchParams.get('sortBy') === 'institutionId');
    await page.getByRole('columnheader', { name: '兼职机构', exact: true }).click();
    await read;
  }
});

test('AC-FE-F255A 来源只在审批高级筛选；快捷筛选与日期依逐视图区分', async ({ page }) => {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        viewableFields: [...fields, 'employeeId', 'institutionId', 'requestSource'],
        dataOperations: { read: true },
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.reload();
  for (const view of ['兼职中', '未开始', '已结束']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('button', { name: '高级筛选', exact: true })).toHaveCount(0);
    const quick = page.getByRole('region', { name: '快捷筛选' });
    await expect(quick.getByRole('combobox', { name: '人员', exact: true })).toBeVisible();
    await expect(
      quick.getByLabel(`${view === '已结束' ? '兼职结束日期' : '兼职开始日期'}起`, { exact: true }),
    ).toBeVisible();
    await expect(quick.getByLabel('申请来源', { exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: '即将到期', exact: true }).click();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  let drawer = page.getByRole('dialog', { name: '高级筛选' });
  await expect(drawer.getByLabel('兼职开始日期起', { exact: true })).toHaveCount(0);
  await expect(drawer.getByLabel('兼职直线经理', { exact: true })).toHaveCount(0);
  await expect(drawer.getByLabel('申请来源', { exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: /^取\s*消$/ }).click();
  await page.getByRole('button', { name: '审批中的兼职', exact: true }).click();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  drawer = page.getByRole('dialog', { name: '高级筛选' });
  await drawer.getByRole('combobox', { name: '申请来源', exact: true }).click();
  for (const label of ['全选', '兼职申请', '调动申请', '组织调整'])
    await expect(page.getByTitle(label, { exact: true })).toBeVisible();
  await page.getByTitle('调动申请', { exact: true }).click();
  await drawer.getByRole('combobox', { name: '申请来源', exact: true }).press('Escape');
  const read = page.waitForRequest((r) => new URL(r.url()).searchParams.get('requestSources') === 'transfer');
  await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
  await read;
  await expect(page.getByRole('region', { name: '快捷筛选' }).getByText('申请来源：调动申请')).toBeVisible();
});
