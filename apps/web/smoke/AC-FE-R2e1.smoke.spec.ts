import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import {
  candidate,
  CHANGE,
  CONTENT,
  EFFECTIVE,
  EMPTY,
  FULL,
  NEW,
  NOTE,
  PARTIAL,
  ROOT,
  STOP,
} from './fer2e1-scenarios.js';

interface Manifest {
  url: string;
  tenant: string;
  writer: string;
  writerProfile: string;
  reader: string;
  outside: string;
  approver: string;
  root: string;
  populated: string;
  empty: string;
}
const PATH = '/org/adjustments';
const API = '/api/tenant/org-adjustment/adjustments';
const intake = '组织调整申请';
let backend: ChildProcess;
let manifest: Manifest;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  const server = fileURLToPath(new URL('./fer2e1-live-server.mjs', import.meta.url));
  backend = spawn(process.execPath, [server], { stdio: ['ignore', 'pipe', 'pipe'] });
  manifest = await new Promise<Manifest>((resolve, reject) => {
    let output = '';
    let errors = '';
    backend.stdout!.on('data', (chunk) => {
      output += String(chunk);
      const match = /^FE_R2E1_READY (.+)$/m.exec(output);
      if (match) resolve(JSON.parse(match[1]!));
    });
    backend.stderr!.on('data', (chunk) => {
      errors += String(chunk);
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`FE-R2e1 测试后端退出 ${code}\n${errors}`)));
  });
});
test.afterAll(async () => {
  if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
    const closed = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
    backend.kill('SIGTERM');
    await closed;
  }
});
test.afterEach(async ({ context, page }) => {
  await page.close();
  await context.unrouteAll({ behavior: 'wait' });
});

async function signIn(page: Page, baseURL: string, persona: 'writer' | 'reader' | 'outside' | 'approver') {
  const context = page.context();
  page.setDefaultTimeout(15_000);
  const id = manifest[persona];
  await context.addCookies([
    { name: 'italent_demo_tenant', value: manifest.tenant, url: baseURL },
    { name: 'italent_demo_user', value: id, url: baseURL },
  ]);
  await context.route('**/api/tenant/**', async (route) => {
    const { pathname, search } = new URL(route.request().url());
    const response = await context.request.fetch(`${manifest.url}${pathname}${search}`, {
      method: route.request().method(),
      headers: { ...route.request().headers(), 'x-fer2e1-user': id },
      data: route.request().postDataBuffer() ?? undefined,
    });
    try {
      await route.fulfill({ response });
    } catch (error) {
      // 浏览器已取消旧读请求时，迟到的代理回执不再有可交付的路由。
      if (!(error instanceof Error) || (!page.isClosed() && !error.message.includes('Route is already handled!')))
        throw error;
    }
  });
}
const detail = (page: Page) =>
  page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '调整预览' }) });
const detailUrl = (id: string) => `${PATH}?id=${id}`;
const responseFor = (page: Page, path: string, method = 'GET') =>
  page.waitForResponse(
    (response) => new URL(response.url()).pathname === path && response.request().method() === method,
  );

async function pickOrg(page: Page, control: Locator, name: string) {
  await control.click();
  await control.fill(name);
  await page.locator('.ant-select-dropdown:visible').getByText(name, { exact: true }).click();
}
async function download(page: Page, format: 'PNG' | 'SVG', after: boolean) {
  await detail(page)
    .getByRole('button', { name: /^导\s*出$/ })
    .click();
  const received = page.waitForEvent('download');
  const exported = page.waitForResponse((response) => response.url().endsWith(`preview/export?after=${after}`));
  await page.getByRole('menuitem', { name: `${format} 图片下载` }).click();
  const file = await received;
  const response = await exported;
  expect(response.status()).toBe(200);
  expect(file.suggestedFilename()).toBe(`架构图（ZZ_FER2E1_范围＿）_20261002.${format.toLowerCase()}`);
  const { svg } = (await response.json()) as { svg: string };
  const bytes = await readFile((await file.path())!);
  if (format === 'SVG') expect(bytes.toString('utf8')).toBe(svg);
  else {
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const [, width, height] = /<svg[^>]* width="(\d+)" height="(\d+)"/.exec(svg)!;
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([Number(width), Number(height)]);
    expect(bytes.includes(Buffer.from('IDAT'))).toBe(true);
  }
  return svg;
}

