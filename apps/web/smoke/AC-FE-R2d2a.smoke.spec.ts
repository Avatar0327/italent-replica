import { test, expect, employee } from './fixtures.js';
import { setup, record, recordId, listRecord, fields } from './part-time-fixtures.js';
const department = record.fields.departmentId;
const manager = '60000000-0000-4000-8000-000000000002';
const second = '40000000-0000-4000-8000-000000000002';
const buttons = ['Employment.PartTime', 'Employment.PartTimeEdit', 'Employment.PartTimeBatchEnd'];
async function ready(page: import('@playwright/test').Page, allowed = buttons) {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: [...fields, 'sequenceId', 'dottedManagerId', 'employmentForm', 'employmentType'],
        editableFields: [...fields, 'sequenceId', 'dottedManagerId', 'employmentForm', 'employmentType'],
        buttons: allowed.map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
    }),
  );
  await page.route('**/org/organizations?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: department, name: '合成部门甲' },
          { id: manager, name: '合成部门乙' },
        ],
      },
    }),
  );
  await page.route('**/personnel/employees?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: employee, name: '合成员工' },
          { id: manager, name: '合成经理' },
        ],
      },
    }),
  );
  await page.route('**/employment/employees/*/records?*', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/employment/part-times?*', (route) =>
    route.fulfill({
      json: {
        items: [listRecord, { ...listRecord, id: second }],
        total: 2,
        page: 1,
        pageSize: 30,
      },
    }),
  );
  await page.route(`**/employment/part-times/${second}`, (route) => route.fulfill({ json: { ...record, id: second } }));
  await page.reload();
  await expect(page.getByRole('button', { name: '查看详情', exact: true })).toHaveCount(2);
}
async function choose(page: import('@playwright/test').Page, label: string, text: string) {
  await page.getByRole('dialog').getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: text, exact: true }).click();
}
async function date(page: import('@playwright/test').Page, label: string, value: string) {
  const input = page.getByRole('dialog').getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
}
const save = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog').getByRole('button', { name: /^保\s*存$/ });

test('AC-FE-R2d2a-01 新增必填拦截、预览带出经理、保存真实载荷', async ({ page }) => {
  await ready(page);
  let saved: unknown;
  await page.route('**/employment/employees/*/part-times/preview', (route) =>
    route.fulfill({
      json: {
        partTimeType: 'part_time',
        effectiveDate: '2026-10-01',
        endDate: null,
        fields: { departmentId: department, directManagerId: manager, sequenceId: null },
        warnings: [],
      },
    }),
  );
  await page.route('**/employment/employees/*/part-times', (route) => {
    saved = route.request().postDataJSON();
    expect(route.request().headers()['if-match']).toBeUndefined();
    return route.fulfill({ status: 201, json: { ...record, warnings: [] } });
  });
  await page.getByRole('button', { name: '新增兼职', exact: true }).click();
  await save(page).click();
  await expect(page.getByText('请选择员工', { exact: true })).toBeVisible();
  expect(saved).toBeUndefined();
  await choose(page, '员工', '合成员工');
  await choose(page, '任职类型', '兼职');
  await date(page, '开始日期', '2026-10-01');
  await choose(page, '部门', '合成部门甲');
  await expect(page.getByRole('dialog').getByLabel('直线经理', { exact: true }).locator('..')).toContainText(
    '合成经理',
  );
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(saved).toMatchObject({
    partTimeType: 'part_time',
    startDate: '2026-10-01',
    fields: {
      departmentId: department,
      directManagerId: manager,
    },
  });
  expect(JSON.stringify(saved)).not.toMatch(/isDepartmentHead|addedSubordinateIds/);
});

test('AC-FE-R2d2a-02 编辑改部门、只读开始日、清空结束日拦截', async ({ page }) => {
  await ready(page);
  const writes: unknown[] = [];
  await page.route(`**/employment/part-times/${recordId}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: record });
    writes.push(route.request().postDataJSON());
    expect(route.request().headers()['if-match']).toBe('1');
    return route.fulfill({ json: { ...record, revision: 2, fields: { departmentId: manager }, warnings: [] } });
  });
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByLabel('开始日期', { exact: true })).toHaveCount(0);
  await date(page, '结束日期', '');
  await save(page).click();
  await expect(page.getByText('已有结束日期不可清空', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await date(page, '结束日期', '2026-11-30');
  await choose(page, '部门', '合成部门乙');
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([{ fields: { departmentId: manager } }]);
});

test('AC-FE-R2d2a-03 批量结束冲突逐条提示、重读重提使用新版本', async ({ page }) => {
  await ready(page);
  let attempt = 0;
  let body: { items: { recordId: string; revision: number }[]; endDate: string } | undefined;
  await page.route('**/employment/part-times/batch-end', (route) => {
    body = route.request().postDataJSON();
    expect(route.request().headers()['if-match']).toBeUndefined();
    if (++attempt === 1)
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'REVISION_CONFLICT',
            message: '版本冲突',
            details: {
              items: [{ recordId, expected: 1, actual: 2 }],
              hiddenCount: 1,
            },
          },
        },
      });
    return route.fulfill({
      json: {
        total: 2,
        succeeded: 2,
        failed: 0,
        batchId: 'batch-a',
        items: [recordId, second].map((id) => ({ ...record, id, revision: 3, endDate: body!.endDate })),
      },
    });
  });
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await page.getByRole('button', { name: '批量结束兼职', exact: true }).click();
  await date(page, '结束日期', '2026-10-20');
  await save(page).click();
  await expect(page.getByText(`${recordId}：版本 1 → 2`, { exact: true })).toBeVisible();
  await expect(page.getByText('另有 1 条记录不可见', { exact: true })).toBeVisible();
  for (const id of [recordId, second])
    await page.route(`**/employment/part-times/${id}`, (route) =>
      route.fulfill({ json: { ...record, id, revision: 2 } }),
    );
  await page.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await page.getByRole('button', { name: '已核对差异，按最新版本重提', exact: true }).click();
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(body).toEqual({
    items: [recordId, second].map((recordId) => ({ recordId, revision: 2 })),
    endDate: '2026-10-20',
  });
});

test('AC-FE-R2d2a-04 无按钮权隐藏三个入口', async ({ page }) => {
  await ready(page, []);
  for (const name of ['新增兼职', '批量结束兼职', '编辑'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
});
