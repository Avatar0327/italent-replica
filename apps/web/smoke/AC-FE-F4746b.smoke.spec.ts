import type { Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';

// F-474-6b：组织自定义字段。接口形状照真实后端：定义目录 GET /employment/custom-fields，组织行 customFields 按字段 ID 嵌套。
const id = '40000000-0000-4000-8000-000000000474';
const shown = '30000000-0000-4000-8000-0000000000c1';
const empty = '30000000-0000-4000-8000-0000000000c2';
const hidden = '30000000-0000-4000-8000-0000000000c3';
const standard = [
  'name',
  'code',
  'enabled',
  'parents',
  'remarks',
  'shortName',
  'displayOrder',
  'personInChargeId',
  'hrbpId',
  'isVirtual',
  'broadType',
  'location',
  'fullName',
  'establishedOn',
  'effectiveDate',
  'startDate',
  'stopDate',
  'headcount',
];
const customKeys = [`custom:${shown}`, `custom:${empty}`];
const definitions = [shown, empty, hidden].map((fieldId, index) => ({
  id: fieldId,
  code: `ext_${index}`,
  name: ['合成备注甲', '合成备注乙', '合成无权字段'][index],
  objectType: 'organization',
  valueType: 'text',
  revision: 1,
  inherit: false,
  options: [],
}));

async function setup(page: Page, baseURL: string | undefined) {
  await page.clock.setFixedTime(new Date('2026-10-12T08:00:00Z'));
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: '10000000-0000-4000-8000-000000000001', url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: { create: true, update: true },
        viewableFields: [...standard, ...customKeys],
        editableFields: [...standard, ...customKeys],
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
        ],
      },
    }),
  );
  await page.route('**/api/tenant/employment/custom-fields**', (route) =>
    route.fulfill({ json: { items: definitions, page: 1, pageSize: 200, hasDataPermission: true } }),
  );
  await page.route('**/api/tenant/org/person-candidates**', (route) => route.fulfill({ json: { items: [] } }));
  const row = {
    id,
    revision: 1,
    name: '合成组织',
    shortName: '合成简称',
    code: 'ORG-474',
    enabled: true,
    isVirtual: false,
    broadType: '合成类型',
    displayOrder: 1,
    establishedOn: '2026-01-01',
    parents: { admin: { parentId: null, sequence: null } },
    // 服务端按查看权裁剪：无权字段 hidden 不在其中，乙没有值
    customFields: { [shown]: '甲的值' },
  };
  await page.route('**/api/tenant/org/organizations**', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { ...row, revision: 2 } });
    }
    const detail = new URL(request.url()).pathname.endsWith(id);
    return route.fulfill({ json: detail ? row : { items: [row], total: 1, hasDataPermission: true } });
  });
  return writes;
}

test('AC-FE-F474-6b-01 详情“其他信息”显示有权字段，空值 --，无权字段整项不渲染', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page, baseURL);
  await page.goto('/org');
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('其他信息', { exact: true })).toBeVisible();
  await expect(drawer.getByText('合成备注甲', { exact: true })).toBeVisible();
  await expect(drawer.getByText('甲的值', { exact: true })).toBeVisible();
  await expect(drawer.getByText('合成备注乙', { exact: true })).toBeVisible();
  await expect(drawer.getByText('--', { exact: true })).toBeVisible();
  await expect(drawer.getByText('合成无权字段')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F474-6b-02 列表默认不显示自定义列，列设置可勾选，值取自 customFields', async ({ page, baseURL }) => {
  await setup(page, baseURL);
  await page.goto('/org');
  await expect(page.getByRole('columnheader', { name: '机构名称' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '合成备注甲' })).toHaveCount(0);
  await page.getByRole('button', { name: '列设置' }).click();
  await page.getByRole('button', { name: '设置显示字段' }).click();
  const dialog = page.getByRole('dialog', { name: '设置显示字段' });
  await expect(dialog.getByText('合成无权字段')).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: '合成备注甲' }).check();
  await dialog.getByRole('button', { name: '确 定' }).click();
  await expect(page.getByRole('columnheader', { name: '合成备注甲' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '甲的值', exact: true })).toBeVisible();
});

test('AC-FE-F474-6b-03 变更抽屉只提交改过的自定义字段，清空提交 null', async ({ page, baseURL }) => {
  const writes = await setup(page, baseURL);
  await page.goto('/org');
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '变更' }).click();
  const modal = page.getByRole('dialog', { name: /变更 · 合成组织/ });
  await expect(modal.getByText('其他信息', { exact: true })).toBeVisible();
  await expect(modal.getByLabel('合成无权字段')).toHaveCount(0);
  await modal.getByLabel('合成备注甲').fill('');
  await modal.getByLabel('合成备注乙').fill('乙的新值');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('dialog', { name: /变更 · 合成组织/ })).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body).toEqual({
    effectiveDate: '2026-10-12',
    customFields: { [shown]: null, [empty]: '乙的新值' },
  });
});
