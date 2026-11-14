// F-493 S4c AC-DM-30-F493-FE-12：真后端导入 2 行（1 行 D 列无效）→ 导入历史页看到该批 → 两个下载读回。
// 后端为 f493-live-server.mjs 的隔离库与真实执行器；列名对照模板接口下载件，不另抄一份。
import { test, expect } from './fixtures.js';
import { setupExits } from './exit-list-fixtures.js';
import { importHeader, requiredRows } from './exit-import-fixtures.js';
import { forwardImport, readDownload, spawnImportBackend, uploadImport, type LiveManifest } from './f493-live-spawn.js';
import { readXlsx } from '../src/exit/xlsx-reader.js';

let backend: Awaited<ReturnType<typeof spawnImportBackend>> | undefined;
let manifest: LiveManifest;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = await spawnImportBackend();
  manifest = backend.manifest;
});
test.afterAll(async () => {
  await backend?.stop();
});

test('FE-12 真后端导入后在导入历史看到结果，错误报告与导入附件读回', async ({ page }) => {
  test.setTimeout(120_000);
  await setupExits(page, [{ buttonCode: 'Employment.DimissionImport', level: 'list' }]);
  const requests = await forwardImport(page, manifest);
  const rows = requiredRows(2);
  rows[0]![3] = manifest.departmentCode;
  rows[1]![3] = 'SYNTHETIC-MISSING';
  await uploadImport(page, manifest, [importHeader, ...rows], '合成历史往返.xlsx');

  await page.getByRole('menuitem', { name: '导入历史', exact: true }).click();
  await expect(page).toHaveURL(/\/exit-import-history$/);
  const table = page.locator('.exit-import-history table');
  await expect(table.locator('thead th')).toHaveText([
    '导入类型',
    '导入时间',
    '导入者',
    '状态',
    '导入结果',
    '附件',
    '导入附件',
  ]);
  const row = table.locator('tbody tr.ant-table-row').filter({ hasText: '合成历史往返.xlsx' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(0)).toHaveText('离职人员');
  await expect(row.locator('td').nth(3)).toHaveText('成功');
  await expect(row.locator('td').nth(4)).toHaveText('尝试导入2条记录，出现1个错误。');

  const reportEvent = page.waitForEvent('download');
  await row.getByRole('button', { name: '下载导入错误报告', exact: true }).click();
  const report = await readDownload(await reportEvent);
  expect(report.rows).toHaveLength(2);
  expect(report.rows[1]!.cells[3]).toBe('SYNTHETIC-MISSING');

  const sourceEvent = page.waitForEvent('download');
  await row.getByRole('button', { name: '合成历史往返.xlsx', exact: true }).click();
  const sourceDownload = await sourceEvent;
  expect(sourceDownload.suggestedFilename()).toBe('合成历史往返.xlsx');
  const source = await readDownload(sourceDownload);
  const template = await page.request.get(`${manifest.url}/api/tenant/employment/exits/import/template`);
  expect(template.ok()).toBe(true);
  const header = (await readXlsx(new Uint8Array(await template.body()))).rows[0]!.cells;
  expect(source.rows[0]!.cells).toEqual(header);
  expect(source.rows.slice(1).map((item) => item.cells[1])).toEqual(['合成1', '合成2']);
  expect(await page.locator('body').textContent()).not.toMatch(/\b(running|succeeded|failed|EXIT_[A-Z_]+)\b/);
  expect(requests.filter((item) => item.path.endsWith('/batches')).map((item) => item.status)).toContain(200);
});
