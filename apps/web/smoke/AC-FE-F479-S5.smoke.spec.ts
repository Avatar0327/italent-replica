/**
 * F-479 S5 浏览器集成（AC-FE-ATT-05～08、10）：真实后端（隔离库 + 合成数据）+ 真实浏览器。
 * 业务接口一律代理到 f479-live-server（真实 Hono、真实授权引擎、真实附件存储），不造业务响应；
 * 只有 HR 身份的权限快照 / 对象权限是桩（HR 走验收夹具的受限授权器，真实快照不含任职应用）。
 * 切换租户：本系统演示环境只能改 italent_demo_tenant / italent_demo_user 两个 Cookie 后刷新（PR 记为假设）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { snapshotFixture } from './fixtures.js';

interface Persona {
  tenant: string;
  userId: string;
  employeeId: string;
  hr?: true;
}
interface Manifest {
  url: string;
  a: { tenant: string; employee: Persona; approver: Persona; blind: Persona; hr: Persona; blindInstance: string };
  b: { tenant: string; employee: Persona; draft: string };
  c: { tenant: string; handled: Persona; pending: Persona; instanceId: string; dropped: string; kept: string };
  images: string[];
}
interface ContentRead {
  path: string;
  tenant: string | undefined;
  status: number;
  disposition: string | undefined;
}

const NAMES = ['手写甲.png', '手写乙.png'];
const FIELD = '手写离职申请附件';
// 租户 C 的文件名由夹具 uploads 按序号生成（手写1 = 被删去的 P，手写2 = 留下的 Q）
const NAMES_C = ['手写1.png', '手写2.png'];
const HR_FIELDS = ['id', 'employeeId', 'name', 'code', 'status', 'revision', 'lastWorkDate', 'attachmentRefs'];
const CONTENT = /\/attachments\/[^/]+\/content$/;
let backend: ChildProcess;
let manifest: Manifest;
let exitId = '';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f479-live-server.mjs', import.meta.url))], {
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
      const ready = output.split('\n').find((line) => line.startsWith('F479_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F479_READY '.length)));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F479 backend exited ${code}: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

const personas = () => ({
  employee: { ...manifest.a.employee, tenant: manifest.a.tenant },
  approver: { ...manifest.a.approver, tenant: manifest.a.tenant },
  blind: { ...manifest.a.blind, tenant: manifest.a.tenant },
  hr: { ...manifest.a.hr, tenant: manifest.a.tenant, hr: true as const },
  other: { ...manifest.b.employee, tenant: manifest.b.tenant },
});

/** HR 的权限桩：快照沿用 fixtures 形状（全部应用可见），任职对象只给读与本片要看的字段。 */
function hrPermission(path: string, persona: Persona) {
  if (path.endsWith('/permission/me/snapshot'))
    return {
      ...snapshotFixture,
      session: { ...snapshotFixture.session, tenantId: persona.tenant, userId: persona.userId, employeeId: null },
    };
  if (path.includes('/permission/me/objects/'))
    return {
      objectCode: decodeURIComponent(path.split('/').at(-1)!),
      dataOperations: { read: true },
      viewableFields: HR_FIELDS,
      editableFields: [],
      buttons: [],
    };
  return { items: [], total: 0, hasDataPermission: true };
}

/** 一个浏览器上下文 = 一个身份：Cookie 定租户与用户，代理按同一身份给真实后端签名。 */
async function signIn(context: BrowserContext, baseURL: string, persona: Persona) {
  const reads: ContentRead[] = [];
  await context.addCookies([
    { name: 'italent_demo_tenant', value: persona.tenant, url: baseURL },
    { name: 'italent_demo_user', value: persona.userId, url: baseURL },
  ]);
  await context.unroute('**/api/tenant/**');
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (persona.hr && (url.pathname.startsWith('/api/tenant/permission/') || !url.pathname.includes('/employment/')))
      return route.fulfill({ json: hrPermission(url.pathname, persona) });
    const response = await context.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), 'x-smoke-user': persona.userId },
      data: request.postDataBuffer() ?? undefined,
    });
    if (CONTENT.test(url.pathname))
      reads.push({
        path: url.pathname,
        tenant: request.headers()['x-tenant-id'],
        status: response.status(),
        disposition: response.headers()['content-disposition'],
      });
    return route.fulfill({ response });
  });
  return reads;
}

