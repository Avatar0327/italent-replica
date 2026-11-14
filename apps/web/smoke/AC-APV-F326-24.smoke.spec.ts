/**
 * F-326 F2a 浏览器集成（AC-APV-F326-22 子项、AC-APV-F326-24）：真实后端（隔离库 + 合成数据）+ 真实浏览器。
 * 矩阵接口与权限快照一律代理到 f326f2a-live-server（真实 Hono、真实授权引擎），不造业务响应；
 * 权限快照也来自真实后端（DEC-907：matrix.manage 登记 process_matrix 读写能力）：
 * 持有者一例用合成矩阵管理员，非持有者一例用无企业管理员身份的合成员工，验证入口隐藏与直达无权。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

interface Manifest {
  url: string;
  tenant: string;
  user: string;
  outsider: string;
  used: { id: string; code: string };
  idle: { id: string; code: string };
  process: string;
}
interface Call {
  method: string;
  path: string;
  status: number;
  key: string | undefined;
  body: unknown;
}

const MATRICES = '/api/tenant/approval/matrices';
let backend: ChildProcess;
let manifest: Manifest;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f326f2a-live-server.mjs', import.meta.url))], {
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
      const ready = output.split('\n').find((line) => line.startsWith('F2A_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F2A_READY '.length)));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F2a backend exited ${code}: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

/** 浏览器的 /api/tenant/** 全部转到真实后端；记录矩阵写请求的方法、路径、状态与命令 ID。 */
async function live(context: BrowserContext, baseURL: string, user = manifest.user) {
  await context.addCookies([
    { name: 'italent_demo_tenant', value: manifest.tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  const calls: Call[] = [];
  /** 每次权限快照里的 matrix.manage 项（一次快照一个数组）。 */
  const menus: unknown[][] = [];
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.headers()['x-tenant-id']).toBe(manifest.tenant);
    const response = await context.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), 'x-f2a-user': user },
      data: request.postData() ?? undefined,
    });
    if (url.pathname.startsWith(MATRICES))
      calls.push({
        method: request.method(),
        path: url.pathname,
        status: response.status(),
        key: request.headers()['idempotency-key'],
        body: request.postDataJSON() as unknown,
      });
    if (url.pathname.endsWith('/permission/me/snapshot')) {
      const json = (await response.json()) as { adminMenus: { code: string }[] };
      menus.push(json.adminMenus.filter((menu) => menu.code === 'matrix.manage'));
    }
    return route.fulfill({ response });
  });
  return { calls, menus };
}

/** antd 两个汉字的按钮会插入空格（“保 存”）。 */
const two = (name: string) => new RegExp(`^${[...name].join('\\s*')}$`);
/** 等 antd 弹窗出场动画结束再点（动画中点击可能落空）。 */
async function confirm(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).not.toHaveClass(/ant-zoom-(appear|enter)/);
  await dialog.getByRole('button', { name: two('确定') }).click();
}
const list = (page: Page) => page.locator('.matrix-list');
const head = (page: Page) => page.locator('.matrix-head');
const row = (page: Page, name: string) => list(page).locator('tbody tr', { hasText: name });

/** 新建（去首尾空格、默认草稿）与编辑头部（编码只读、只发改动字段与 revision）。 */
async function createAndEdit(page: Page, calls: Call[]) {
  const lastWrite = () => calls.filter((call) => call.method !== 'GET').at(-1);
  // 新建：名称去首尾空格，默认草稿；保存后选中新矩阵
  await list(page).getByRole('button', { name: '新建矩阵' }).click();
  const form = page.getByRole('dialog');
  await form.locator('#name').fill('  合成冒烟矩阵  ');
  await form.locator('#code').fill('F2A_SMOKE');
  await form.getByRole('button', { name: two('保存') }).click();
  await expect(form).toBeHidden();
  await expect(head(page)).toContainText('合成冒烟矩阵');
  await expect(head(page)).toContainText('F2A_SMOKE');
  await expect(head(page)).toContainText('草稿');
  const created = calls.find((call) => call.method === 'POST' && call.path === MATRICES)!;
  expect(created).toMatchObject({ status: 201, body: { name: '合成冒烟矩阵', code: 'F2A_SMOKE', enable: false } });
  expect(created.key).toBeTruthy();

  // 编辑：编码只读，只发改动字段与 revision
  await head(page)
    .getByRole('button', { name: two('编辑') })
    .click();
  await expect(form.locator('#code')).toHaveCount(0);
  await expect(form).toContainText('F2A_SMOKE');
  await form.locator('#description').fill('合成冒烟描述');
  await form.getByRole('button', { name: two('保存') }).click();
  await expect(form).toBeHidden();
  await expect(head(page)).toContainText('合成冒烟描述');
  expect(lastWrite()).toMatchObject({
    method: 'PATCH',
    status: 200,
    body: { description: '合成冒烟描述', revision: 1 },
  });
}

