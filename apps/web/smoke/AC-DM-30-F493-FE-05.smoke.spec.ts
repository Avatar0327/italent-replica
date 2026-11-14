import { test, expect } from './fixtures.js';
import { setupExits } from './exit-list-fixtures.js';
import { importHeader, requiredRows } from './exit-import-fixtures.js';
import { forwardImport, readDownload, spawnImportBackend, uploadImport, type LiveManifest } from './f493-live-spawn.js';

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

test('FE-05 真后端错误文件下载、保留 A 列改正 D 列再上传、零错误无链接', async ({ page }) => {
  test.setTimeout(120_000);
  await setupExits(page, [{ buttonCode: 'Employment.DimissionImport', level: 'list' }]);
  const requests = await forwardImport(page, manifest);
  const upload = (sheet: (string | number | null)[][], name: string) => uploadImport(page, manifest, sheet, name);
  const rows = requiredRows(1);
  rows[0]![3] = 'SYNTHETIC-MISSING';
  await upload([importHeader, ...rows], '合成失败.xlsx');
  await page.getByRole('button', { name: '消息', exact: true }).click();
  const drawer = page.locator('.message-drawer');
  await expect(drawer).toContainText('合成失败.xlsx导入已结束，出现1个错误。');
  const downloaded = page.waitForEvent('download');
  await drawer.getByRole('button', { name: '查看详情', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('下载导入错误报告.xlsx');
  const sheet = await readDownload(download);
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[1]!.cells[0]).toBe('[*部门编码]：*部门编码【SYNTHETIC-MISSING】不存在或者已被删除，请检查');
  sheet.rows[1]!.cells[3] = manifest.departmentCode;
  await drawer.locator('.ant-drawer-close').click();
  await upload(
    sheet.rows.map((row) => row.cells),
    '合成改正.xlsx',
  );
  await page.getByRole('button', { name: '消息', exact: true }).click();
  const clean = drawer.locator('article').filter({ hasText: '合成改正.xlsx' });
  await expect(clean).toContainText('出现0个错误。');
  await expect(clean.getByRole('button', { name: '查看详情' })).toHaveCount(0);
  expect(requests.filter((item) => item.path.endsWith('/import')).map((item) => item.status)).toEqual([202, 202]);
  expect(requests.some((item) => item.path.endsWith('/error-file') && item.status === 200)).toBe(true);
});