const field = (scope: Page | Locator) => scope.locator('.attachment-list').first();
const thumbs = (scope: Page | Locator) => scope.locator('.attachment-item img.attachment-thumb, .attachment-item img');
const strip = (value: string | null) => (value ?? '').replace(/\s/g, '');

/** AC-FE-ATT-10 公共断言：内容请求全部带本租户头且 200；缩略图都是 blob:；页面上没有指向 /api/ 的 src / href。 */
async function expectBlobOnly(page: Page, reads: ContentRead[], persona: Persona, ...prefixes: string[]) {
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) {
    expect(read.tenant).toBe(persona.tenant);
    expect(read.status).toBe(200);
    expect(
      prefixes.some((prefix) => read.path.startsWith(prefix)),
      read.path,
    ).toBe(true);
  }
  for (const src of await thumbs(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src'))))
    expect(src).toMatch(/^blob:/);
  await expect(page.locator('[src*="/api/"], [href*="/api/"]')).toHaveCount(0);
}

async function confirmIfAsked(page: Page) {
  const ok = page.getByRole('dialog').getByRole('button', { name: /^确\s*定$/ });
  if (await ok.isVisible().catch(() => false)) await ok.click();
}
async function save(page: Page) {
  await page.getByRole('button', { name: /^暂\s*存$/ }).click();
  await page.waitForTimeout(300);
  await confirmIfAsked(page);
}
async function submit(page: Page) {
  const button = page.getByRole('button', { name: '提交审批', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await page.waitForTimeout(300);
  await confirmIfAsked(page);
  await expect(page).toHaveURL(/\/self\/requests$/);
}
async function expectDownload(page: Page, scope: Locator, reads: ContentRead[], filename: string) {
  const before = reads.length;
  const waiting = page.waitForEvent('download');
  const row = scope.locator('.attachment-item').filter({ hasText: filename });
  await row
    .getByRole('button')
    .filter({ hasText: /^下\s*载$/ })
    .click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe(filename);
  expect((await readFile((await download.path())!)).length).toBeGreaterThan(0);
  const read = reads.slice(before).at(-1)!;
  expect(read.status).toBe(200);
  expect(read.disposition).toMatch(/^attachment;/);
}
async function openTodo(page: Page) {
  await page.goto('/approval/todos');
  await page.locator('.approval-card-action').first().click();
}
async function myRequest(page: Page) {
  await page.goto('/self/requests');
  // 申请标题取自审批实例（后端 employee-self-service/routes.ts），分类列为“离职申请”：按分类找行、点标题打开详情
  const row = page.locator('.ant-table-row').filter({ hasText: '离职申请' }).first();
  await row.getByRole('button').first().click();
  return page.getByRole('dialog');
}
async function backendExit(context: BrowserContext, persona: Persona) {
  const response = await context.request.get(`${manifest.url}/api/tenant/self-service/exit-requests/${exitId}`, {
    headers: { 'x-tenant-id': persona.tenant, 'x-smoke-user': persona.userId },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { attachmentRefs: string[]; attachments: { filename: string }[] };
}

test('AC-FE-ATT-05 上传 2 张 → 暂存 → 提交 → 申请详情 2 张缩略图', async ({ context, page, baseURL }) => {
  const me = personas().employee;
  const reads = await signIn(context, baseURL!, me);
  await page.goto('/self/applications');
  await page.getByRole('button', { name: '本人离职', exact: true }).click();
  await page.getByLabel('日期').fill('2026-12-01');
  await page.getByLabel('日期').press('Enter');
  await expect(page.getByText(FIELD, { exact: true })).toBeVisible();
  await page.locator('.image-attachments input[type="file"]').setInputFiles(
    NAMES.map((name, index) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(manifest.images[index]!, 'base64'),
    })),
  );
  await expect(thumbs(page)).toHaveCount(2);
  await save(page);
  await expect(page).toHaveURL(/\/self\/exit\/[0-9a-f-]{36}$/);
  exitId = page.url().split('/').at(-1)!;
  await expect(thumbs(page)).toHaveCount(2);
  await submit(page);
  const detail = await myRequest(page);
  await expect(detail.getByText(FIELD, { exact: true })).toBeVisible();
  await expect(thumbs(detail)).toHaveCount(2);
  for (const name of NAMES) await expect(detail.getByText(name, { exact: true })).toBeVisible();
  expect((await backendExit(context, me)).attachments.map((item) => item.filename)).toEqual(NAMES);
  // 暂存前的缩略图是临时文件，走 /attachments/:id/content；暂存绑定后走本人载体
  await expectBlobOnly(page, reads, me, '/api/tenant/self-service/exit-requests/', '/api/tenant/attachments/');
});

test('AC-FE-ATT-06 审批人打开待办下载：带租户头、200、attachment，浏览器得到原名文件', async ({
  context,
  page,
  baseURL,
}) => {
  const approver = personas().approver;
  const reads = await signIn(context, baseURL!, approver);
  await openTodo(page);
  await expect(page.getByText(FIELD, { exact: true })).toBeVisible();
  await expect(thumbs(page)).toHaveCount(2);
  await expectDownload(page, field(page), reads, NAMES[0]!);
  await expectBlobOnly(page, reads, approver, '/api/tenant/approval/instances/');
});

test('AC-FE-ATT-07 审批人无字段权：不渲染附件区、不读内容', async ({ context, page, baseURL }) => {
  const blind = personas().blind;
  const reads = await signIn(context, baseURL!, blind);
  await openTodo(page);
  await expect(page.getByText('离职申请', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.approval-detail, .approval-page').first()).toBeVisible();
  await expect(page.getByText(FIELD, { exact: true })).toHaveCount(0);
  await expect(page.locator('.attachment-list, .image-attachments')).toHaveCount(0);
  expect(reads).toEqual([]);
});

test('AC-FE-ATT-08 驳回后删除一张再提交：本人列表与后端一致，新一轮审批人只看到剩下的', async ({
  context,
  page,
  baseURL,
}) => {
  const { employee: me, approver } = personas();
  const rejected = await context.request.post(`${manifest.url}/__smoke/reject`, { data: { exitId } });
  expect(rejected.status(), await rejected.text()).toBe(200);
  await signIn(context, baseURL!, me);
  await page.goto(`/self/exit/${exitId}`);
  await expect(thumbs(page)).toHaveCount(2);
  const drop = page.locator('.attachment-item').filter({ hasText: NAMES[1]! });
  await drop
    .getByRole('button')
    .filter({ hasText: /^删\s*除$/ })
    .click();
  await expect(thumbs(page)).toHaveCount(1);
  await save(page);
  await expect(thumbs(page)).toHaveCount(1);
  await submit(page);
  const backendView = await backendExit(context, me);
  expect(backendView.attachments.map((item) => item.filename)).toEqual([NAMES[0]]);
  const detail = await myRequest(page);
  await expect(thumbs(detail)).toHaveCount(1);
  await expect(detail.getByText(NAMES[0]!, { exact: true })).toBeVisible();
  await expect(detail.getByText(NAMES[1]!, { exact: true })).toHaveCount(0);

  await signIn(context, baseURL!, approver);
  await openTodo(page);
  await expect(thumbs(page)).toHaveCount(1);
  await expect(page.getByText(NAMES[0]!, { exact: true })).toBeVisible();
  await expect(page.getByText(NAMES[1]!, { exact: true })).toHaveCount(0);
  expect(strip(await field(page).textContent())).not.toContain(strip(NAMES[1]!));
});

test('AC-FE-ATT-10 三载体只走 blob、下载与新标签打开；切换租户后不残留上一租户图片', async ({
  context,
  page,
  baseURL,
}) => {
  const { employee: me, approver, hr, other } = personas();
  // 本人表单：缩略图、放大预览、点文件名新标签打开 blob:
  let reads = await signIn(context, baseURL!, me);
  await page.goto(`/self/exit/${exitId}`);
  await expect(thumbs(page)).toHaveCount(1);
  // antd 缩略图上覆着“预览”遮罩，用户点的是遮罩所在的图片容器
  await page.locator('.attachment-item .ant-image').first().click();
  const preview = page.locator('.ant-image-preview-img');
  await expect(preview).toBeVisible();
  expect(await preview.getAttribute('src')).toMatch(/^blob:/);
  await page.keyboard.press('Escape');
  const opened = context.waitForEvent('page');
  await page.locator('.attachment-name').filter({ hasText: NAMES[0]! }).click();
  const tab = await opened;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  await tab.close();
  await expectBlobOnly(page, reads, me, `/api/tenant/self-service/exit-requests/${exitId}/`);

  // 审批载体：缩略图与下载
  reads = await signIn(context, baseURL!, approver);
  await openTodo(page);
  await expect(thumbs(page)).toHaveCount(1);
  await expectDownload(page, field(page), reads, NAMES[0]!);
  await expectBlobOnly(page, reads, approver, '/api/tenant/approval/instances/');

  // HR 载体：离职管理详情的缩略图与下载
  reads = await signIn(context, baseURL!, hr);
  await page.goto('/exits?view=all');
  await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
  const drawer = page.locator('.ant-drawer, .ant-modal').filter({ hasText: FIELD }).first();
  await expect(thumbs(drawer)).toHaveCount(1);
  await expectDownload(page, drawer, reads, NAMES[0]!);
  await expectBlobOnly(page, reads, hr, `/api/tenant/employment/exits/${exitId}/`);

  // 切换到另一租户：只看到该租户自己的附件，上一租户的图片不在页面上
  reads = await signIn(context, baseURL!, other);
  await page.goto(`/self/exit/${manifest.b.draft}`);
  await expect(thumbs(page)).toHaveCount(1);
  await expect(page.getByText('手写1.png', { exact: true })).toBeVisible();
  await expect(page.getByText(NAMES[0]!, { exact: true })).toHaveCount(0);
  await expectBlobOnly(page, reads, other, `/api/tenant/self-service/exit-requests/${manifest.b.draft}/`);

  // 切回原租户：恢复本租户附件，另一租户的不残留
  reads = await signIn(context, baseURL!, me);
  await page.goto(`/self/exit/${exitId}`);
  await expect(thumbs(page)).toHaveCount(1);
  await expect(page.getByText(NAMES[0]!, { exact: true })).toBeVisible();
  await expect(page.getByText('手写1.png', { exact: true })).toHaveCount(0);
  await expectBlobOnly(page, reads, me, `/api/tenant/self-service/exit-requests/${exitId}/`);
});

/**
 * AC-FE-ATT-09（S6）：第一轮已办审批人 X 仍见驳回前的两张并可下载；第二轮待办的 lead 在浏览器里只见剩下的一张。
 * 已办列表现在是演示桩（TodoCenter completedGap，approval/api.ts 的 completed 分支不请求后端），浏览器打不开真实已办单，
 * 所以 X 一侧经同一真实后端与同一详情 / 下载接口断言（不是浏览器渲染），lead 一侧走真实待办页面（PR 记为假设）。
 */
test('AC-FE-ATT-09 已办审批人仍见办理时的两张并可下载；待办审批人在浏览器里只见剩下的', async ({
  context,
  page,
  baseURL,
}) => {
  const { c } = manifest;
  const base = `${manifest.url}/api/tenant/approval/instances/${c.instanceId}`;
  const asHandled = { 'x-tenant-id': c.tenant, 'x-smoke-user': c.handled.userId };
  const detail = await context.request.get(base, { headers: asHandled });
  expect(detail.status(), await detail.text()).toBe(200);
  const body = (await detail.json()) as {
    contentView: { mode: string };
    form: { values: { attachments?: { id: string; filename: string }[] } };
  };
  expect(body.contentView.mode).toBe('frozen');
  expect(body.form.values.attachments?.map((item) => item.filename)).toEqual(NAMES_C);
  const dropped = await context.request.get(`${base}/attachments/${c.dropped}/content`, { headers: asHandled });
  expect(dropped.status()).toBe(200);
  expect(dropped.headers()['content-disposition']).toMatch(/^attachment;/);
  expect((await dropped.body()).length).toBeGreaterThan(0);

  const pending = { ...c.pending, tenant: c.tenant };
  await signIn(context, baseURL!, pending);
  await openTodo(page);
  await expect(page.getByText(FIELD, { exact: true })).toBeVisible();
  await expect(thumbs(page)).toHaveCount(1);
  await expect(page.getByText(NAMES_C[0]!, { exact: true })).toHaveCount(0);
  expect(strip(await field(page).textContent())).not.toContain(strip(NAMES_C[0]!));
  const live = await context.request.get(`${base}/attachments/${c.dropped}/content`, {
    headers: { 'x-tenant-id': c.tenant, 'x-smoke-user': c.pending.userId },
  });
  expect(live.status()).toBe(404);
});
