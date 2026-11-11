import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { setupExits } from './exit-list-fixtures.js';
import { buildXlsx, importHeader, requiredRows } from './exit-import-fixtures.js';
import { readXlsx } from '../src/exit/xlsx-reader.js';

let backend: ChildProcess;
let manifest: { url: string; departmentCode: string };
test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f493-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '--conditions=@italent/source' },
  });
  manifest = await new Promise((resolve, reject) => {
    let output = '';
    backend.stdout!.on('data', (chunk) => {
      output += String(chunk);
      const line = output.split('\n').find((item) => item.startsWith('F493_READY '));
      if (line) resolve(JSON.parse(line.slice('F493_READY '.length)));
    });
    backend.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    backend.on('exit', (code) => reject(new Error(`后端启动退出 ${code}\n${output}`)));
  });
});
test.afterAll(async () => {
  if (backend && backend.exitCode === null) {
    const done = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
    backend.kill('SIGTERM');
    await done;
  }
});

test('FE-05 真后端错误文件下载、保留 A 列改正 D 列再上传、零错误无链接', async ({ page }) => {
  test.setTimeout(120_000);
  await setupExits(page, [{ buttonCode: 'Employment.DimissionImport', level: 'list' }]);
  const requests: { path: string; status: number }[] = [];
  await page.route(/\/api\/tenant\/(employment\/exits\/import|approval\/notifications)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await page.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: request.headers(),
      data: request.postDataBuffer() ?? undefined,
    });
    requests.push({ path: url.pathname, status: response.status() });
    await route.fulfill({ response });
  });
  const upload = async (sheet: (string | number | null)[][], name: string) => {
    await page.getByRole('button', { name: '导入历史离职人员', exact: true }).click();
    const modal = page.getByRole('dialog').filter({ hasText: '导入历史离职人员' });
    await modal.getByLabel('选择 Excel 文件').setInputFiles({
      name,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await buildXlsx(sheet)),
    });
    await expect(modal.getByRole('button', { name: /^保\s*存$/ })).toBeEnabled();
    await modal.getByRole('button', { name: /^保\s*存$/ }).click();
    await expect(modal).toHaveCount(0);
    expect((await page.request.get(`${manifest.url}/__smoke/idle`)).ok()).toBe(true);
  };
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
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const sheet = await readXlsx(new Uint8Array(Buffer.concat(chunks)));
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[1]!.cells[0]).toBe('[*部门编码]：*部门编码【SYNTHETIC-MISSING】不存在或者已被删除，请检查');
  sheet.rows[1]!.cells[3] = manifest.departmentCode;
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
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
