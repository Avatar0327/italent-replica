import { test, expect, employee } from './fixtures.js';
import { setup, listRecord, fields, recordId } from './part-time-fixtures.js';

test('AC-FE-F255 列排序发服务端、翻页重置、切视图恢复默认，审批工号不可排序', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/tenant/employment/part-times')
      queries.push(new URL(request.url()).searchParams);
  });
  await setup(page);
  await page.getByTitle('2', { exact: true }).click();
  await page.getByRole('columnheader', { name: '工号', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('sortBy')).toBe('code');
  expect(queries.at(-1)?.get('direction')).toBe('asc');
  expect(queries.at(-1)?.get('page')).toBe('1');
  await page.getByRole('columnheader', { name: '工号', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('direction')).toBe('desc');
  await page.getByRole('button', { name: '即将到期', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: '兼职开始日期', exact: true })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  expect(queries.at(-1)?.has('sortBy')).toBe(false);
  await page.getByRole('button', { name: '审批中的兼职', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: '工号', exact: true })).not.toHaveClass(
    /ant-table-column-has-sorters/,
  );
  await expect(page.getByRole('columnheader', { name: '兼职职务', exact: true })).toHaveClass(
    /ant-table-column-has-sorters/,
  );
});

test('AC-FE-F256 人员/兼职类型多选、职务与任职状态/当前生效筛选真实传参', async ({ page }) => {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        viewableFields: [...fields, 'employeeId'],
        dataOperations: { read: true },
        editableFields: [],
        buttons: [],
      },
    }),
  );
  const second = '30000000-0000-4000-8000-000000000002';
  const post = '70000000-0000-4000-8000-000000000001';
  await page.route('**/personnel/employees?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: employee, name: '合成人员甲' },
          { id: second, name: '合成人员乙' },
        ],
      },
    }),
  );
  await page.route('**/job/posts?*', (route) => route.fulfill({ json: { items: [{ id: post, name: '合成职务' }] } }));
  await page.reload();
  await page.getByRole('button', { name: '全部兼职记录', exact: true }).click();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选' });
  await expect(drawer.getByLabel('姓名 / 工号', { exact: true })).toHaveCount(0);
  await drawer.getByRole('combobox', { name: '人员', exact: true }).click();
  await page.getByText('合成人员甲', { exact: true }).click();
  await page.getByText('合成人员乙', { exact: true }).click();
  await drawer.getByRole('combobox', { name: '人员', exact: true }).press('Escape');
  await drawer.getByRole('combobox', { name: '兼职类型', exact: true }).click();
  await page.getByTitle('兼职', { exact: true }).click();
  await page.getByTitle('借调', { exact: true }).click();
  await drawer.getByRole('combobox', { name: '兼职类型', exact: true }).press('Escape');
  await drawer.getByRole('combobox', { name: '兼职职务', exact: true }).click();
  await page.getByTitle('合成职务', { exact: true }).click();
  await drawer.getByRole('combobox', { name: '是否当前生效', exact: true }).click();
  await page.getByTitle('否', { exact: true }).click();
  const read = page.waitForRequest((r) => new URL(r.url()).searchParams.has('employeeIds'));
  await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
  const query = new URL((await read).url()).searchParams;
  expect(query.getAll('employeeIds')).toEqual([employee, second]);
  expect(query.getAll('serviceTypes')).toEqual(['part_time', 'secondment']);
  expect(query.get('postId')).toBe(post);
  expect(query.get('current')).toBe('false');
});

test('AC-FE-F256 即将到期显示关联申请、筛选状态；审批视图可改状态与申请类型', async ({ page }) => {
  await setup(page);
  await page.route('**/employment/part-times?*', (route) =>
    route.fulfill({
      json: {
        items: [{ ...listRecord, pendingKind: 'end', pendingStatus: 'in_review' }],
        total: 1,
        page: 1,
        pageSize: 30,
        hasDataPermission: true,
      },
    }),
  );
  await page.getByRole('button', { name: '即将到期', exact: true }).click();
  await expect(page.getByRole('cell', { name: '结束', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '审批中', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  let drawer = page.getByRole('dialog', { name: '高级筛选' });
  await drawer.getByRole('combobox', { name: '延长/结束申请审批状态', exact: true }).click();
  await page.getByTitle('退回', { exact: true }).click();
  await drawer.getByRole('combobox', { name: '延长/结束申请审批状态', exact: true }).press('Escape');
  let read = page.waitForRequest((r) => new URL(r.url()).searchParams.getAll('pendingStatuses').includes('rejected'));
  await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
  await read;
  await page.getByRole('button', { name: '审批中的兼职', exact: true }).click();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  drawer = page.getByRole('dialog', { name: '高级筛选' });
  await expect(drawer.getByLabel('申请来源', { exact: true })).toHaveCount(0);
  await drawer.getByRole('combobox', { name: '申请类型', exact: true }).click();
  await page.getByTitle('延长', { exact: true }).click();
  await drawer.getByRole('combobox', { name: '申请类型', exact: true }).press('Escape');
  await drawer.getByRole('combobox', { name: '审批状态', exact: true }).click();
  await page.getByTitle('退回', { exact: true }).click();
  await drawer.getByRole('combobox', { name: '审批状态', exact: true }).press('Escape');
  read = page.waitForRequest((r) => new URL(r.url()).searchParams.getAll('statuses').includes('rejected'));
  await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
  const query = new URL((await read).url()).searchParams;
  expect(query.getAll('kinds')).toEqual(['extend']);
  expect(query.has('pendingStatuses')).toBe(false);
});

test('AC-FE-F255-F256 撤销字段权后排序和新增筛选不可操作，缺键不合成申请值', async ({ page }) => {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        dataOperations: { read: true },
        viewableFields: [],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.route('**/employment/part-times?*', (route) =>
    route.fulfill({
      json: {
        items: [{ id: recordId }],
        total: 1,
        page: 1,
        pageSize: 30,
        hasDataPermission: true,
      },
    }),
  );
  await page.reload();
  await expect(page.getByRole('columnheader', { name: '工号', exact: true })).not.toHaveClass(
    /ant-table-column-has-sorters/,
  );
  await page.getByRole('button', { name: '即将到期', exact: true }).click();
  await expect(page.getByRole('cell', { name: '审批中', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选' });
  for (const name of ['人员', '兼职类型', '兼职职务', '延长/结束申请审批状态'])
    await expect(drawer.getByLabel(name, { exact: true })).toHaveCount(0);
});