test('AC-OA-19 组织管理入口、列表三项筛选、八项审批状态', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'writer');
  await page.goto('/org');
  await page.getByRole('menuitem', { name: '一体化组织调整审批' }).click();
  await expect(page.getByRole('row', { name: new RegExp(FULL) })).toContainText(`${ROOT}（包含下级）`);
  await expect(page.getByRole('row', { name: new RegExp(FULL) })).toContainText('未执行');
  await expect(page.getByRole('row', { name: new RegExp(EMPTY) })).toBeVisible();
  const executed = page.getByRole('row', { name: new RegExp(PARTIAL) });
  await expect(executed).toContainText('已执行');
  await expect(executed).toContainText(NOTE);

  await pickOrg(page, page.getByRole('combobox', { name: '审批主体组织' }), ROOT);
  await page.getByLabel('生效日期起').fill(EFFECTIVE);
  await page.getByLabel('生效日期止').fill(EFFECTIVE);
  await page.getByRole('combobox', { name: '审批状态' }).click();
  const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content');
  await expect(options).toHaveText(['草稿', '已暂存', '审批中', '审批通过', '审批未通过', '生效', '作废', '已驳回']);
  const filter = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === API && url.searchParams.get('approvalStatus') === 'reviewing';
  });
  await options.getByText('审批中', { exact: true }).click();
  const response = await filter;
  const query = new URL(response.url()).searchParams;
  expect(query.get('approvalSubjectOrgId')).toBe(manifest.root);
  expect(query.get('effectiveFrom')).toBe(EFFECTIVE);
  expect(query.get('effectiveTo')).toBe(EFFECTIVE);
  expect(query.get('approvalStatus')).toBe('reviewing');
  expect(response.status()).toBe(200);
  await expect(page.getByRole('row', { name: new RegExp(FULL) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(EMPTY) })).toHaveCount(0);
});

test('AC-OA-19-44 三类明细、时间线、两态预览和 PNG、SVG', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'writer');
  await page.goto(detailUrl(manifest.populated));
  const drawer = detail(page);
  const preview = drawer.getByRole('region', { name: '调整预览' });
  await expect(drawer.getByRole('region', { name: '新增组织' })).toContainText(NEW);
  await expect(drawer.getByRole('region', { name: '变更组织' })).toContainText('原上级');
  await expect(drawer.getByRole('region', { name: '变更组织' })).toContainText('新上级');
  await expect(preview.getByText(CHANGE, { exact: true })).toBeVisible();
  await expect(drawer.getByRole('region', { name: '停用组织' })).toContainText(STOP);
  await expect(drawer.getByRole('region', { name: '审批记录' })).toContainText('发起申请');
  await expect(preview.getByRole('row', { name: new RegExp(STOP) })).toContainText('停用');
  await expect(preview.getByRole('row', { name: new RegExp('ZZ_FER2E1_范围') })).toContainText('7');
  await expect(preview.getByRole('checkbox', { name: '同步调整编制' })).toBeDisabled();
  await expect(preview.getByRole('button', { name: '停用方式' })).toBeDisabled();
  await expect(preview.getByRole('button', { name: /^导\s*出$/ })).toHaveCount(0);

  const toggle = preview.getByRole('checkbox', { name: '展示调整后架构' });
  await toggle.check();
  await expect(preview.getByText(STOP, { exact: true })).toHaveCount(0);
  await expect(preview.getByText('新增', { exact: true })).toHaveCount(0);
  await toggle.uncheck();
  await preview.getByText('架构图', { exact: true }).click();
  await expect(preview.getByRole('img', { name: '组织调整架构图' })).toBeVisible();
  const before = await download(page, 'SVG', false);
  expect(await download(page, 'PNG', false)).toBe(before);
  expect(before).toContain(STOP);
  expect(before).toContain('>停用<');
  expect(before).not.toMatch(/在岗|兼岗|人数/);

  await toggle.check();
  const after = await download(page, 'SVG', true);
  expect(await download(page, 'PNG', true)).toBe(after);
  expect(after).not.toContain(STOP);
  expect(after).not.toMatch(/>停用<|>变更<|>新增</);
  expect(after).toContain('>7<');
  await page.goto(detailUrl(manifest.empty));
  await expect(detail(page).getByRole('heading', { name: '调整预览' })).toBeVisible();
  await expect(detail(page).getByRole('region', { name: '组织调整明细' })).toHaveCount(0);
});

