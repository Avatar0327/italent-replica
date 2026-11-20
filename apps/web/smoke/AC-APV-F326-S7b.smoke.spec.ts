/**
 * F-326 S7b 浏览器集成（AC-APV-F326-39）：真实后端（隔离库 + 合成数据）+ 真实浏览器。
 * 全部 /api/tenant/** 代理到 f326s7b-live-server（真实 Hono、真实权限快照与授权、真实 S7a 自动变量与发布校验）。
 * 设计器把本流程的自动变量回显为“指定人员”；发布被“指定人员未选择”拒时标出节点；待生效冲突弹窗选值后重新发布。
 * 变量页（DEC-941）：“来源”列、自动变量锁定字段置灰、重新启用后的再停用提示。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

interface Manifest {
  url: string;
  tenant: string;
  admin: string;
  processes: { echo: string; pending: string };
  variable: string;
  variables: { sourced: string; stopped: string };
}
const REQUIRED = '节点「合成人事审批」的指定人员未选择，请选择人员后再发布';
let backend: ChildProcess;
let manifest: Manifest;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f326s7b-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  manifest = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    backend.stderr!.on('data', (part) => {
      errors += String(part);
    });
    backend.stdout!.on('data', (part) => {
      output += String(part);
      const ready = output.split('\n').find((line) => line.startsWith('F326S7B_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F326S7B_READY '.length)));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F326S7b backend exited ${code}: ${errors}`)));
  });
});
test.afterEach(async ({ context, page }) => {
  // 发布后设计器重读人员（批量 person-candidates）；等这批请求回填完再撤路由，避免 wait 卡在半途的路由上
  await page.waitForLoadState('networkidle');
  await context.unrouteAll({ behavior: 'wait' });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

/** Cookie 定租户与用户，代理按同一身份给真实后端签名；记下发布请求的请求体与幂等键。 */
async function signIn(context: BrowserContext, baseURL: string) {
  const publishes: { body: unknown; key: string | undefined }[] = [];
  await context.addCookies([
    { name: 'italent_demo_tenant', value: manifest.tenant, url: baseURL },
    { name: 'italent_demo_user', value: manifest.admin, url: baseURL },
  ]);
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/publish'))
      publishes.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    const response = await context.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), 'x-smoke-user': manifest.admin },
      data: request.postDataBuffer() ?? undefined,
    });
    // 设计器读人员时会中止被替换的旧请求（AbortController）；已被浏览器取消的路由不再回填，其余错误照常抛出
    await route.fulfill({ response }).catch((error: unknown) => {
      if (!String(error).includes('Route is already handled')) throw error;
    });
  });
  return publishes;
}
const processPath = (id: string) => `/config-center/workflow/processes/${id}`;
const nodeButton = (page: Page, name: string) =>
  page.getByRole('navigation', { name: '流程节点' }).getByRole('button').filter({ hasText: name });
const visibleText = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true });

test('AC-APV-F326-39-S01 指定人员回显 + 编码 + 引用数；发布被“指定人员未选择”拒时标出节点、同句提示', async ({
  context,
  page,
  baseURL,
}) => {
  const publishes = await signIn(context, baseURL!);
  await page.goto(processPath(manifest.processes.echo));
  await expect(visibleText(page, /^指定人员：合成乙/)).toBeVisible();
  await expect(page.locator('.flow-auto-code').filter({ visible: true })).toHaveText(/^Global\.B\./);
  await expect(visibleText(page, '该变量被 1 个流程引用')).toBeVisible();
  await nodeButton(page, '合成人事审批').click();
  await expect(visibleText(page, '指定人员：未选择')).toBeVisible();
  await nodeButton(page, '合成上级审批').click();

  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.locator('.flow-source-group .ant-alert-error').filter({ visible: true })).toHaveText(REQUIRED);
  await expect(page.locator('[data-node-missing="true"]')).toHaveText(/合成人事审批/);
  await expect(nodeButton(page, '合成人事审批')).toHaveAttribute('aria-current', 'true');
  expect(publishes).toHaveLength(1);
});

test('AC-APV-F326-39-S02 待生效值标“发布后生效”；待生效冲突弹窗列两边值，选设计器值以新命令 ID 重发后发布', async ({
  context,
  page,
  baseURL,
}) => {
  const publishes = await signIn(context, baseURL!);
  await page.goto(processPath(manifest.processes.pending));
  await nodeButton(page, '合成人事审批').click();
  await expect(visibleText(page, /^指定人员：合成待改选人/)).toBeVisible();
  await expect(visibleText(page, '发布后生效')).toBeVisible();

  await page.getByRole('button', { name: '发布', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(manifest.variable);
  await expect(dialog).toContainText('设计器值');
  await expect(dialog).toContainText('合成待改选人');
  await expect(dialog).toContainText('变量页当前值');
  await expect(dialog).toContainText('合成变量页改的人');
  await dialog.getByText('采用设计器值', { exact: true }).click();
  await dialog.getByRole('button', { name: '确认发布' }).click();
  await expect(visibleText(page, '流程已发布')).toBeVisible();
  expect(publishes).toHaveLength(2);
  expect(publishes[1]!.body).toMatchObject({ pendingResolutions: [{ choice: 'designer' }] });
  expect(publishes[1]!.key).not.toBe(publishes[0]!.key);
});

test('AC-APV-F326-39-S03 变量页：来源列显示自动（流程名 · 节点名）；自动变量适用范围置灰；重新启用后提示可能再停用', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!);
  await page.goto('/config-center/global/public-variables');
  const sourced = page.getByRole('row').filter({ hasText: manifest.variables.sourced });
  await expect(sourced).toContainText('自动（合成指定人员流程 · 合成上级审批）');
  await sourced.getByRole('button', { name: '编辑' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('自动（合成指定人员流程 · 合成上级审批）');
  const usage = dialog.locator('.ant-form-item').filter({ hasText: '适用范围' });
  await expect(usage.locator('input[type="radio"]').first()).toBeDisabled();
  await dialog.getByRole('button', { name: /取\s*消/ }).click();

  await page.getByRole('tab', { name: '停用的公共变量' }).click();
  const stopped = page.getByRole('row').filter({ hasText: manifest.variables.stopped });
  await stopped.getByRole('button', { name: '启用' }).click();
  await page.locator('.ant-popover').filter({ visible: true }).getByRole('button').last().click();
  await expect(
    visibleText(page, /已启用。若该自动变量已无流程引用，下次保存来源流程「合成指定人员流程」时会再次停用/),
  ).toBeVisible();
});
