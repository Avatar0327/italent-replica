import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { addExit, setupExits, type ExitServer } from './exit-list-fixtures.js';
import { buildXlsx, importHeader, importReceipt, importRows, importSheet } from './exit-import-fixtures.js';

const ENTRY = '导入历史离职人员';
const importButton = { buttonCode: 'Employment.DimissionImport', level: 'list' };
const rowOf = (page: Page, name: string) => page.locator('.exit-card').getByRole('row').filter({ hasText: name });
async function routeImport(page: Page, server: ExitServer, lose = false) {
  const posts: { path: string; body: Record<string, unknown>; key: string | undefined }[] = [];
  await page.route(/\/api\/tenant\/employment\/exits\/import(\/preview)?$/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as { rows: { rowNo: number }[] };
    posts.push({ path, body, key: request.headers()['idempotency-key'] });
    if (lose) {
      lose = false;
      return route.abort('failed');
    }
    for (const row of importRows) addExit(server, row.name, { status: 'effective', mode: 'direct' });
    return route.fulfill({ status: 202, json: importReceipt(body.rows) });
  });
  return posts;
}
async function upload(page: Page) {
  const modal = page.getByRole('dialog').filter({ hasText: ENTRY });
  await modal
    .getByLabel('选择 Excel 文件')
    .setInputFiles({
      name: '历史离职.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await buildXlsx(importSheet)),
    });
  await expect(modal.getByRole('button', { name: /^保\s*存$/ })).toBeEnabled();
  return modal;
}

test('F493-FE-01 / 06 保存即提交，回离职中，全部记录按直接离职展示', async ({ page }) => {
  const server = await setupExits(page, [importButton]);
  const posts = await routeImport(page, server);
  await page.getByRole('button', { name: '全部离职记录', exact: true }).click();
  await page.getByRole('button', { name: ENTRY, exact: true }).click();
  const modal = await upload(page);
  await expect(modal.locator('th')).toHaveCount(0);
  expect(posts).toHaveLength(0);
  await expect(modal.getByRole('button', { name: /^取\s*消$/ })).toHaveCount(0);
  await modal.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(page.locator('.ant-message').getByText('导入进行中，执行结果请关注消息通知')).toBeVisible();
  await expect(modal).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ rows: importRows, fileName: '历史离职.xlsx' });
  expect(posts[0]!.key).toBeTruthy();
  await expect.poll(() => server.queries.at(-1)?.get('view')).toBe('in_progress');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.getByRole('button', { name: '全部离职记录', exact: true }).click();
  await expect(rowOf(page, '合成甲')).toContainText('直接离职');
  await rowOf(page, '合成甲').getByRole('button', { name: '查看详情', exact: true }).click();
  const detail = page.getByRole('dialog').filter({ hasText: '离职管理' });
  await expect(detail.locator('th:has-text("办理方式") + td')).toHaveText('直接离职');
});

test('F493-FE-03 网络失败关闭重开，原键重提', async ({ page }) => {
  const server = await setupExits(page, [importButton]);
  const posts = await routeImport(page, server, true);
  await page.getByRole('button', { name: ENTRY, exact: true }).click();
  let modal = await upload(page);
  await modal.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(modal.getByRole('button', { name: '按原命令重新提交' })).toBeVisible();
  await modal.getByRole('button', { name: /^关\s*闭$/ }).click();
  await page.getByRole('button', { name: ENTRY, exact: true }).click();
  modal = page.getByRole('dialog').filter({ hasText: ENTRY });
  await expect(modal.getByLabel('选择 Excel 文件')).toBeDisabled();
  await modal.getByRole('button', { name: '按原命令重新提交' }).click();
  await expect(modal).toHaveCount(0);
  expect(posts[1]).toEqual(posts[0]);
});

test('模板以 blob 下载，文件名取响应头，26 列仅表头', async ({ page }) => {
  await setupExits(page, [importButton]);
  const bytes = await buildXlsx([importHeader]);
  let tenant: string | undefined;
  await page.route('**/api/tenant/employment/exits/import/template', (route) => {
    tenant = route.request().headers()['x-tenant-id'];
    return route.fulfill({
      body: Buffer.from(bytes),
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('后端模板.xlsx')}`,
      },
    });
  });
  await page.getByRole('button', { name: ENTRY, exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载模板', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('后端模板.xlsx');
  expect(tenant).toBeTruthy();
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
});

test('没有导入权限时隐藏入口', async ({ page }) => {
  await setupExits(page);
  await expect(page.locator('.exit-card').getByRole('row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: ENTRY })).toHaveCount(0);
});
