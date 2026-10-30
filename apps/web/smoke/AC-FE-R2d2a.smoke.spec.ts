import { actionButton } from './action-button.js';
import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { setup, record, recordId, listRecord, fields } from './part-time-fixtures.js';
const department = record.fields.departmentId;
const manager = '60000000-0000-4000-8000-000000000002';
const second = '40000000-0000-4000-8000-000000000002';
const buttons = ['Employment.PartTime', 'Employment.PartTimeEdit', 'Employment.PartTimeBatchEnd'];
async function ready(page: Page, allowed = buttons, custom: string[] = []) {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: [
          ...custom,
          ...fields,
          'partTimeType',
          'sequenceId',
          'dottedManagerId',
          'employmentForm',
          'employmentType',
        ],
        editableFields: [
          ...custom,
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
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: label, exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
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
const save = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /保\s*存$/ });

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
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '人员类别', exact: true })).toHaveCount(0);
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
  for (const id of [recordId, second])
    await page.route(`**/employment/part-times/${id}`, (route) =>
      route.fulfill({ json: { ...record, id, revision: 2 } }),
    );
  await actionButton(page, '重读最新版本').click();
  const confirm = page.getByRole('button', { name: '已核对差异，继续编辑', exact: true });
  await confirm.click();
  await expect(confirm).toHaveCount(0);
  await expect(save(page)).toBeEnabled();
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
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '全部兼职记录', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(save(page)).toBeDisabled();
  await actionButton(page, '回查原单').click();
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
  await actionButton(page, '重读最新版本').click();
  const confirm = page.getByRole('button', { name: '已核对差异，继续编辑', exact: true });
  await confirm.click();
  await expect(confirm).toHaveCount(0);
  await expect(save(page)).toBeEnabled();
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
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.ant-table-tbody input[type=checkbox]').nth(1).check();
  await page.getByRole('button', { name: '批量结束兼职', exact: true }).click();
  await expect(save(page)).toBeDisabled();
  await actionButton(page, '回查原单').click();
  await expect(page.getByText('原单当前值（仅供核对，不能据此确认本次命令结果）')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(writes).toBe(1);
});

test('AC-FE-R2d2a-08 有按钮但无对象写权，记录仍展示、提交入口禁用', async ({ page }) => {
  await ready(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: false, update: false },
        viewableFields: fields,
        editableFields: fields,
        buttons: buttons.map((buttonCode) => ({
          buttonCode,
          level: buttonCode.endsWith('BatchEnd') ? 'list' : 'detail',
        })),
      },
    }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '编辑', exact: true }).first()).toBeDisabled();
  await expect(page.getByRole('button', { name: '新增兼职', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await expect(page.getByRole('button', { name: '批量结束兼职', exact: true })).toBeDisabled();
  await expect(page.getByText('合成兼职员工', { exact: true }).first()).toBeVisible();
});

test('AC-FE-R2d2a-09 租户自定义字段按元数据与字段权显示、编辑保存', async ({ page }) => {
  const id = '70000000-0000-4000-8000-000000000001';
  await ready(page, buttons, [`custom:${id}`]);
  await page.route('**/employment/custom-fields?*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id,
            code: 'ext_synthetic',
            name: '合成兼职说明',
            objectType: 'employment',
            valueType: 'text',
            revision: 1,
            inherit: true,
          },
        ],
        page: 1,
        pageSize: 200,
        hasDataPermission: true,
      },
    }),
  );
  let body: unknown;
  await page.route(`**/employment/part-times/${recordId}`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { ...record, customFields: { [id]: '旧说明' } } });
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ...record, revision: 2, customFields: { [id]: '新说明' }, warnings: [] } });
  });
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  const field = page.getByRole('textbox', { name: '合成兼职说明', exact: true });
  await expect(field).toHaveValue('旧说明');
  await field.fill('新说明');
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(body).toEqual({ customFields: { [id]: '新说明' } });
});

