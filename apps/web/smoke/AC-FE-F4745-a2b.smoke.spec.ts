import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { settingsFixtures, rows, ids } from './settings-fixtures.js';
const objectCode = 'TenantBase.Employee';
const root = `/api/tenant/permission/profiles/${ids.profile}`;
const target = `${root}/objects/${objectCode}`;
async function setup(page: Page, editable = true) {
  await settingsFixtures(page, editable);
  let revision = 3;
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
          catalogDigest: '0123456789abcdef',
          total: matched.length,
          items: matched.slice(offset, offset + limit),
        },
      });
    }
    return route.fulfill({ json: { ...rows.profile, revision } });
  });
  await page.goto('/settings/menu/permission.profiles');
  await page.getByRole('button', { name: rows.profile.name, exact: true }).click();
  return { writes, fields };
}
const modal = (page: Page) => page.locator('.ant-modal');
async function open(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(modal(page)).toBeVisible();
}

test('AC-FE-F4745-A2b 数据操作从对象行读取并通过 PUT 保存', async ({ page }) => {
  const { writes } = await setup(page);
  await open(page, '数据操作权限');
  await expect(modal(page).getByRole('radio', { name: '新增 开启', exact: true })).toBeChecked();
  await modal(page).getByRole('radio', { name: '编辑 开启', exact: true }).check();
  await modal(page).getByRole('button', { name: '确定', exact: true }).click();
  await expect(modal(page)).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toBe(`${target}/data-operations`);
  expect(writes[0]!.body).toEqual({ dataOperations: { create: true, update: true, delete: false } });
  expect(writes[0]!.headers['if-match']).toBe('3');
  expect(writes[0]!.headers['idempotency-key']).toBeTruthy();
});

test('AC-FE-F4745-A2b 字段分页筛选保留草稿，仅 PUT 改动字段，系统字段锁定', async ({ page }) => {
  const { writes } = await setup(page);
  await open(page, '字段权限');
  await expect(modal(page).getByRole('checkbox', { name: 'Field000 编辑', exact: true })).toBeDisabled();
  await modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true }).check();
  await modal(page).locator('.ant-pagination-next button').click();
  await modal(page).getByRole('checkbox', { name: 'Field100 编辑', exact: true }).check();
  await modal(page).getByRole('textbox', { name: '编码', exact: true }).fill('Field001');
  await modal(page)
    .getByRole('button', { name: /^查\s*询$/ })
    .click();
  await expect(modal(page).getByRole('checkbox', { name: 'Field001 查看', exact: true })).toBeChecked();
  await modal(page).getByRole('button', { name: '确定', exact: true }).click();
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
  await expect(modal(page).getByRole('button', { name: '确定', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
});
