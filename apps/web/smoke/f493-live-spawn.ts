import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Download, Page } from '@playwright/test';
import { expect } from './fixtures.js';
import { buildXlsx, type Cell } from './exit-import-fixtures.js';
import { readXlsx } from '../src/exit/xlsx-reader.js';

export type LiveManifest = { url: string; departmentCode: string };

/** F-493 真后端冒烟共用：子进程起隔离库与真实执行器，读到 F493_READY 行后返回清单。 */
export async function spawnImportBackend(): Promise<{ manifest: LiveManifest; stop(): Promise<void> }> {
  const backend: ChildProcess = spawn(
    process.execPath,
    [fileURLToPath(new URL('./f493-live-server.mjs', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '--conditions=@italent/source' } },
  );
  const manifest = await new Promise<LiveManifest>((resolve, reject) => {
    let output = '';
    backend.stdout!.on('data', (chunk) => {
      output += String(chunk);
      const line = output.split('\n').find((item) => item.startsWith('F493_READY '));
      if (line) resolve(JSON.parse(line.slice('F493_READY '.length)) as LiveManifest);
    });
    backend.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    backend.on('exit', (code) => reject(new Error(`后端启动退出 ${code}\n${output}`)));
  });
  return {
    manifest,
    async stop() {
      if (backend.exitCode !== null) return;
      const done = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
      backend.kill('SIGTERM');
      await done;
    },
  };
}

/** 把导入接口与消息接口转给真后端；返回逐次记录的路径与状态。须在 setupExits 之后挂，后挂的路由优先。 */
export async function forwardImport(page: Page, manifest: LiveManifest) {
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
  return requests;
}

/** 在离职管理页经「导入历史离职人员」弹窗上传并保存，等执行器空闲。 */
export async function uploadImport(page: Page, manifest: LiveManifest, sheet: Cell[][], name: string) {
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
}

/** 读回 Playwright 下载的 xlsx。 */
export async function readDownload(download: Download) {
  const chunks: Buffer[] = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk as Buffer);
  return readXlsx(new Uint8Array(Buffer.concat(chunks)));
}
