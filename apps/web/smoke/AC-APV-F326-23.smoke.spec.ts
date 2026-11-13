/**
 * F-326 F1 浏览器集成（AC-APV-F326-22 / 23）：真实后端（隔离库 + 合成数据）+ 真实浏览器。
 * 全部 /api/tenant/** 代理到 f326f1-live-server（真实 Hono、真实权限快照与授权），不造业务响应、不造快照。
 * 持有「流程矩阵」菜单的 HR：两个页签、新建 / 编辑 / 启用 / 停用、查看引用、停用前确认；普通成员：看不到入口。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

interface Manifest {
  url: string;
  tenant: string;
  admin: string;
  member: string;
  referenced: { id: string; code: string };
}
const PUBLIC_PATH = '/config-center/global/public-variables';
const TRANSFER_PATH = '/config-center/apps/transfer/workflow/app-variables-transfer';
const WARNING = '以下流程引用了该变量，停用后这些节点将视为审批人为空，按节点空人策略处理';
const VARIABLES = /\/api\/tenant\/approval\/variables/;
let backend: ChildProcess;
let manifest: Manifest;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f326f1-live-server.mjs', import.meta.url))], {
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
      const ready = output.split('\n').find((line) => line.startsWith('F326F1_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F326F1_READY '.length)));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F326F1 backend exited ${code}: ${errors}`)));
  });
});
// 上一项结束时可能仍有代理请求在途，卸载路由避免其在下一项里报错
test.afterEach(async ({ context }) => {
  await context.unrouteAll({ behavior: 'ignoreErrors' });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

/** 一个浏览器上下文 = 一个身份：Cookie 定租户与用户，代理按同一身份给真实后端签名；记下变量接口的请求。 */
async function signIn(context: BrowserContext, baseURL: string, userId: string) {
  const calls: string[] = [];
  await context.addCookies([
    { name: 'italent_demo_tenant', value: manifest.tenant, url: baseURL },
    { name: 'italent_demo_user', value: userId, url: baseURL },
  ]);
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (VARIABLES.test(url.pathname)) calls.push(`${request.method()} ${url.pathname}${url.search}`);
    const response = await context.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), 'x-smoke-user': userId },
      data: request.postDataBuffer() ?? undefined,
    });
    return route.fulfill({ response });
  });
  return calls;
}

const row = (page: Page, code: string) => page.locator('tbody tr').filter({ hasText: code });
const dialog = (page: Page) => page.locator('.ant-modal:visible').last();
const ok = (scope: Locator) => scope.getByRole('button', { name: /^确\s*定$/ });
async function save(page: Page) {
  const form = dialog(page);
  await form.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(form).toBeHidden();
}
async function create(page: Page, suffix: string, name: string) {
  await page.getByRole('button', { name: /^新\s*建$/ }).click();
  const form = dialog(page);
  await form.locator('[id$="codeSuffix"]').fill(suffix);
  await form.locator('[id$="name"]').first().fill(name);
  await save(page);
}

test('AC-APV-F326-22/23 持有流程矩阵菜单：公共变量两页签、增改启停、查看引用、停用前确认', async ({
  context,
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await signIn(context, baseURL!, manifest.admin);
  await page.goto(PUBLIC_PATH);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: '公共变量', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '启用的公共变量' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '停用的公共变量' })).toBeVisible();
  await expect(
    page.getByText('当前页面展示草稿状态、启用状态的公共变量，各应用可使用列表展示的启用状态公共变量。'),
  ).toBeVisible();
  const referenced = row(page, manifest.referenced.code);
  await expect(referenced).toContainText('合成被引用变量');
  await expect(referenced).toContainText('启用');

  await create(page, 'SmokeNew', '合成冒烟变量');
  const fresh = row(page, 'Global.B.SmokeNew');
  await expect(fresh).toContainText('草稿');
  await expect(fresh).toContainText('全部');

  await fresh.getByRole('button', { name: /^编\s*辑$/ }).click();
  await dialog(page).locator('[id$="name"]').first().fill('合成冒烟变量改');
  await save(page);
  await expect(fresh).toContainText('合成冒烟变量改');

  await fresh.getByRole('button', { name: /^启\s*用$/ }).click();
  await ok(page.locator('.ant-popover:visible')).click();
  await expect(fresh).toContainText('启用');
  await expect(fresh.getByRole('button', { name: /^停\s*用$/ })).toBeVisible();

  await referenced.getByRole('button', { name: /更多/ }).click();
  await page.getByRole('menuitem', { name: '查看引用流程' }).click();
  await expect(dialog(page)).toContainText('合成来源流程');
  await dialog(page)
    .getByRole('button', { name: /^关\s*闭$/ })
    .click();

  await referenced.getByRole('button', { name: /^停\s*用$/ }).click();
  await expect(dialog(page)).toContainText(WARNING);
  await expect(dialog(page)).toContainText('合成来源流程');
  await ok(dialog(page)).click();
  await expect(referenced).toHaveCount(0);

  await fresh.getByRole('button', { name: /^停\s*用$/ }).click();
  await expect(dialog(page)).toContainText('确定停用公共变量「合成冒烟变量改」吗？');
  await ok(dialog(page)).click();
  await expect(fresh).toHaveCount(0);

  await page.getByRole('tab', { name: '停用的公共变量' }).click();
  await expect(row(page, manifest.referenced.code)).toContainText('停用');
  await expect(row(page, 'Global.B.SmokeNew')).toBeVisible();
  await row(page, manifest.referenced.code)
    .getByRole('button', { name: /^启\s*用$/ })
    .click();
  await ok(page.locator('.ant-popover:visible')).click();
  await expect(row(page, manifest.referenced.code)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /删\s*除/ })).toHaveCount(0);
});

test('AC-APV-F326-22/23 应用变量：按路由应用读写，调动管理下新建后只在本应用可见', async ({
  context,
  page,
  baseURL,
}) => {
  const calls = await signIn(context, baseURL!, manifest.admin);
  await page.goto(TRANSFER_PATH);
  await expect(page.getByRole('tab', { name: '启用的应用变量' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '停用的应用变量' })).toBeVisible();
  await expect(
    page.getByText('当前页面展示草稿状态、启用状态的应用变量，本应用可使用列表展示的启用状态应用变量'),
  ).toBeVisible();
  await create(page, 'SmokeApp', '合成调动应用变量');
  await expect(row(page, 'B.SmokeApp')).toContainText('草稿');
  expect(calls.some((call) => call.startsWith('GET') && call.includes('appId=transfer'))).toBe(true);
  await page.goto('/config-center/workflow/app-variables-staff');
  await expect(page.getByRole('tab', { name: '启用的应用变量' })).toBeVisible();
  await expect(page.locator('tbody')).not.toContainText('B.SmokeApp');
});

test('AC-APV-F326-22 无流程矩阵菜单的成员：目录不出现变量入口，直达路径无权且不读变量接口', async ({
  context,
  page,
  baseURL,
}) => {
  const calls = await signIn(context, baseURL!, manifest.member);
  await page.goto('/config-center');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('link', { name: '公共变量', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '应用变量', exact: true })).toHaveCount(0);
  for (const path of [PUBLIC_PATH, TRANSFER_PATH]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('tab', { name: /公共变量|应用变量/ })).toHaveCount(0);
  }
  expect(calls).toEqual([]);
});
