import type { Page } from '@playwright/test';
import { test, expect, snapshotFixture, seedDemoUser } from './fixtures.js';
import { actionButton } from './action-button.js';

const objectCode = 'TenantBase.EmploymentCustomField';
const path = '/custom-field-definitions';
async function setup(page: Page) {
  const state = {
    row: {
      id: '30000000-0000-4000-8000-000000000474',
      revision: 1,
      name: '合成字段',
      objectType: 'employment',
      valueType: 'text',
      inherit: true,
    },
    reply: 'success' as 'success' | 'conflict' | 'unknown',
    writes: [] as { body: Record<string, unknown>; revision?: string; command?: string }[],
  };
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'settings' ? { ...app, entryObjects: [objectCode] } : app,
        ),
      },
    }),
  );
  await page.route(`**/permission/me/objects/${objectCode}`, (route) =>
    route.fulfill({
      json: {
        objectCode,
        dataOperations: { read: true, create: true, update: true },
        buttons: [],
        viewableFields: ['id', 'revision', 'name', 'objectType', 'valueType', 'inherit', 'options'],
        editableFields: ['name', 'objectType', 'valueType', 'inherit', 'options'],
      },
    }),
  );
  await page.route('**/employment/custom-fields**', (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({
        json: {
          items: new URL(request.url()).searchParams.get('objectType') === state.row.objectType ? [state.row] : [],
        },
      });
    const body = request.postDataJSON();
    state.writes.push({ body, revision: request.headers()['if-match'], command: request.headers()['idempotency-key'] });
    if (state.reply === 'unknown') return route.abort();
    if (state.reply === 'conflict' && state.writes.length === 1) {
      state.row = { ...state.row, revision: 2, inherit: false };
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    }
    state.row = { ...state.row, ...body, revision: request.method() === 'POST' ? 1 : state.row.revision + 1 };
    return route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: state.row });
  });
  await seedDemoUser(page);
  await page.goto(path);
  await expect(page.locator('tr[data-row-key]')).toHaveCount(1);
  return state;
}

test('AC-F474-SM01 六种类型选择、真实请求格式、列表刷新与组织人员创建', async ({ page }) => {
  const state = await setup(page);
  await expect(page.locator('th')).toHaveText(['名称', '类型', '对象', '是否继承', '操作']);
  await actionButton(page, '新建').click();
  const form = page.getByRole('dialog');
  await form.getByLabel('名称', { exact: true }).fill('合成整数');
  await form
    .locator('.ant-select')
    .filter({ has: page.locator('input[id$="valueType"]') })
    .locator('.ant-select-selector')
    .click();
  const choices = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content');
  await expect(choices).toHaveText(['文本', '整数', '小数', '布尔', '日期', '单选下拉']);
  await choices.filter({ hasText: /^整数$/ }).click();
  await actionButton(form, '保存').click();
  await expect(form).toHaveCount(0);
  expect(state.writes[0]?.body).toEqual({ name: '合成整数', objectType: 'employment', valueType: 'integer' });
  await expect(page.locator('tr[data-row-key]')).toContainText('合成整数');
  for (const name of ['组织', '人员']) {
    await page.locator('.ant-select[aria-label="对象"] .ant-select-selector').click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
      .filter({ hasText: new RegExp(`^${name}$`) })
      .click();
    await expect(actionButton(page, '新建')).toHaveCount(1);
    await expect(page.locator('th')).toHaveText(['名称', '类型', '对象', '操作']);
  }
});

test('AC-F474-SM02 继承冲突重读后改回原值，以最新版本显式重提', async ({ page }) => {
  const state = await setup(page);
  state.reply = 'conflict';
  await actionButton(page, '设置继承').click();
  const form = page.getByRole('dialog');
  await form.getByRole('switch').click();
  await actionButton(form, '保存').click();
  await actionButton(form, '重读最新版本').click();
  await actionButton(form, '已核对差异，继续编辑').click();
  await form.getByRole('switch').click();
  await actionButton(form, '保存').click();
  await expect(form).toHaveCount(0);
  expect(state.writes.map(({ body, revision }) => ({ body, revision }))).toEqual([
    { body: { inherit: false }, revision: '1' },
    { body: { inherit: true }, revision: '2' },
  ]);
});

test('AC-F474-SM03 未知命令关闭换页、后退前进后仍锁定，显式重试复用原命令', async ({ page }) => {
  const state = await setup(page);
  state.reply = 'unknown';
  await actionButton(page, '新建').click();
  const form = page.getByRole('dialog');
  await form.getByLabel('名称', { exact: true }).fill('合成待确认');
  await actionButton(form, '保存').click();
  await expect(form).toContainText('结果待确认');
  await actionButton(form, '取消').click();
  // 同一 SPA 内导航，模块级表单仓保留原命令。
  await page.locator('.ant-select[aria-label="对象"] .ant-select-selector').click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .filter({ hasText: /^合同协议$/ })
    .click();
  await actionButton(page, '新建').click();
  await expect(form.getByLabel('名称', { exact: true })).toHaveValue('合成待确认');
  await expect(actionButton(form, '保存')).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await actionButton(form, '取消').click();
  await page.evaluate(() => {
    history.pushState({}, '', '/staff');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: '自定义字段', exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: '自定义字段', exact: true })).toBeVisible();
  await page.goForward();
  await page.goBack();
  await actionButton(page, '新建').click();
  await expect(actionButton(form, '保存')).toBeDisabled();
  state.reply = 'success';
  await actionButton(form, '按原命令重试').click();
  await expect(form).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
});