test('AC-OA-24 / F-540 记录可读、字段裁剪和日志独立无权', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'reader');
  const logs = page.waitForResponse((response) => /\/approval\/instances\/[^/]+\/logs\?/.test(response.url()));
  await page.goto(detailUrl(manifest.populated));
  const drawer = detail(page);
  expect([403, 404]).toContain((await logs).status());
  await expect(drawer.getByRole('region', { name: '审批记录' })).toContainText('无权查看审批记录');
  const head = drawer.getByRole('region', { name: intake });
  await expect(head).toContainText(EFFECTIVE);
  await expect(head.getByText(CONTENT, { exact: true })).toHaveCount(0);
  await expect(head.getByText('--', { exact: true }).first()).toBeVisible();
  await expect(
    drawer.getByRole('region', { name: '新增组织' }).getByRole('cell', { name: '--' }).first(),
  ).toBeVisible();
  const preview = drawer.getByRole('region', { name: '调整预览' });
  await expect(preview.getByText(ROOT, { exact: true })).toHaveCount(0);
  await expect(preview.getByText('--', { exact: true }).first()).toBeVisible();
  await expect(drawer.getByRole('button', { name: '提交审批' })).toHaveCount(0);
});

test('AC-OA-24 无主体组织范围时列表为空，详情 404', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'outside');
  const loaded = responseFor(page, API);
  await page.goto(PATH);
  expect((await (await loaded).json()).items).toEqual([]);
  const denied = responseFor(page, `${API}/${manifest.populated}`);
  await page.goto(detailUrl(manifest.populated));
  expect((await denied).status()).toBe(404);
  await expect(page.getByRole('dialog').getByText('页面或记录不存在').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '调整预览' })).toHaveCount(0);
});

test('AC-OA-42 新建草稿、0 和 21 个范围由服务器拒绝、编辑后提交', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await signIn(page, baseURL!, 'writer');
  await page.goto(PATH);
  await page.getByRole('button', { name: intake, exact: true }).click();
  const form = page.getByRole('dialog', { name: intake, exact: true });
  const name = 'ZZ_FER2E1_浏览器申请';
  const editedName = 'ZZ_FER2E1_浏览器修改';
  const date = form.getByRole('textbox', { name: '选择日期' });
  const subject = form.getByRole('textbox', { name: '调整主题' });
  const range = form.getByRole('combobox', { name: '调整范围' });
  await subject.fill(name);
  await date.fill(EFFECTIVE);
  await date.press('Enter');
  await form.getByRole('textbox', { name: '调整内容' }).fill(CONTENT);
  await pickOrg(page, form.getByRole('combobox', { name: '审批主体组织' }), ROOT);
  await form.getByRole('button', { name: '去调整' }).click();
  await expect(page.getByText('编辑器在第二片提供')).toBeVisible();
  await subject.click();

  const save = async () => {
    await form.getByRole('button', { name: /^保\s*存$/ }).click();
  };
  const invalid = async (response: Response, count: number) => {
    expect(response.status()).toBe(400);
    expect((await response.json()).error.details).toMatchObject({ count, reason: 'ORG_ADJUSTMENT_RANGE_SIZE' });
    await expect(form.getByText('调整范围须选择 1～20 个组织')).toBeVisible();
    await expect(subject).toHaveValue(name);
    await expect(form.getByRole('textbox', { name: '调整内容' })).toHaveValue(CONTENT);
  };
  const zero = responseFor(page, API, 'POST');
  await save();
  await invalid(await zero, 0);
  for (let index = 1; index <= 21; index++) await pickOrg(page, range, candidate(index));
  await subject.click();
  const tooMany = responseFor(page, API, 'POST');
  await save();
  await invalid(await tooMany, 21);
  await expect(form.getByText(candidate(21), { exact: true })).toBeVisible();

  await range.focus();
  await range.press('Backspace');
  await subject.click();
  const saved = responseFor(page, API, 'POST');
  await save();
  expect((await saved).status()).toBe(201);
  const drawer = detail(page);
  await expect(drawer).toContainText(name);
  await expect(drawer.getByRole('region', { name: intake })).toContainText('已暂存');
  await drawer.getByRole('button', { name: '修改申请' }).click();
  await subject.fill(editedName);
  const id = new URL(page.url()).searchParams.get('id');
  const patch = responseFor(page, `${API}/${id}`, 'PATCH');
  await save();
  expect((await patch).status()).toBe(200);
  await expect(drawer).toContainText(editedName);
  const submitted = responseFor(page, `${API}/${id}/submit`, 'POST');
  await drawer.getByRole('button', { name: '提交审批' }).click();
  expect((await submitted).status()).toBe(200);
  await expect(drawer.getByRole('region', { name: intake })).toContainText('审批中');
  await expect(drawer.getByRole('region', { name: '审批记录' })).toContainText('发起申请');
});