test('AC-APV-F326-24 持有者：列表、新建 / 编辑头部、查看引用、停用前影响确认、启停，全部走真实后端', async ({
  page,
  context,
  baseURL,
}) => {
  const { calls, menus } = await live(context, baseURL!);
  const lastWrite = () => calls.filter((call) => call.method !== 'GET').at(-1);
  await page.goto('/settings');
  await page.getByRole('button', { name: '流程矩阵', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/menu\/matrix\.manage$/);
  expect(menus.flat()).toContainEqual({
    code: 'matrix.manage',
    path: '流程矩阵/矩阵管理',
    implemented: true,
    editable: true,
  });
  await expect(row(page, '合成被引用矩阵')).toBeVisible();
  await expect(row(page, '合成空闲矩阵')).toContainText('草稿');

  await createAndEdit(page, calls);

  // 启用草稿
  await head(page)
    .getByRole('button', { name: two('启用') })
    .click();
  await expect(page.getByRole('dialog')).toContainText('确定启用矩阵「合成冒烟矩阵」吗');
  await confirm(page);
  await expect(head(page).locator('.ant-descriptions')).toContainText('启用');
  expect(lastWrite()).toMatchObject({ method: 'POST', status: 200, body: { revision: 2 } });
  expect(lastWrite()!.path).toMatch(/\/enable$/);

  // 查看引用：被已发布流程引用
  await row(page, '合成被引用矩阵').click();
  await head(page).getByRole('button', { name: '查看引用' }).click();
  const refs = page.getByRole('dialog');
  await expect(refs).toContainText('引用流程：合成被引用矩阵');
  await expect(refs).toContainText(manifest.process);
  await expect(refs).toContainText('合成矩阵节点');
  await expect(refs).toContainText('当前 v1');
  // 被引用的角色列按真实详情的列名显示（S4 夹具角色列名为“角色”）
  await expect(refs.getByRole('columnheader', { name: '角色列' })).toBeVisible();
  await expect(refs.getByRole('cell', { name: '角色', exact: true })).toBeVisible();
  await refs.getByRole('button', { name: 'Close' }).click();

  // 停用前影响清单：确认后带引用数提交，切到“停用的”
  await head(page)
    .getByRole('button', { name: two('停用') })
    .click();
  const impact = page.getByRole('dialog');
  await expect(impact).toContainText('以下流程引用了该矩阵，停用后这些节点将视为审批人为空，按节点空人策略处理');
  await expect(impact).toContainText('合成矩阵节点');
  await confirm(page);
  await expect(page.getByRole('tab', { name: '停用的', selected: true })).toBeVisible();
  await expect(row(page, '合成被引用矩阵')).toContainText('停用');
  expect(lastWrite()).toMatchObject({
    path: `${MATRICES}/${manifest.used.id}/disable`,
    status: 200,
    body: { acknowledgedReferenceCount: 1 },
  });

  // 刷新后仍在矩阵页；在“停用的”里启用回到“启用的”
  await page.reload();
  await page.getByRole('tab', { name: '停用的' }).click();
  await row(page, '合成被引用矩阵').click();
  await head(page)
    .getByRole('button', { name: two('启用') })
    .click();
  await confirm(page);
  await expect(page.getByRole('tab', { name: '启用的', selected: true })).toBeVisible();
  await expect(head(page)).toContainText('合成被引用矩阵');

  // 无引用矩阵停用：普通确认，acknowledgedReferenceCount 为 0
  await row(page, '合成冒烟矩阵').click();
  await head(page)
    .getByRole('button', { name: two('停用') })
    .click();
  await expect(page.getByRole('dialog')).toContainText('确定停用矩阵「合成冒烟矩阵」吗');
  await confirm(page);
  await expect(page.getByRole('tab', { name: '停用的', selected: true })).toBeVisible();
  expect(lastWrite()).toMatchObject({ status: 200, body: { acknowledgedReferenceCount: 0 } });

  // 每个写请求都带命令 ID、互不相同；全部成功
  const writes = calls.filter((call) => call.method !== 'GET');
  expect(writes.map((call) => call.status).every((status) => status < 300)).toBe(true);
  expect(new Set(writes.map((call) => call.key)).size).toBe(writes.length);
});

test('AC-APV-F326-22 非持有者（无 process_matrix）：企业设置不出现「流程矩阵」，直达无权且不请求矩阵接口', async ({
  page,
  context,
  baseURL,
}) => {
  const { calls, menus } = await live(context, baseURL!, manifest.outsider);
  await page.goto('/settings');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: '流程矩阵', exact: true })).toHaveCount(0);
  await page.goto('/settings/menu/matrix.manage');
  await expect(page.getByText('暂无访问权限')).toBeVisible();
  expect(calls).toEqual([]);
  expect(menus.length).toBeGreaterThan(0);
  expect(menus.flat()).toEqual([]);
});
