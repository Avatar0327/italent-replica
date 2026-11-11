import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { settingsFixtures, rows, ids } from './settings-fixtures.js';
const objectCode = 'TenantBase.Employee';
const root = `/api/tenant/permission/profiles/${ids.profile}`;
const target = `${root}/objects/${objectCode}`;
async function setup(page: Page, editable = true) {
  await settingsFixtures(page, editable);
  let revision = 3;
  let digest = '0123456789abcdef';
  let operations = { create: true, update: false, delete: false };
  const fields = Array.from({ length: 101 }, (_, index) => ({
    fieldCode: `Field${String(index).padStart(3, '0')}`,
    system: index === 0,
    view: index === 0,
    edit: false,
  }));
  const writes: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  await page.route('**/permission/profiles/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'PUT') {
      writes.push({ path: url.pathname, body: request.postDataJSON(), headers: request.headers() });
      if (url.pathname.endsWith('/data-operations')) operations = request.postDataJSON().dataOperations;
      if (url.pathname.endsWith('/fields'))
        for (const change of request.postDataJSON().fields)
          Object.assign(
            fields.find((f) => f.fieldCode === change.fieldCode)!,
            change,
          );
      revision++;
      return route.fulfill({ json: { profileId: ids.profile, objectCode, revision } });
    }
    if (url.pathname.endsWith('/data-operations'))
      return route.fulfill({ json: { profileId: ids.profile, objectCode, revision, dataOperations: operations } });
    if (url.pathname.endsWith('/fields')) {
      const matched = fields.filter((f) =>
        f.fieldCode.toLowerCase().includes((url.searchParams.get('code') ?? '').toLowerCase()),
      );
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return route.fulfill({
        json: {
          profileId: ids.profile,
          objectCode,
          revision,
          catalogDigest: digest,
          total: matched.length,
          items: matched.slice(offset, offset + limit),
        },
      });
    }
    return route.fulfill({ json: { ...rows.profile, revision } });
  });
  await page.goto('/settings/menu/permission.profiles');
  await page.getByRole('button', { name: rows.profile.name, exact: true }).click();
  return {
    writes,
    fields,
    advance(next?: typeof operations, nextDigest?: string) {
      revision++;
      if (next) operations = next;
      if (nextDigest) digest = nextDigest;
    },
  };
}
const modal = (page: Page) => page.locator('.ant-modal');
async function open(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(modal(page)).toBeVisible();
}

test('AC-FE-F4745-A2b 数据操作从对象行读取并通过 PUT 保存', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { writes } = await setup(page);
  await expect(page.locator('.profile-object-page .ant-spin-spinning')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('objects.png'), fullPage: true, animations: 'disabled' });
  await open(page, '数据操作权限');
  await expect(modal(page).getByRole('radio', { name: '新增 开启', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('data.png'), fullPage: true, animations: 'disabled' });
  await expect(modal(page).getByRole('radio', { name: '新增 开启', exact: true })).toBeChecked();
  await modal(page).getByRole('radio', { name: '编辑 开启', exact: true }).check();
  await modal(page)
    .getByRole('button', { name: /确\s*定$/ })
    .click();
  await expect(modal(page)).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toBe(`${target}/data-operations`);
  expect(writes[0]!.body).toEqual({ dataOperations: { create: true, update: true, delete: false } });
  expect(writes[0]!.headers['if-match']).toBe('3');
  expect(writes[0]!.headers['idempotency-key']).toBeTruthy();
});

test('AC-FE-F4745-A2b 字段分页筛选保留草稿，仅 PUT 改动字段，系统字段锁定', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { writes } = await setup(page);
  await open(page, '字段权限');
  await expect(modal(page).getByRole('checkbox', { name: 'Field000 编辑', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('fields.png'), fullPage: true, animations: 'disabled' });
  await modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true }).check();
  await modal(page).locator('.ant-pagination-next button').click();
  await modal(page).getByRole('checkbox', { name: 'Field100 编辑', exact: true }).check();
  await modal(page).getByRole('textbox', { name: '编码', exact: true }).fill('Field001');
  await modal(page)
    .getByRole('button', { name: /^查\s*询$/ })
    .click();
  await expect(modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true })).toBeChecked();
  await modal(page)
    .getByRole('button', { name: /确\s*定$/ })
    .click();
  await expect(modal(page)).toHaveCount(0);
  expect(writes[0]!.body).toEqual({
    catalogDigest: '0123456789abcdef',
    fields: [
      { fieldCode: 'Field001', view: true, edit: false },
      { fieldCode: 'Field100', view: false, edit: true },
    ],
  });
});

