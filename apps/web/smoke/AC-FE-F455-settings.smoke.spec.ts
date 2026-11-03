// F-455：真实浏览器验证失效日期清空、必填字段编辑权及设置页既有视图。
import type { Page } from '@playwright/test';
import { test, expect, snapshotFixture, user } from './fixtures.js';
import { actionButton } from './action-button.js';
import { employmentTypePermission, employmentTypeRow } from './employment-type-fixtures.js';

async function setup(page: Page, editableOrder = true) {
  const state = {
    row: employmentTypeRow({ expiryDate: '2030-12-31' }),
    reply: 'normal' as 'normal' | 'conflict' | 'unknown',
    writes: [] as { body: Record<string, unknown>; revision?: string }[],
  };
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'settings' ? { ...app, entryObjects: [employmentTypePermission.objectCode] } : app,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.EmploymentType', (route) =>
    route.fulfill({
      json: {
        ...employmentTypePermission,
        editableFields: employmentTypePermission.editableFields.filter(
          (field) => editableOrder || field !== 'displayOrder',
        ),
      },
    }),
  );
  await page.route('**/employment/employment-types?*', (route) =>
    route.fulfill({
      json: { items: new URL(route.request().url()).searchParams.get('view') === 'disabled' ? [] : [state.row] },
    }),
  );
  await page.route(`**/employment/employment-types/${state.row.id}`, (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    state.writes.push({ body, revision: request.headers()['if-match'] });
    if (state.reply === 'unknown') return route.abort();
    if (state.reply === 'conflict' && state.writes.length === 1) {
      state.row = { ...state.row, name: '合成类别最新名', expiryDate: '2040-12-31', revision: 4 };
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    }
    // 与后端日期契约一致，null 不能被成功桩吞掉。
    if (body.expiryDate === null)
      return route.fulfill({
        status: 400,
        json: { error: { code: 'VALIDATION_FAILED', message: '人员类别字段不合法' } },
      });
    state.row = { ...state.row, ...body, revision: state.row.revision + 1 };
    return route.fulfill({ json: state.row });
  });
  await page.goto('/employment-types');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('/staff');
  await page.goto('/employment-types');
  await expect(page.locator('tr[data-row-key]')).toHaveCount(1);
  return state;
}

test('AC-FE-F455-01 编辑清空失效日期：提交无限期日期、列表刷新后显示默认日期', async ({ page }) => {
  const state = await setup(page);
  await actionButton(page, state.row.name).click();
  await actionButton(page.locator('.detail-drawer'), '编辑').click();
  const form = page.getByRole('dialog', { name: '编辑人员类别', exact: true });
  const expiry = form
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText('失效日期', { exact: true }) });
  await expect(expiry.locator('input')).toHaveValue('2030-12-31');
  await expiry.hover();
  await expiry.locator('.ant-picker-clear').click();
  await actionButton(form, '保存').click();
  await expect(form).toHaveCount(0);
  expect(state.writes).toEqual([{ body: { expiryDate: '9999-12-31' }, revision: '1' }]);
  await expect(page.locator('tr[data-row-key]')).toContainText('9999-12-31');
});

test('AC-FE-F455-02 顺序号只读时不提供新建，仍可看详情和切换视图', async ({ page }) => {
  const state = await setup(page, false);
  await expect(actionButton(page, '新建')).toHaveCount(0);
  await actionButton(page, state.row.name).click();
  await expect(page.locator('.detail-drawer')).toContainText(state.row.name);
  await page.locator('.detail-drawer').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '停用人员类别', exact: true }).click();
  await expect(page.locator('tr[data-row-key]')).toHaveCount(0);
  await page.getByRole('tab', { name: '全部人员类别', exact: true }).click();
  await expect(page.locator('tr[data-row-key]')).toHaveCount(1);
  expect(state.writes).toEqual([]);
});

test('AC-FE-F455-03 日期清空遇409：重读回填未改名称，改回原日期后用最新版本重提', async ({ page }) => {
  const state = await setup(page);
  state.reply = 'conflict';
  await actionButton(page, state.row.name).click();
  await actionButton(page.locator('.detail-drawer'), '编辑').click();
  const form = page.getByRole('dialog', { name: '编辑人员类别', exact: true });
  const expiry = form
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText('失效日期', { exact: true }) });
  await expiry.hover();
  await expiry.locator('.ant-picker-clear').click();
  await actionButton(form, '保存').click();
  await actionButton(form, '重读最新版本').click();
  await actionButton(form, '已核对差异，继续编辑').click();
  await expect(form.getByLabel('名称', { exact: true })).toHaveValue('合成类别最新名');
  await expect(expiry.locator('input')).toHaveValue('');
  await expiry.locator('input').fill('2030-12-31');
  await expiry.locator('input').press('Enter');
  await expiry.locator('input').press('Tab');
  await actionButton(form, '保存').click();
  await expect(form).toHaveCount(0);
  expect(state.writes).toEqual([
    { body: { expiryDate: '9999-12-31' }, revision: '1' },
    { body: { expiryDate: '2030-12-31' }, revision: '4' },
  ]);
});

test('AC-FE-F455-04 日期清空回执丢失：关闭、换视图、重开及回查仍锁定且只写一次', async ({ page }) => {
  const state = await setup(page);
  state.reply = 'unknown';
  await actionButton(page, state.row.name).click();
  await actionButton(page.locator('.detail-drawer'), '编辑').click();
  const form = page.getByRole('dialog', { name: '编辑人员类别', exact: true });
  const expiry = form
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText('失效日期', { exact: true }) });
  await expiry.hover();
  await expiry.locator('.ant-picker-clear').click();
  await actionButton(form, '保存').click();
  await expect(form).toContainText('结果待确认');
  await actionButton(form, '回查原单').click();
  await expect(form).toContainText('原单当前值');
  await expect(actionButton(form, '保存')).toBeDisabled();
  await actionButton(form, '取消').click();
  await page.locator('.detail-drawer').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '全部人员类别', exact: true }).click();
  await actionButton(page, state.row.name).click();
  // 详情的编辑入口也不能绕过同一对象的未确认命令。
  await expect(actionButton(page.locator('.detail-drawer'), '编辑')).toBeDisabled();
  expect(state.writes).toEqual([{ body: { expiryDate: '9999-12-31' }, revision: '1' }]);
});
