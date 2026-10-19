import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { setup, record, recordId, listRecord, fields } from './part-time-fixtures.js';
const department = record.fields.departmentId;
const manager = '60000000-0000-4000-8000-000000000002';
const second = '40000000-0000-4000-8000-000000000002';
const buttons = ['Employment.PartTime', 'Employment.PartTimeEdit', 'Employment.PartTimeBatchEnd'];
async function ready(page: Page, allowed = buttons) {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: [
          ...fields,
          'partTimeType',
          'sequenceId',
          'dottedManagerId',
          'employmentForm',
          'employmentType',
        ],
        editableFields: [
          ...fields.filter((key) => key !== 'serviceType'),
          'partTimeType',
          'sequenceId',
          'dottedManagerId',
          'employmentForm',
          'employmentType',
        ],
        buttons: allowed.map((buttonCode) => ({
          buttonCode,
          level: buttonCode === 'Employment.PartTimeBatchEnd' ? 'list' : 'detail',
        })),
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
async function choose(page: Page, label: string, text: string) {
  await page.getByRole('dialog').getByRole('combobox', { name: label, exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .getByText(text, { exact: true })
    .click();
}
async function date(page: Page, label: string, value: string) {
  const input = page
    .getByRole('dialog')
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText(label, { exact: true }) })
    .locator('input');
  if (!value) {
    await input.hover();
    await input.locator('xpath=ancestor::div[contains(@class,"ant-picker")][1]').locator('.ant-picker-clear').click();
  } else {
    await input.fill(value);
    await input.press('Enter');
    await input.press('Tab');
  }
  await page.getByRole('dialog').locator('.ant-modal-title, .ant-drawer-title').click();
}
const save = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /^保\s*存$/ });

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
  await expect(
    page
      .getByRole('dialog')
      .getByRole('combobox', { name: '直线经理', exact: true })
      .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]'),
  ).toContainText('合成经理');
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
  await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
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

test('AC-FE-R2d2a-05 编辑结果未知关闭换视图重开仍锁定，回查不换命令', async ({ page }) => {
  await ready(page);
  let writes = 0;
  await page.route(`**/employment/part-times/${recordId}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...record, revision: writes ? 2 : 1 } });
    writes++;
    return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } });
  });
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await choose(page, '部门', '合成部门乙');
  await save(page).click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: '全部兼职记录', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(save(page)).toBeDisabled();
  await page.getByRole('button', { name: '回查原单', exact: true }).click();
  await expect(page.getByText('原单当前值（仅供核对，不能据此确认本次命令结果）')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(writes).toBe(1);
});

test('AC-FE-R2d2a-06 编辑冲突重读：保留部门草稿、更新未改结束日和实际版本', async ({ page }) => {
  await ready(page);
  let attempt = 0;
  let body: unknown;
  await page.route(`**/employment/part-times/${recordId}`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          ...record,
          revision: attempt ? 4 : 1,
          endDate: attempt ? '2026-12-31' : record.endDate,
        },
      });
    if (++attempt === 1) return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    body = route.request().postDataJSON();
    expect(route.request().headers()['if-match']).toBe('4');
    return route.fulfill({ json: { ...record, revision: 5, warnings: [] } });
  });
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await choose(page, '部门', '合成部门乙');
  await save(page).click();
  await page.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(page.getByRole('dialog').getByPlaceholder('选择日期')).toHaveValue('2026-12-31');
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(body).toEqual({ fields: { departmentId: manager } });
});

test('AC-FE-R2d2a-07 批量未知锁住单条编辑与重组批次', async ({ page }) => {
  await ready(page);
  let writes = 0;
  await page.route('**/employment/part-times/batch-end', (route) => {
    writes++;
    return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } });
  });
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await page.getByRole('button', { name: '批量结束兼职', exact: true }).click();
  await date(page, '结束日期', '2026-10-20');
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^取\s*消$/ })
    .click();
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(page.getByText('本对象有未确认的其他操作，确认结果前不能发起新操作。')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(writes).toBe(1);
});