test('AC-FE-F4745-A2b 404 明确提示对象未配置，禁止保存', async ({ page }) => {
  const { writes } = await setup(page);
  await page.route('**/objects/*/data-operations', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }),
  );
  await open(page, '数据操作权限');
  await expect(modal(page)).toContainText('该身份尚未配置此对象');
  await expect(modal(page).getByRole('button', { name: /确\s*定$/ })).toBeDisabled();
  expect(writes).toEqual([]);
});

const save = (page: Page) =>
  modal(page)
    .getByRole('button', { name: /确\s*定$/ })
    .click();
const cancel = (page: Page) =>
  modal(page)
    .getByRole('button', { name: /^取\s*消$/ })
    .click();
const modes = [
  { mode: 'data-operations', label: '数据操作权限', control: '编辑 开启', role: 'radio' },
  { mode: 'fields', label: '字段权限', control: 'Field001 查看', role: 'checkbox' },
] as const;
for (const entry of modes) {
  test(`AC-FE-F4745-A2b ${entry.label} 409重读后改回原值，用新revision和命令保存`, async ({ page }) => {
    const fixture = await setup(page);
    await open(page, entry.label);
    await modal(page).getByRole(entry.role, { name: entry.control, exact: true }).check();
    let rejectedId = '';
    await page.route(`**/objects/*/${entry.mode}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      rejectedId = route.request().headers()['idempotency-key']!;
      fixture.advance({ create: false, update: true, delete: true });
      Object.assign(fixture.fields[1]!, { view: true, edit: true });
      await route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
      await page.unroute(`**/objects/*/${entry.mode}`);
    });
    await save(page);
    await expect(modal(page)).toContainText('版本冲突');
    await modal(page).getByRole('button', { name: '重读最新版本', exact: true }).click();
    await modal(page).getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
    if (entry.mode === 'fields') {
      await expect(modal(page).getByRole('checkbox', { name: 'Field001 编辑', exact: true })).toBeChecked();
      await modal(page).getByRole('checkbox', { name: entry.control, exact: true }).uncheck();
    } else await modal(page).getByRole('radio', { name: '编辑 关闭', exact: true }).check();
    await save(page);
    await expect(modal(page)).toHaveCount(0);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.headers['if-match']).toBe('4');
    expect(fixture.writes[0]!.headers['idempotency-key']).not.toBe(rejectedId);
    expect(fixture.writes[0]!.body).toEqual(
      entry.mode === 'fields'
        ? { catalogDigest: '0123456789abcdef', fields: [{ fieldCode: 'Field001', view: false, edit: true }] }
        : { dataOperations: { create: false, update: false, delete: true } },
    );
  });
  test(`AC-FE-F4745-A2b ${entry.label} 未知结果关闭重开及换入口锁定，按原命令重试`, async ({ page }) => {
    const { writes } = await setup(page);
    await open(page, entry.label);
    await modal(page).getByRole(entry.role, { name: entry.control, exact: true }).check();
    let lost: { body: unknown; headers: Record<string, string> } | undefined;
    await page.route(`**/objects/*/${entry.mode}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      lost = { body: route.request().postDataJSON(), headers: route.request().headers() };
      await route.abort('failed');
      await page.unroute(`**/objects/*/${entry.mode}`);
    });
    await save(page);
    await expect(modal(page)).toContainText('结果待确认');
    await cancel(page);
    await open(page, entry.mode === 'fields' ? '数据操作权限' : '字段权限');
    await expect(modal(page)).toContainText('未确认的其他操作');
    await expect(modal(page).getByRole('button', { name: /确\s*定$/ })).toBeDisabled();
    await cancel(page);
    await page.getByRole('button', { name: /^返\s*回$/ }).click();
    await page.getByRole('button', { name: rows.profile.name, exact: true }).click();
    await open(page, entry.label);
    await expect(modal(page).getByRole(entry.role, { name: entry.control, exact: true })).toBeChecked();
    await expect(modal(page).getByRole(entry.role, { name: entry.control, exact: true })).toBeDisabled();
    await modal(page).getByRole('button', { name: '回查原单', exact: true }).click();
    await expect(modal(page)).toContainText('原单当前值');
    await expect(modal(page).getByRole('button', { name: /确\s*定$/ })).toBeDisabled();
    await modal(page).getByRole('button', { name: '按原命令重试', exact: true }).click();
    await expect(modal(page)).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual(lost!.body);
    expect(writes[0]!.headers['if-match']).toBe(lost!.headers['if-match']);
    expect(writes[0]!.headers['idempotency-key']).toBe(lost!.headers['idempotency-key']);
  });
  test(`AC-FE-F4745-A2b ${entry.label} 422保留输入可改正重提，PUT404明确提示`, async ({ page }) => {
    const { writes } = await setup(page);
    await open(page, entry.label);
    await modal(page).getByRole(entry.role, { name: entry.control, exact: true }).check();
    let attempts = 0;
    const commands: string[] = [];
    await page.route(`**/objects/*/${entry.mode}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      commands.push(route.request().headers()['idempotency-key']!);
      attempts++;
      await route.fulfill({
        status: attempts === 1 ? 422 : 404,
        json: {
          error: {
            code: attempts === 1 ? 'VALIDATION_FAILED' : 'NOT_FOUND',
            message: '合成业务拒绝',
          },
        },
      });
    });
    await save(page);
    await expect(modal(page)).toContainText('合成业务拒绝');
    await expect(modal(page).getByRole(entry.role, { name: entry.control, exact: true })).toBeChecked();
    await expect(modal(page).getByRole('button', { name: /确\s*定$/ })).toBeEnabled();
    await save(page);
    await expect(modal(page)).toContainText('该身份尚未配置此对象');
    await expect(modal(page).getByRole('button', { name: /确\s*定$/ })).toBeDisabled();
    expect(commands[0]).not.toBe(commands[1]);
    expect(writes).toHaveLength(0);
  });
}
test('AC-FE-F4745-A2b 字段目录冲突重读新指纹，转系统字段的编辑草稿撤掉', async ({ page }) => {
  const fixture = await setup(page);
  await open(page, '字段权限');
  await modal(page).getByRole('checkbox', { name: 'Field001 编辑', exact: true }).check();
  await modal(page).getByRole('checkbox', { name: 'Field002 查看', exact: true }).check();
  await page.route('**/objects/*/fields', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    fixture.advance(undefined, 'fedcba9876543210');
    fixture.fields[1]!.system = true;
    await route.fulfill({ status: 409, json: { error: { code: 'CATALOG_CHANGED' } } });
    await page.unroute('**/objects/*/fields');
  });
  await save(page);
  await modal(page).getByRole('button', { name: '重读最新版本', exact: true }).click();
  await modal(page).getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(modal(page).getByRole('checkbox', { name: 'Field001 编辑', exact: true })).toBeDisabled();
  await expect(modal(page).getByRole('checkbox', { name: 'Field001 编辑', exact: true })).not.toBeChecked();
  await save(page);
  await expect(modal(page)).toHaveCount(0);
  expect(fixture.writes[0]!.body).toEqual({
    catalogDigest: 'fedcba9876543210',
    fields: [{ fieldCode: 'Field002', view: true, edit: false }],
  });
});

test('AC-FE-F4745-A2b 字段明确拒绝后跨页继续编辑，仅提交两页真实改动', async ({ page }) => {
  const { writes, fields } = await setup(page);
  fields.push({ fieldCode: 'Field101', system: false, view: false, edit: false });
  await open(page, '字段权限');
  await modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true }).check();
  await page.route('**/objects/*/fields', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await route.fulfill({ status: 422, json: { error: { code: 'VALIDATION_FAILED', message: '合成校验失败' } } });
    await page.unroute('**/objects/*/fields');
  });
  await save(page);
  await expect(modal(page)).toContainText('合成校验失败');
  await modal(page).locator('.ant-pagination-next button').click();
  await modal(page).getByRole('checkbox', { name: 'Field100 编辑', exact: true }).check();
  await save(page);
  await expect(modal(page)).toHaveCount(0);
  expect(writes[0]!.body).toEqual({
    catalogDigest: '0123456789abcdef',
    fields: [
      { fieldCode: 'Field001', view: true, edit: false },
      { fieldCode: 'Field100', view: false, edit: true },
    ],
  });
});

test('AC-FE-F4745-A2b 对象15条分页与编码筛选，返回再进入读取最新列表', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: /^返\s*回$/ }).click();
  const objects = Array.from({ length: 16 }, (_, index) => ({
    objectCode: `Demo.Object${String(index).padStart(2, '0')}`,
    dataOperations: { create: false, update: false, delete: false },
    fields: [],
    buttons: [],
  }));
  await page.route(`**/profiles/${ids.profile}`, (route) => route.fulfill({ json: { ...rows.profile, objects } }));
  await page.getByRole('button', { name: rows.profile.name, exact: true }).click();
  const table = page.locator('.profile-object-page');
  await expect(table.locator('tbody tr.ant-table-row')).toHaveCount(15);
  await expect(table).toContainText('共 16 条');
  await table.locator('.ant-pagination-next button').click();
  await expect(table.locator('tbody tr.ant-table-row')).toHaveCount(1);
  await table.getByRole('textbox', { name: '编码', exact: true }).fill('Object03');
  await table.getByRole('button', { name: /^查\s*询$/ }).click();
  await expect(table.locator('tbody tr.ant-table-row')).toHaveText(/Demo.Object03/);
  await table.getByRole('button', { name: /^清\s*空$/ }).click();
  await expect(table.locator('tbody tr.ant-table-row')).toHaveCount(15);
});

test('AC-FE-F4745-A2b 只读字段可查询空集与500条分页，取消无写入', async ({ page }) => {
  const { writes, fields } = await setup(page, false);
  fields.push(
    ...Array.from({ length: 399 }, (_, i) => ({
      fieldCode: `More${i}`,
      system: false,
      view: false,
      edit: false,
    })),
  );
  const requests: URL[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/objects/') && request.method() === 'GET') requests.push(new URL(request.url()));
  });
  await open(page, '字段权限');
  await expect(modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true })).toBeDisabled();
  await modal(page).locator('.ant-select-selector').click();
  await page.getByText('500条/页', { exact: true }).click();
  await expect(modal(page).locator('tbody tr.ant-table-row')).toHaveCount(500);
  await modal(page).getByRole('textbox', { name: '编码', exact: true }).fill('No%_\\Match');
  await modal(page)
    .getByRole('button', { name: /^查\s*询$/ })
    .click();
  await expect(modal(page).locator('tbody tr.ant-table-row')).toHaveCount(0);
  await expect(modal(page)).toContainText('暂无数据');
  expect(requests.at(-1)!.searchParams.get('code')).toBe('No%_\\Match');
  expect(requests.some((url) => url.searchParams.get('limit') === '500')).toBe(true);
  await cancel(page);
  expect(writes).toEqual([]);
});

test('AC-FE-F4745-A2b 提交后后退，迟到成功不跳转；前进重开读取当前值', async ({ page }) => {
  const fixture = await setup(page);
  const navigation = page.locator('.settings-navigation');
  await navigation.getByRole('button', { name: '全部用户', exact: true }).click();
  await navigation.getByRole('button', { name: '身份管理', exact: true }).click();
  await page.getByRole('button', { name: rows.profile.name, exact: true }).click();
  await open(page, '数据操作权限');
  await modal(page).getByRole('radio', { name: '编辑 开启', exact: true }).check();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started = false;
  await page.route('**/objects/*/data-operations', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    started = true;
    await pending;
    await route.fallback();
  });
  await save(page);
  await expect.poll(() => started).toBe(true);
  await page.goBack();
  await expect(page.getByRole('heading', { name: '全部用户', exact: true })).toBeVisible();
  finish();
  await expect.poll(() => fixture.writes.length).toBe(1);
  fixture.advance({ create: false, update: false, delete: true });
  await expect(page).toHaveURL(/settings\/menu\/users.all$/);
  await page.goForward();
  await page.getByRole('button', { name: rows.profile.name, exact: true }).click();
  await open(page, '数据操作权限');
  await expect(modal(page).getByRole('radio', { name: '新增 关闭', exact: true })).toBeChecked();
  await expect(modal(page).getByRole('radio', { name: '编辑 关闭', exact: true })).toBeChecked();
  await expect(modal(page).getByRole('radio', { name: '删除 开启', exact: true })).toBeChecked();
});

async function catalogConflict(page: Page, change: () => void) {
  await page.route('**/objects/*/fields', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    change();
    await route.fulfill({ status: 409, json: { error: { code: 'CATALOG_CHANGED' } } });
    await page.unroute('**/objects/*/fields');
  });
  await save(page);
  await modal(page).getByRole('button', { name: '重读最新版本', exact: true }).click();
  await modal(page).getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
}

test('AC-FE-F4745-A2b P2-1 重读目录100变101后出现第二页，新字段可见且草稿可保存', async ({ page }) => {
  const fixture = await setup(page);
  const added = fixture.fields.pop()!;
  await open(page, '字段权限');
  await expect(modal(page)).toContainText('共 100 条');
  await modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true }).check();
  await catalogConflict(page, () => {
    fixture.fields.push(added);
    fixture.advance(undefined, 'fedcba9876543210');
  });
  await expect(modal(page)).toContainText('共 101 条');
  await expect(modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true })).toBeChecked();
  await modal(page).locator('.ant-pagination-next button').click();
  await expect(modal(page).getByRole('checkbox', { name: 'Field100 查看', exact: true })).toBeVisible();
  await modal(page).getByRole('checkbox', { name: 'Field100 查看', exact: true }).check();
  await save(page);
  await expect(modal(page)).toHaveCount(0);
  expect(fixture.writes[0]!.headers['if-match']).toBe('4');
  expect(fixture.writes[0]!.body).toEqual({
    catalogDigest: 'fedcba9876543210',
    fields: [
      { fieldCode: 'Field001', view: true, edit: false },
      { fieldCode: 'Field100', view: true, edit: false },
    ],
  });
});

for (const remaining of [50, 0]) {
  test(`AC-FE-F4745-A2b P2-1 重读后筛选结果101缩至${remaining}，页码回到有效页`, async ({ page }) => {
    const fixture = await setup(page);
    fixture.fields.push({ fieldCode: 'Other', system: false, view: false, edit: false });
    await open(page, '字段权限');
    await modal(page).getByRole('textbox', { name: '编码', exact: true }).fill('fIeLd');
    await modal(page)
      .getByRole('button', { name: /^查\s*询$/ })
      .click();
    await expect(modal(page)).toContainText('共 101 条');
    await modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true }).check();
    await modal(page).locator('.ant-pagination-next button').click();
    await modal(page).getByRole('checkbox', { name: 'Field100 编辑', exact: true }).check();
    await catalogConflict(page, () => {
      fixture.fields.splice(remaining, 101 - remaining);
      fixture.advance(undefined, 'fedcba9876543210');
    });
    await expect(modal(page).locator('.ant-pagination-item-2')).toHaveCount(0);
    await expect(modal(page).getByRole('textbox', { name: '编码', exact: true })).toHaveValue('fIeLd');
    if (remaining) {
      await expect(modal(page)).toContainText('共 50 条');
      await expect(modal(page).locator('.ant-pagination-item-active')).toHaveText('1');
      await expect(modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true })).toBeChecked();
      await expect(modal(page).getByRole('checkbox', { name: 'Other 查看', exact: true })).toHaveCount(0);
      await save(page);
      await expect(modal(page)).toHaveCount(0);
      expect(fixture.writes[0]!.body).toEqual({
        catalogDigest: 'fedcba9876543210',
        fields: [{ fieldCode: 'Field001', view: true, edit: false }],
      });
    } else {
      await expect(modal(page).locator('.ant-table-tbody .ant-table-row')).toHaveCount(0);
      await modal(page).getByRole('textbox', { name: '编码', exact: true }).clear();
      await modal(page)
        .getByRole('button', { name: /^查\s*询$/ })
        .click();
      await expect(modal(page).getByRole('checkbox', { name: 'Other 查看', exact: true })).toBeVisible();
    }
  });
}