async function fillNew(page: Page) {
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
  await page.getByRole('button', { name: '新增兼职', exact: true }).click();
  await choose(page, '员工', '合成员工');
  await choose(page, '任职类型', '兼职');
  await date(page, '开始日期', '2026-10-01');
  await choose(page, '部门', '合成部门甲');
  await expect(save(page)).toBeEnabled();
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const stale of ['success', 'error'] as const) {
  test(`AC-FE-R2d2a-10 旧列表 ${stale} 响应不得覆盖写后新列表`, async ({ page }) => {
    await ready(page);
    const started = barrier();
    const release = barrier();
    let reads = 0;
    let written = false;
    await page.route('**/employment/part-times?*', async (route) => {
      if (!written) {
        started.resolve();
        await release.promise;
        await route.fulfill(
          stale === 'success'
            ? { json: { items: [], total: 0, page: 1, pageSize: 30 } }
            : { status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } },
        );
      } else {
        reads++;
        await route.fulfill({ json: { items: [listRecord], total: 1, page: 1, pageSize: 30 } });
      }
    });
    await page.route('**/employment/employees/*/part-times', (route) => {
      written = true;
      return route.fulfill({ status: 201, json: { ...record, warnings: [] } });
    });
    await page.reload();
    await started.promise;
    await fillNew(page);
    await save(page).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const rows = page.getByRole('button', { name: '查看详情', exact: true });
    await expect(rows).toHaveCount(1);
    const completed = page.waitForResponse((response) => response.url().includes('/employment/part-times?'));
    release.resolve();
    await (await completed).finished();
    // 等待已释放响应的 React 更新跨过绘制帧，不以 sleep 猜测请求先后。
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(rows).toHaveCount(1);
    await expect(page.getByText('合成兼职员工', { exact: true })).toBeVisible();
    expect(reads).toBe(1);
  });
}

for (const action of ['create', 'edit', 'batch'] as const) {
  test(`AC-FE-R2d2a-11 ${action} 写成功后读取失败，关闭换视图重开仍锁定`, async ({ page }) => {
    await ready(page);
    const returnedId = action === 'create' ? '40000000-0000-4000-8000-000000000003' : recordId;
    await page.route(`**/employment/part-times/${returnedId}`, (route) =>
      route.fulfill({ json: { ...record, id: returnedId } }),
    );
    let writes = 0;
    let failedRead = false;
    await page.route('**/employment/part-times?*', (route) => {
      if (writes && !failedRead) {
        failedRead = true;
        return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } });
      }
      return route.fulfill({
        json: {
          items: [
            { ...listRecord, id: writes ? returnedId : recordId },
            { ...listRecord, id: second },
          ],
          total: 2,
          page: 1,
          pageSize: 30,
        },
      });
    });
    const path =
      action === 'create'
        ? '**/employment/employees/*/part-times'
        : action === 'edit'
          ? `**/employment/part-times/${recordId}`
          : '**/employment/part-times/batch-end';
    await page.route(path, (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: record });
      writes++;
      const json =
        action === 'batch'
          ? {
              total: 2,
              succeeded: 2,
              failed: 0,
              batchId: 'batch-read-failure',
              items: [recordId, second].map((id) => ({ ...record, id, revision: 2 })),
            }
          : { ...record, id: returnedId, revision: action === 'create' ? 1 : 2, warnings: [] };
      return route.fulfill({ status: action === 'create' ? 201 : 200, json });
    });
    if (action === 'create') await fillNew(page);
    else if (action === 'edit') {
      await page.getByRole('button', { name: '编辑', exact: true }).first().click();
      await choose(page, '部门', '合成部门乙');
    } else {
      await page.getByRole('checkbox', { name: 'Select all' }).check();
      await page.getByRole('button', { name: '批量结束兼职', exact: true }).click();
      await date(page, '结束日期', '2026-10-20');
    }
    await save(page).click();
    await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
    expect(failedRead).toBe(true);
    await expect(save(page)).toBeDisabled();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^取\s*消$/ })
      .click();
    await page.getByRole('button', { name: '全部兼职记录', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    // 新增回执的新 ID / 批量中的单条也必须沿用未确认命令。
    await expect(save(page)).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    if (action === 'create') {
      await page.getByRole('button', { name: '新增兼职', exact: true }).click();
      await choose(page, '员工', '合成员工');
    } else if (action === 'batch') {
      await page.getByRole('checkbox', { name: 'Select all' }).check();
      await page.getByRole('button', { name: '批量结束兼职', exact: true }).click();
    } else await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    await expect(save(page)).toBeDisabled();
    expect(writes).toBe(1);
  });
}
