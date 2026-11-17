/**
 * F-326 F3 浏览器集成（AC-APV-F326-26）：真实后端（隔离库 + 合成数据）+ 真实浏览器。
 * 全部 /api/tenant/** 代理到 f326f3-live-server（真实 Hono、真实权限快照与授权、真实候选接口与保存校验）。
 * 设计器三类来源不再灰显；矩阵两级选择；单人节点选多人变量 / 多人角色列即时提示（与后端 422 同文）；
 * Offer（多主体、无任职申请业务日）选项可见但矩阵禁用。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

interface Manifest {
  url: string;
  tenant: string;
  admin: string;
  processes: { display: string; variables: string; matrix: string; offer: string; rows: string };
}
const MULTI_VARIABLE = '多人变量只能用于会签或或签节点';
const MULTI_COLUMN = '允许多人的角色列只能用于会签或或签节点';
let backend: ChildProcess;
let manifest: Manifest;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f326f3-live-server.mjs', import.meta.url))], {
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
      const ready = output.split('\n').find((line) => line.startsWith('F326F3_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F326F3_READY '.length)));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F326F3 backend exited ${code}: ${errors}`)));
  });
});
test.afterEach(async ({ context }) => {
  await context.unrouteAll({ behavior: 'ignoreErrors' });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

/** Cookie 定租户与用户，代理按同一身份给真实后端签名；记下候选接口的查询串。 */
async function signIn(context: BrowserContext, baseURL: string) {
  const candidates: URL[] = [];
  await context.addCookies([
    { name: 'italent_demo_tenant', value: manifest.tenant, url: baseURL },
    { name: 'italent_demo_user', value: manifest.admin, url: baseURL },
  ]);
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/designer/source-candidates')) candidates.push(url);
    const response = await context.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), 'x-smoke-user': manifest.admin },
      data: request.postDataBuffer() ?? undefined,
    });
    return route.fulfill({ response });
  });
  return candidates;
}
const processPath = (id: string) => `/config-center/workflow/processes/${id}`;
const editor = (page: Page) => page.getByRole('group', { name: '审批人来源', exact: true }).filter({ visible: true });
const combo = (page: Page, name: string) => editor(page).getByRole('combobox', { name, exact: true });
const dropdownOption = (page: Page, text: string | RegExp) =>
  page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text });
async function choose(page: Page, name: string, text: string | RegExp, scope: Locator = editor(page)) {
  const box = scope.getByRole('combobox', { name, exact: true });
  await box.focus();
  await box.press('ArrowDown');
  await dropdownOption(page, text).click();
}
const rows = (page: Page) => editor(page).locator('.flow-source-row');
const selected = (row: Locator, name: string) =>
  row.getByRole('combobox', { name, exact: true }).locator('xpath=ancestor::div[contains(@class,"ant-select")][1]');
const save = (page: Page) => page.getByRole('button', { name: '保存草稿', exact: true }).click();
const noUuid = async (scope: Locator) =>
  expect(scope.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/).filter({ visible: true })).toHaveCount(0);

test('AC-APV-F326-26-01 调动流程：三类来源不再灰显，已存公共变量按名称（编码）回显', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!);
  await page.goto(processPath(manifest.processes.display));
  await expect(editor(page).getByText('合成公共审批人（Global.B.SmokePerson）')).toBeVisible();
  await combo(page, '来源类型').focus();
  await combo(page, '来源类型').press('ArrowDown');
  for (const label of ['公共变量', '应用变量', '审批矩阵'])
    await expect(dropdownOption(page, new RegExp(`^${label}$`))).not.toHaveClass(/disabled/);
  await expect(dropdownOption(page, '暂不支持')).toHaveCount(0);
  await noUuid(editor(page));
});

test('AC-APV-F326-26-02 单人节点选多人变量即时提示；换单人变量提示消失；应用变量按审批类型取候选并保存', async ({
  context,
  page,
  baseURL,
}) => {
  const candidates = await signIn(context, baseURL!);
  // P2-2：反复切换来源值后不得出现 React 重复 key 告警
  const sameKey: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('same key')) sameKey.push(message.text());
  });
  await page.goto(processPath(manifest.processes.variables));
  await expect(editor(page).getByText('合成公共审批人（Global.B.SmokePerson）')).toBeVisible();
  await choose(page, '来源值', '合成公共多人');
  await expect(editor(page).getByText(MULTI_VARIABLE, { exact: true })).toBeVisible();
  await choose(page, '来源值', '合成公共审批人');
  await expect(editor(page).getByText(MULTI_VARIABLE, { exact: true })).toHaveCount(0);
  await combo(page, '来源值').press('ArrowDown');
  await expect(dropdownOption(page, '合成公共审批人')).toHaveCount(1);
  await expect(dropdownOption(page, '来源信息未读取')).toHaveCount(0);
  await combo(page, '来源值').press('Escape');

  await choose(page, '来源类型', /^应用变量$/);
  await choose(page, '来源值', '合成调动对接人');
  const read = candidates.find((url) => url.searchParams.get('type') === 'application_variable')!;
  expect(read.searchParams.get('approvalType')).toBe('transfer');
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(editor(page).getByText(/^合成调动对接人（.+）$/)).toBeVisible();
  await noUuid(editor(page));
  expect(sameKey).toEqual([]);
});

