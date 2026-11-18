import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
interface Manifest {
  url: string;
  tenantId: string;
  serial: string;
  password: string;
  wrong: string;
}
let backend: ChildProcess;
let manifest: Manifest;
test.describe.configure({ mode: 'serial' });
// 合成凭据仍不写 trace；网络与字段值只在测试进程内存中。
test.use({ trace: 'off' });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f397-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  manifest = await new Promise<Manifest>((resolve, reject) => {
    let errors = '';
    backend.stderr!.on('data', (part) => {
      errors += String(part);
    });
    backend.once('message', (message) => resolve(message as Manifest));
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F397 后端退出 ${code}: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});
test.beforeEach(async ({ context, request }) => {
  await request.post(`${manifest.url}/__smoke/reset-clock`);
  await context.route('**/api/survey360/portal**', async (route) => {
    const req = route.request();
    const response = await request.fetch(`${manifest.url}${new URL(req.url()).pathname}`, {
      method: req.method(),
      headers: req.headers(),
      data: req.postDataBuffer() ?? undefined,
    });
    await route.fulfill({ response });
  });
});
test.afterEach(async ({ context }) => {
  await context.unrouteAll({ behavior: 'wait' });
});
async function login(page: Page, wrong = false) {
  await page.goto(`/survey360/portal/${manifest.tenantId}`);
  await expect(page.getByRole('heading', { name: '360 评估作答' })).toBeVisible();
  await page.getByLabel('序列号', { exact: true }).fill(manifest.serial);
  await page.getByLabel('密码', { exact: true }).fill(wrong ? manifest.wrong : manifest.password);
  await page.getByRole('button', { name: /登\s*录/, exact: true }).click();
}
test('AC-360-F397-01 登录成功后保存并提交真实答卷', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '开始评价', exact: true }).first().click();
  const groups = page.getByRole('radiogroup');
  await expect(groups.first()).toBeVisible();
  for (let i = 0; i < (await groups.count()); i += 1) await groups.nth(i).getByRole('radio').first().check();
  await page.getByRole('button', { name: '立即保存', exact: true }).click();
  await expect(page.getByText('保存成功', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提交作答', exact: true }).click();
  await expect(page.getByText('提交成功', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('您已完成了全部评价，感谢参与！', { exact: true })).toBeVisible();
});
test('AC-360-F397-02 错误凭据统一拒绝且可改正', async ({ page }) => {
  await login(page, true);
  await expect(page.getByText('您输入的密码和序列号不匹配，请重新输入', { exact: true })).toBeVisible();
  await expect(page.getByLabel('序列号', { exact: true })).toHaveValue(manifest.serial);
  await expect(page.getByRole('button', { name: /登\s*录/, exact: true })).toBeEnabled();
});
test('AC-360-F397-03 服务端八小时过期返回登录页并清除会话', async ({ page, request }) => {
  await login(page);
  await expect(page.getByText('您已完成了全部评价，感谢参与！', { exact: true })).toBeVisible();
  await request.post(`${manifest.url}/__smoke/expire`);
  await page.reload();
  await expect(page.getByText('作答会话已失效，请重新登录', { exact: true })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('survey360.portal.'))),
  ).toEqual([]);
});