test('AC-OA-44 审批关系可打开详情和导出', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'approver');
  const opened = responseFor(page, `${API}/${manifest.populated}`);
  await page.goto(`/approval/org-adjustment?id=${manifest.populated}`);
  expect((await opened).status()).toBe(200);
  const drawer = detail(page);
  await expect(drawer.getByRole('region', { name: '审批记录' })).toContainText('发起申请');
  await drawer.getByText('架构图', { exact: true }).click();
  await expect(drawer.getByRole('button', { name: /^导\s*出$/ })).toBeVisible();
  await expect(drawer.getByRole('img', { name: '组织调整架构图' })).toBeVisible();
});

test('AC-FE-R2e1 修改冲突重读并核对，随后作废', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'writer');
  const api = `${API}/${manifest.empty}`;
  await page.goto(detailUrl(manifest.empty));
  const drawer = detail(page);
  await drawer.getByRole('button', { name: '修改申请' }).click();
  const form = page.getByRole('dialog', { name: intake, exact: true });
  const subject = form.getByRole('textbox', { name: '调整主题' });
  const content = form.getByRole('textbox', { name: '调整内容' });
  const updatedName = 'ZZ_FER2E1_核对后保存';
  const updatedContent = 'ZZ_FER2E1_并发更新';
  await subject.fill(updatedName);
  const external = await page.request.patch(`${manifest.url}${api}`, {
    headers: {
      'x-tenant-id': manifest.tenant,
      'x-fer2e1-user': manifest.writer,
      'if-match': '1',
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: updatedContent },
  });
  expect(external.status()).toBe(200);
  const save = () => form.getByRole('button', { name: /^保\s*存$/ }).click();
  const conflict = responseFor(page, api, 'PATCH');
  await save();
  expect((await conflict).status()).toBe(409);
  await form.getByRole('button', { name: '重读最新版本' }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(subject).toHaveValue(updatedName);
  await expect(content).toHaveValue(updatedContent);
  const saved = responseFor(page, api, 'PATCH');
  await save();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().headers()['if-match']).toBe('2');
  expect(response.request().postDataJSON()).toEqual({ subject: updatedName });

  await drawer.getByRole('button', { name: /^作\s*废$/ }).click();
  const voided = responseFor(page, `${api}/void`, 'POST');
  await page
    .getByRole('dialog', { name: '作废组织调整申请？' })
    .getByRole('button', { name: /^作\s*废$/ })
    .click();
  expect((await voided).status()).toBe(200);
  await expect(drawer.getByRole('region', { name: intake })).toContainText('作废');
});

test('AC-FE-R2e1 新建回执丢失后重开仍锁定，查询原命令确认草稿', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'writer');
  await page.goto(PATH);
  let commandId = '';
  await page.route(`**${API}`, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    expect(commandId).toBe('');
    commandId = request.headers()['idempotency-key']!;
    const persisted = await page.request.post(`${manifest.url}${API}`, {
      headers: { ...request.headers(), 'x-fer2e1-user': manifest.writer },
      data: request.postDataBuffer()!,
    });
    expect(persisted.status()).toBe(201);
    await route.abort('connectionreset');
  });
  const open = page.getByRole('button', { name: intake, exact: true });
  const form = page.getByRole('dialog', { name: intake, exact: true });
  const save = form.getByRole('button', { name: /^保\s*存$/ });
  const name = 'ZZ_FER2E1_原命令查询';
  await open.click();
  await form.getByRole('textbox', { name: '调整主题' }).fill(name);
  const date = form.getByRole('textbox', { name: '选择日期' });
  await date.fill(EFFECTIVE);
  await date.press('Enter');
  await pickOrg(page, form.getByRole('combobox', { name: '审批主体组织' }), ROOT);
  await pickOrg(page, form.getByRole('combobox', { name: '调整范围' }), candidate(1));
  await form.getByRole('textbox', { name: '调整主题' }).click();
  await save.click();
  await expect(form.getByText(/结果待确认。当前表单已锁定/)).toBeVisible();
  await form.getByRole('button', { name: /^取\s*消$/ }).click();
  await open.click();
  await expect(save).toBeDisabled();
  const read = responseFor(page, `/api/tenant/commands/${commandId}/result`);
  await form.getByRole('button', { name: '查询结果' }).click();
  expect((await read).status()).toBe(200);
  await expect(detail(page)).toContainText(name);
  await expect(detail(page).getByRole('region', { name: intake })).toContainText('已暂存');
});