test('AC-APV-F326-26-03 矩阵两级选择：矩阵 → 角色列；多人角色列即时提示且后端同文拒存；单人列保存后回显', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!);
  await page.goto(processPath(manifest.processes.matrix));
  await expect(editor(page).getByText('合成公共审批人（Global.B.SmokePerson）')).toBeVisible();
  await choose(page, '来源类型', /^审批矩阵$/);
  await combo(page, '矩阵').focus();
  await combo(page, '矩阵').press('ArrowDown');
  await expect(dropdownOption(page, '合成单人矩阵')).toBeVisible();
  await expect(dropdownOption(page, '合成多人矩阵')).toBeVisible();
  // 一级只列矩阵，角色列只在二级出现
  await expect(dropdownOption(page, /^角色$/)).toHaveCount(0);
  await dropdownOption(page, '合成多人矩阵').click();
  await choose(page, '角色列', /^角色$/);
  await expect(editor(page).getByText(MULTI_COLUMN, { exact: true })).toBeVisible();
  await save(page);
  // 后端 422 同文：等服务端拒绝落地（错误态提示，非编辑区的即时提示），保存被拒，来源保留可改
  await expect(page.locator('.ant-alert-error').filter({ hasText: MULTI_COLUMN })).toBeVisible();
  await expect(page.getByText('草稿已保存', { exact: true })).toHaveCount(0);
  await expect(combo(page, '矩阵')).toBeEnabled();

  await choose(page, '矩阵', '合成单人矩阵');
  await expect(editor(page).getByText(MULTI_COLUMN, { exact: true })).toHaveCount(0);
  await choose(page, '角色列', /^角色$/);
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(combo(page, '矩阵').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]')).toContainText(
    '合成单人矩阵',
  );
  await expect(combo(page, '角色列').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]')).toContainText(
    '角色',
  );
  await noUuid(editor(page));
});

test('AC-APV-F326-26-04 Offer（无任职申请业务日、多主体）：审批矩阵可见但禁用并注明原因，两类变量可选', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!);
  await page.goto(processPath(manifest.processes.offer));
  await expect(editor(page).getByText('合成公共审批人（Global.B.SmokePerson）')).toBeVisible();
  await combo(page, '来源类型').focus();
  await combo(page, '来源类型').press('ArrowDown');
  await expect(dropdownOption(page, '审批矩阵 · 该审批类型不可选')).toHaveClass(/disabled/);
  for (const label of ['公共变量', '应用变量'])
    await expect(dropdownOption(page, new RegExp(`^${label}$`))).not.toHaveClass(/disabled/);
});

test('AC-APV-F326-26-05 会签删除前一行：后一行未完成的矩阵选择保留为乙，只给乙的角色列，保存后回显乙', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!);
  await page.goto(processPath(manifest.processes.rows));
  await expect(rows(page)).toHaveCount(2);
  const [first, second] = [rows(page).nth(0), rows(page).nth(1)];
  await choose(page, '来源类型', /^审批矩阵$/, first);
  await choose(page, '矩阵', '合成单人矩阵', first);
  await choose(page, '角色列', /^角色$/, first);
  await choose(page, '来源类型', /^审批矩阵$/, second);
  await choose(page, '矩阵', '合成多人矩阵', second);
  await expect(selected(second, '矩阵')).toContainText('合成多人矩阵');

  await first.getByRole('button', { name: '移除来源', exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  const left = rows(page).nth(0);
  await expect(selected(left, '矩阵')).toContainText('合成多人矩阵');
  await expect(selected(left, '角色列')).not.toContainText('角色');
  await choose(page, '角色列', /^角色$/, left);
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(selected(rows(page).nth(0), '矩阵')).toContainText('合成多人矩阵');
  await expect(selected(rows(page).nth(0), '角色列')).toContainText('角色');
  await noUuid(editor(page));
});
