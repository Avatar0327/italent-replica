import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { addExit, setupExits, type ExitServer } from './exit-list-fixtures.js';
import {
  buildXlsx,
  confirmationRequired,
  importReceipt,
  importRows,
  importSheet,
  previewWarned,
} from './exit-import-fixtures.js';

// AC-DM-30-19（对应设计 AC-DM-30-13；该编号已被 F-139a 后端占用）：历史离职人员导入的浏览器冒烟。
// 列表 / 详情沿用 exit-list-fixtures 的合成服务端；两条导入路由在这里后注册（Playwright 后注册的先匹配）。
const ENTRY = '导入历史离职人员';
const importButton = { buttonCode: 'Employment.DimissionImport', level: 'list' };
const list = (page: Page) => page.locator('.exit-card');
const rowOf = (page: Page, name: string) => list(page).getByRole('row').filter({ hasText: name });

/** 预览按 previewExitImport 形态回；导入未确认回 409 CONFIRMATION_REQUIRED，确认后按 importExits 落成已生效、办理方式 import。 */
async function routeImport(page: Page, server: ExitServer) {
  const posts: { path: string; body: Record<string, unknown>; key: string | undefined }[] = [];
  await page.route(/\/api\/tenant\/employment\/exits\/import(\/preview)?$/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/tenant/employment', '');
    const body = request.postDataJSON() as { rows: { rowNo: number }[]; confirmed?: boolean };
    posts.push({ path, body, key: request.headers()['idempotency-key'] });
    if (path.endsWith('/preview')) return route.fulfill({ json: previewWarned(body.rows) });
    if (body.confirmed !== true) return route.fulfill({ status: 409, json: confirmationRequired(body.rows) });
    for (const row of importRows) addExit(server, row.name, { status: 'effective', mode: 'import' });
    return route.fulfill({ status: 201, json: importReceipt(body.rows) });
  });
  return posts;
}

test('AC-DM-30-19-01 有导入按钮：上传 → 预览 → 超编确认 → 导入后在“已完成的离职”，办理方式为“导入”', async ({
  page,
}) => {
  const server = await setupExits(page, [importButton]);
  const posts = await routeImport(page, server);
  await page.getByRole('button', { name: ENTRY, exact: true }).click();
  const modal = page.getByRole('dialog').filter({ hasText: ENTRY });
  await modal.getByLabel('选择 Excel 文件').setInputFiles({
    name: '历史离职.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await buildXlsx(importSheet)),
  });
  await expect(modal.getByText('共 2 行：通过 2 行，不通过 0 行，有超编提示 1 行')).toBeVisible();
  await expect(modal.locator('th')).toHaveText(['Excel 行号', '工号', '姓名', '校验结果', '说明']);
  await expect(modal.getByText('2023-04-01 至 2025-07-31 超出编制（峰值 6，编制 5）')).toBeVisible();

  await modal.getByRole('button', { name: /^导\s*入$/ }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: '导入后将超出设定编制，请确认' });
  await confirm.getByRole('button', { name: /确\s*定/ }).click();
  await expect(page.locator('.ant-message').getByText('已导入 2 人', { exact: true })).toBeVisible();
  await expect(modal).toHaveCount(0);

  expect(posts.map((post) => [post.path, post.body.confirmed])).toEqual([
    ['/exits/import/preview', undefined],
    ['/exits/import', undefined],
    ['/exits/import', true],
  ]);
  expect(posts[2]!.body.rows).toEqual(importRows);
  expect(posts[2]!.key).toBeTruthy();
  expect(posts[2]!.key).not.toBe(posts[1]!.key);
  // 导入的单据直接生效：页面已切到“已完成的离职”
  await expect.poll(() => server.queries.at(-1)?.get('view')).toBe('completed');
  await expect(rowOf(page, '合成甲')).toBeVisible();
  await rowOf(page, '合成甲').getByRole('button', { name: '查看详情', exact: true }).click();
  const detail = page.getByRole('dialog').filter({ hasText: '离职管理' });
  await expect(detail.locator('th:has-text("办理方式") + td')).toHaveText('导入');
});

test('AC-DM-30-19-02 没有 Employment.DimissionImport 按钮时列表不显示导入入口', async ({ page }) => {
  await setupExits(page);
  await expect(list(page).getByRole('row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: ENTRY })).toHaveCount(0);
});