// DEC-955 只禁调动 / 审批写入；组织调整不在范围内，浏览器没有 Web Locks 时照常登记并保存。
// F-110 第 2 轮 P2-1：真实 http 非安全上下文还没有 crypto.randomUUID，组织调整按 requireLocks:false 仍须照常保存。
for (const variant of [
  { title: '无 navigator.locks 时', suffix: '', uuid: true },
  { title: '非安全上下文（无 locks、无 randomUUID）时', suffix: '_非安全', uuid: false },
]) {
  test(`AC-FE-F110-23 组织调整不在 DEC-955 范围：${variant.title}新建草稿照常保存`, async ({ page, baseURL }) => {
    await page.addInitScript((uuid) => {
      Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });
      if (!uuid) delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
    }, variant.uuid);
    await signIn(page, baseURL!, 'writer');
    await page.goto(PATH);
    await page.getByRole('button', { name: intake, exact: true }).click();
    const form = page.getByRole('dialog', { name: intake, exact: true });
    const name = `ZZ_FER2E1_无锁环境${variant.suffix}`;
    await form.getByRole('textbox', { name: '调整主题' }).fill(name);
    const date = form.getByRole('textbox', { name: '选择日期' });
    await date.fill(EFFECTIVE);
    await date.press('Enter');
    await pickOrg(page, form.getByRole('combobox', { name: '审批主体组织' }), ROOT);
    await pickOrg(page, form.getByRole('combobox', { name: '调整范围' }), candidate(1));
    await form.getByRole('textbox', { name: '调整主题' }).click();
    // 按断言判定（不用 waitForResponse 超时）：页面若在生成命令 ID 时抛错，POST 根本不会发出。
    const saved: number[] = [];
    page.on('response', (response) => {
      const request = response.request();
      if (new URL(response.url()).pathname === API && request.method() === 'POST') saved.push(response.status());
    });
    await form.getByRole('button', { name: /^保\s*存$/ }).click();
    await expect.poll(() => saved).toEqual([201]);
    await expect(detail(page)).toContainText(name);
    expect(await page.evaluate(() => localStorage.getItem('italent.commands.pending:org-adjustment'))).toBeNull();
  });
}

function writerHeaders(revision?: number) {
  return {
    'x-tenant-id': manifest.tenant,
    'x-fer2e1-user': manifest.writer,
    ...(revision === undefined ? {} : { 'if-match': String(revision), 'idempotency-key': crypto.randomUUID() }),
  };
}

