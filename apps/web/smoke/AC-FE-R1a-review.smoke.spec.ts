import type { Page } from '@playwright/test';
import { test, expect, user, snapshotFixture } from './fixtures.js';

const id = '40000000-0000-4000-8000-000000000001';
const kinds = ['layers', 'grades', 'level-types', 'levels', 'sequences', 'professional-lines', 'posts', 'positions'];
const schemeObject = 'TenantBase.OrganizationEstablishment';
const fields = ['name', 'code', 'periodType', 'maintenanceMode', 'startDate', 'stopDate', 'enabled', 'orgId', 'postId'];
async function setup(page: Page, options: { hiddenName?: boolean; schemeOnly?: boolean; readonlyDate?: boolean } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('403 (Forbidden)')) errors.push(message.text());
  });
  if (options.schemeOnly)
    await page.route('**/permission/me/snapshot', (route) =>
      route.fulfill({
        json: {
          ...snapshotFixture,
          apps: snapshotFixture.apps.map((app) => (app.app === 'org' ? { ...app, entryObjects: [schemeObject] } : app)),
        },
      }),
    );
  await page.route('**/permission/me/objects/*', (route) => {
    const objectCode = new URL(route.request().url()).pathname.split('/').at(-1);
    if (options.schemeOnly && objectCode !== schemeObject)
      return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } });
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { create: true, update: true },
        viewableFields: fields.filter((field) => !options.hiddenName || field !== 'name'),
        editableFields: options.readonlyDate ? ['name', 'orgId', 'postId'] : fields,
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
        ],
      },
    });
  });
  const row = { id, revision: 1, name: 'annual', code: 'local', periodType: 'annual', maintenanceMode: 'local' };
  for (const path of ['job/**', 'org/organizations**', 'establishment/schemes**']) {
    await page.route(`**/api/tenant/${path}`, (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith(id)
          ? row
          : { items: [row], hasDataPermission: true, today: '2026-10-13' },
      }),
    );
  }
  await page.goto('/self');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  return errors;
}

test('AC-FE-R1a-16 编制自由文本原样显示，只有枚举翻译，列表与详情一致', async ({ page }) => {
  const errors = await setup(page);
  await page.goto('/org?tab=establishment');
  const row = page.locator('tr[data-row-key]').first();
  await expect(row.getByRole('cell', { name: 'local', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '年度', exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'annual', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('annual', { exact: true })).toBeVisible();
  await expect(drawer.getByText('local', { exact: true })).toBeVisible();
  await expect(drawer.getByText('只维护本级', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const kind of kinds) {
  test(`AC-FE-R1a-17 ${kind} 新建不提交只读日期和只读默认值`, async ({ page }) => {
    const errors = await setup(page, { readonlyDate: true });
    const bodies: Record<string, unknown>[] = [];
    await page.route(`**/api/tenant/job/${kind}`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      const forbidden = Object.keys(body).some((key) => !['name', 'orgId', 'postId'].includes(key));
      await route.fulfill({
        status: forbidden ? 403 : 201,
        json: forbidden ? { error: { code: 'FORBIDDEN' } } : { id, revision: 1, ...body },
      });
    });
    await page.goto(`/job?kind=${kind}`);
    await chooseFutureDate(page);
    const candidateDates: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.searchParams.get('pageSize') === '50') candidateDates.push(url.searchParams.get('asOf') ?? '');
    });
    await page.getByRole('button', { name: /新\s*建/, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称', { exact: true }).fill('合成新对象');
    if (kind === 'positions') {
      for (const label of ['所属组织', '对应职务']) {
        const select = dialog
          .locator('.ant-form-item')
          .filter({
            has: page.locator('label').filter({ hasText: label }),
          })
          .getByRole('combobox');
        await select.focus();
        await select.press('ArrowDown');
        await expect(
          page.locator('.ant-select-dropdown:visible').getByTitle('annual', { exact: true }).last(),
        ).toBeVisible();
        await select.press('Enter');
      }
    }
    await dialog.getByRole('button', { name: /保\s*存/, exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toEqual(
      kind === 'positions' ? { name: '合成新对象', orgId: id, postId: id } : { name: '合成新对象' },
    );
    await expect(dialog).toHaveCount(0);
    if (kind === 'positions') {
      expect(candidateDates.length).toBeGreaterThan(0);
      expect(new Set(candidateDates)).toEqual(new Set(['2026-10-13']));
    }
    expect(errors).toEqual([]);
  });
}

test('AC-FE-R1a-18 仅方案查看权可打开编制概览，不查询组织列表', async ({ page }) => {
  const errors = await setup(page, { schemeOnly: true });
  const orgRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/org/organizations')) orgRequests.push(request.url());
  });
  await page.goto('/org?tab=establishment');
  await expect(page.getByRole('button', { name: 'annual', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'annual', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goto('/org');
  await expect(page.getByRole('button', { name: 'annual', exact: true })).toBeVisible();
  await page.goto('/org?tab=list');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  expect(orgRequests).toEqual([]);
  expect(errors).toEqual([]);
});

for (const path of [
  '/org?tab=establishment',
  '/org?tab=list',
  '/org?tab=tree',
  '/org?tab=changes',
  ...kinds.map((kind) => `/job?kind=${kind}`),
]) {
  test(`AC-FE-R1a-19 ${path} 名称隐藏仍可从行操作打开详情`, async ({ page }) => {
    const errors = await setup(page, { hiddenName: true });
    await page.goto(path);
    await expect(page.getByRole('button', { name: 'annual', exact: true })).toHaveCount(0);
    await page
      .locator('tr[data-row-key]')
      .first()
      .getByRole('button', { name: /详\s*情/, exact: true })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('annual', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

async function chooseFutureDate(page: Page) {
  const date = page.locator('.page-filters .ant-picker input');
  await date.fill('2026-10-20');
  await date.press('Enter');
  await expect(date).toHaveValue('2026-10-20');
}

for (const kind of kinds) {
  test(`AC-FE-R1a-20 ${kind} 有日期编辑权的新建提交所选日期，候选使用相同时点`, async ({ page }) => {
    const errors = await setup(page);
    const bodies: Record<string, unknown>[] = [];
    const candidateDates: string[] = [];
    await page.route(`**/api/tenant/job/${kind}`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      await route.fulfill({ status: 201, json: { id, revision: 1, ...body } });
    });
    await page.goto(`/job?kind=${kind}`);
    await chooseFutureDate(page);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.searchParams.get('pageSize') === '50') candidateDates.push(url.searchParams.get('asOf') ?? '');
    });
    await page.getByRole('button', { name: /新\s*建/, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称', { exact: true }).fill('未来合成对象');
    if (kind === 'positions') {
      for (const label of ['所属组织', '对应职务']) {
        const select = dialog
          .locator('.ant-form-item')
          .filter({ has: page.locator('label').filter({ hasText: label }) })
          .getByRole('combobox');
        await select.focus();
        await select.press('ArrowDown');
        await expect(
          page.locator('.ant-select-dropdown:visible').getByTitle('annual', { exact: true }).last(),
        ).toBeVisible();
        await select.press('Enter');
      }
    }
    await dialog.getByRole('button', { name: /保\s*存/, exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ name: '未来合成对象', startDate: '2026-10-20' });
    if (kind === 'positions') {
      expect(bodies[0]).toMatchObject({ orgId: id, postId: id });
      expect(candidateDates.length).toBeGreaterThan(0);
    }
    expect(candidateDates.every((date) => date === '2026-10-20')).toBe(true);
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
