import { test, expect, employee } from './fixtures.js';
import { setup, listRecord, recordId, requestId } from './part-time-fixtures.js';
const base = [
  '姓名',
  '工号',
  '兼职类型',
  '兼职开始日期',
  '兼职机构',
  '兼职部门',
  '兼职直线经理',
  '兼职职务',
  '兼职结束日期',
];
const views = [
  ['ongoing', '兼职中', [...base, '任职状态', '审批状态', '职位', '职级']],
  ['expiring', '即将到期', [...base, '任职状态', '延长/结束申请审批状态', '申请类型']],
  ['not_started', '未开始', [...base, '任职状态', '审批状态']],
  ['ended', '已结束', [...base, '任职状态']],
  ['all', '全部兼职记录', [...base, '是否当前生效', '任职状态', '审批状态']],
  ['in_approval', '审批中的兼职', ['姓名', '工号', '申请类型', ...base.slice(2), '审批状态']],
] as const;

test('AC-FE-R2d1-01 默认、六视图列序、分页、申请类型和只读边界', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  const writes: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/tenant/employment/part-times') queries.push(new URL(r.url()).searchParams);
    if (r.url().includes('/api/tenant/employment/') && r.method() !== 'GET') writes.push(r.method());
  });
  await setup(page);
  await expect(page.getByRole('heading', { name: '兼职管理', exact: true })).toBeVisible();
  expect(queries[0]?.get('view')).toBe('ongoing');
  expect(queries[0]?.get('pageSize')).toBe('30');
  for (const [view, label, columns] of views) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => queries.at(-1)?.get('view')).toBe(view);
    await expect(page.locator('.part-time-table .ant-table-thead th')).toHaveText([...columns, '操作']);
    if (['ongoing', 'not_started', 'all'].includes(view))
      await expect(page.getByRole('cell', { name: '生效', exact: true })).toBeVisible();
    if (view === 'all') await expect(page.getByRole('cell', { name: '是', exact: true })).toBeVisible();
  }
  for (const label of ['新增', '延长', '结束'])
    await expect(page.getByRole('cell', { name: label, exact: true })).toBeVisible();
  await page.getByTitle('2', { exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('page')).toBe('2');
  expect(writes).toEqual([]);
});

test('AC-FE-R2d1-02 days 与日期范围校验', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '即将到期', exact: true }).click();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选' });
  await drawer.getByLabel('到期天数', { exact: true }).fill('7');
  await drawer.getByLabel('兼职开始日期起', { exact: true }).fill('2026-10-20');
  await drawer.getByLabel('兼职开始日期止', { exact: true }).fill('2026-10-01');
  await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(drawer.getByText('日期区间的起始日期不能晚于结束日期')).toBeVisible();
  await drawer.getByLabel('兼职开始日期止', { exact: true }).fill('2026-10-30');
  const read = page.waitForRequest((r) => new URL(r.url()).searchParams.get('days') === '7');
  await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
  const query = new URL((await read).url()).searchParams;
  expect(query.get('startFrom')).toBe('2026-10-20');
  expect(query.get('startTo')).toBe('2026-10-30');
});

test('AC-FE-R2d1-03 缺键保留行，全部按服务端视图成员判否', async ({ page }) => {
  await setup(page);
  await page.route('**/employment/part-times?*', (route) =>
    route.fulfill({
      json: {
        items: [{ id: recordId, partTimeView: ['ended', 'all'], employee: { code: listRecord.employee.code } }],
        total: 1,
        page: 1,
        pageSize: 30,
        hasDataPermission: true,
      },
    }),
  );
  await page.getByRole('button', { name: '全部兼职记录', exact: true }).click();
  await expect(page.getByRole('cell', { name: listRecord.employee.code, exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '否', exact: true })).toBeVisible();
  await expect(page.locator('.part-time-table tbody tr.ant-table-row td').first()).toHaveText('--');
});

test('AC-FE-R2d1-04 详情期限链、历史与申请详情', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(page.getByRole('heading', { name: '兼职详情', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '期限链', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '申请历史', exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-31', { exact: true }).first()).toBeVisible();
  const read = page.waitForRequest((r) => r.url().endsWith(`/part-time-requests/${requestId}`));
  await page.getByRole('button', { name: '查看申请', exact: true }).first().click();
  await read;
  await expect(page.getByRole('heading', { name: '兼职申请详情', exact: true })).toBeVisible();
  await expect(page.getByText('合成延期说明', { exact: true })).toBeVisible();
});

test('AC-FE-R2d1-05 档案兼职记录只读该员工接口', async ({ page }) => {
  await setup(page, '/staff');
  await page.getByRole('button', { name: '合成兼职员工', exact: true }).click();
  const read = page.waitForRequest((r) => r.url().includes(`/employees/${employee}/part-times?`));
  await page.getByRole('tab', { name: '兼职记录', exact: true }).click();
  await read;
  await expect(page.getByRole('tabpanel', { name: '兼职记录', exact: true })).toContainText('2026-09-01');
});