async function seedConflictDraft(page: Page, subject: string, content: string) {
  const response = await page.request.post(`${manifest.url}${API}`, {
    headers: writerHeaders(0),
    data: {
      subject,
      content,
      effectiveDate: EFFECTIVE,
      approvalSubjectOrgId: manifest.root,
      adjustmentRange: [manifest.root],
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}

async function setContentAccess(page: Page, allowed: boolean) {
  const object = 'TenantBase.OrganizationApproval';
  const path = `/api/tenant/permission/profiles/${manifest.writerProfile}/objects/${object}/fields`;
  const current = await page.request.get(`${manifest.url}${path}?code=content`, { headers: writerHeaders() });
  expect(current.status()).toBe(200);
  const { revision } = (await current.json()) as { revision: number };
  const changed = await page.request.put(`${manifest.url}${path}`, {
    headers: writerHeaders(revision),
    data: { fields: [{ fieldCode: 'content', view: allowed, edit: allowed }] },
  });
  expect(changed.status()).toBe(200);
}

test('AC-FE-R2e1 P2-1 撤销查看权后重读，弹窗与重开详情均不披露冲突旧值和草稿', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'writer');
  const subject = 'ZZ_FER2E1_调整内容权限';
  const original = 'ZZ_FER2E1_old-secret';
  const draft = 'ZZ_FER2E1_new-secret';
  const record = await seedConflictDraft(page, subject, original);
  const api = `${API}/${record.id}`;
  await page.goto(detailUrl(record.id));
  const drawer = detail(page);
  await drawer.getByRole('button', { name: '修改申请' }).click();
  const form = page.getByRole('dialog', { name: intake, exact: true });
  await form.getByRole('textbox', { name: '调整内容' }).fill(draft);

  const concurrent = await page.request.patch(`${manifest.url}${api}`, {
    headers: writerHeaders(record.revision),
    data: { content: 'ZZ_FER2E1_并发保密内容' },
  });
  expect(concurrent.status()).toBe(200);
  const conflict = responseFor(page, api, 'PATCH');
  await form.getByRole('button', { name: /^保\s*存$/ }).click();
  expect((await conflict).status()).toBe(409);

  await setContentAccess(page, false);
  try {
    const reread = responseFor(page, api);
    await form.getByRole('button', { name: '重读最新版本' }).click();
    const read = await reread;
    expect(read.status()).toBe(200);
    expect(await read.json()).not.toHaveProperty('content');
    await expect(form.getByRole('button', { name: '已核对差异，继续编辑' })).toBeVisible();
    await expect.soft(form.getByText(original)).toHaveCount(0, { timeout: 1500 });
    await expect.soft(form.getByText(draft)).toHaveCount(0, { timeout: 1500 });
    await expect.soft(form.getByRole('textbox', { name: '调整内容' })).toHaveCount(0, { timeout: 1500 });

    await form.getByRole('button', { name: /^取\s*消$/ }).click();
    await drawer.locator('.ant-drawer-close').click();
    await page.getByRole('button', { name: subject, exact: true }).click();
    await expect(drawer.getByRole('button', { name: '已核对差异，继续编辑' })).toBeVisible();
    await expect(drawer.getByRole('region', { name: intake })).toContainText('调整内容');
    await expect.soft(page.getByText(original)).toHaveCount(0, { timeout: 1500 });
    await expect.soft(page.getByText(draft)).toHaveCount(0, { timeout: 1500 });
  } finally {
    await setContentAccess(page, true);
  }
});

test('AC-FE-R2e1 P2-2 冲突后放弃主题修改，无改动保存后重开仅 PATCH 新内容', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, 'writer');
  const original = 'ZZ_FER2E1_原主题';
  const latest = 'ZZ_FER2E1_最新主题';
  const abandoned = 'ZZ_FER2E1_放弃主题';
  const newContent = 'ZZ_FER2E1_新调整内容';
  const record = await seedConflictDraft(page, original, CONTENT);
  const api = `${API}/${record.id}`;
  await page.goto(detailUrl(record.id));
  const drawer = detail(page);
  const edit = drawer.getByRole('button', { name: '修改申请' });
  const form = page.getByRole('dialog', { name: intake, exact: true });
  const subject = form.getByRole('textbox', { name: '调整主题' });
  const save = form.getByRole('button', { name: /^保\s*存$/ });
  await edit.click();
  await subject.fill(abandoned);

  const concurrent = await page.request.patch(`${manifest.url}${api}`, {
    headers: writerHeaders(record.revision),
    data: { subject: latest },
  });
  expect(concurrent.status()).toBe(200);
  const { revision } = (await concurrent.json()) as { revision: number };
  const conflict = responseFor(page, api, 'PATCH');
  await save.click();
  expect((await conflict).status()).toBe(409);
  await form.getByRole('button', { name: '重读最新版本' }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(subject).toHaveValue(abandoned);

  const patches: unknown[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === api && request.method() === 'PATCH') patches.push(request.postDataJSON());
  });
  await subject.fill(latest);
  await save.click();
  await expect(form).toBeHidden();
  await expect.soft(drawer).toHaveAccessibleName(latest, { timeout: 1500 });
  expect(patches).toEqual([]);

  await edit.click();
  await expect.soft(subject).toHaveValue(latest, { timeout: 1500 });
  await form.getByRole('textbox', { name: '调整内容' }).fill(newContent);
  const saved = responseFor(page, api, 'PATCH');
  await save.click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().headers()['if-match']).toBe(String(revision));
  expect(patches).toEqual([{ content: newContent }]);
});
