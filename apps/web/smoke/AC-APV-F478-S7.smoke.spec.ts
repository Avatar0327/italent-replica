/**
 * F-478 S7 真实后端冒烟（AC-APV-F478-26、AC-APV-F478-31）：隔离库 + 合成数据（f478s7-live-server），
 * 真实 Hono、真实授权引擎与权限快照；浏览器业务请求经代理按身份签名转发，不造任何业务响应。
 * 切换租户与用户沿用演示环境的 italent_demo_tenant / italent_demo_user 两个 Cookie。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

interface Persona {
  tenant: string;
  userId: string;
}
type DraftKey = 'sources' | 'branches' | 'routeError' | 'sourceError';
interface Manifest {
  url: string;
  designer: Persona & { processes: Record<DraftKey, string> };
  specified: { userId: string; name: string };
  rehire: { hrbp: Persona; instanceId: string };
  plain: { hrbp: Persona; instanceId: string };
}
interface Write {
  method: string;
  path: string;
  status: number;
  body: Record<string, unknown>;
}
interface StoredNode {
  key: string;
  approver?: { type: string; value: string };
  routes?: { exit: string; branches: Record<string, unknown>[] }[];
}

let backend: ChildProcess;
let manifest: Manifest;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f478s7-live-server.mjs', import.meta.url))], {
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
      const ready = output.split('\n').find((line) => line.startsWith('F478S7_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F478S7_READY '.length)));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F478S7 backend exited ${code}: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

/** 一个浏览器上下文 = 一个身份：Cookie 定租户与用户，代理按同一身份签名；记录写请求的请求体与真实状态码。 */
async function signIn(context: BrowserContext, baseURL: string, persona: Persona) {
  const writes: Write[] = [];
  await context.addCookies([
    { name: 'italent_demo_tenant', value: persona.tenant, url: baseURL },
    { name: 'italent_demo_user', value: persona.userId, url: baseURL },
  ]);
  await context.unroute('**/api/tenant/**');
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await context.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), 'x-smoke-user': persona.userId },
      data: request.postDataBuffer() ?? undefined,
    });
    if (request.method() !== 'GET')
      writes.push({
        method: request.method(),
        path: url.pathname,
        status: response.status(),
        body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
      });
    return route.fulfill({ response });
  });
  return writes;
}

async function backendGet<T>(context: BrowserContext, persona: Persona, path: string): Promise<T> {
  const response = await context.request.get(`${manifest.url}${path}`, {
    headers: { 'x-tenant-id': persona.tenant, 'x-smoke-user': persona.userId },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as T;
}
const storedNodes = async (context: BrowserContext, draft: DraftKey) =>
  (
    await backendGet<{ latestVersion: { nodes: StoredNode[] } }>(
      context,
      manifest.designer,
      `/api/tenant/approval/processes/${manifest.designer.processes[draft]}`,
    )
  ).latestVersion.nodes;

async function openSelect(input: Locator) {
  await input.focus();
  await input.press('ArrowDown');
}
/** 只在本选择框自己的下拉里取选项（aria-owns 指向下拉内的列表）：上一个下拉收起动画期间仍可见，不能按“第一个可见”取。 */
async function option(page: Page, input: Locator, text: string | RegExp) {
  const owns = await input.getAttribute('aria-owns');
  const dropdown = page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${owns}"]`) });
  const item = dropdown.locator('.ant-select-item-option').filter({ hasText: text });
  await expect(item.first(), `下拉选项 ${String(text)}`).toBeVisible();
  await item.first().click();
}
async function choose(page: Page, scope: Locator, name: string, text: string | RegExp) {
  const input = scope.getByRole('combobox', { name, exact: true });
  await openSelect(input);
  await option(page, input, text);
}
const exact = (text: string) => new RegExp(`^${text}$`);

const designer = (page: Page) => page.locator('.flow-designer').filter({ visible: true });
const nodeButton = (page: Page, name: string) =>
  designer(page).getByRole('navigation', { name: '流程节点' }).getByRole('button', { name });
const sources = (page: Page) => page.getByRole('group', { name: '审批人来源', exact: true }).filter({ visible: true });
const exitGroup = (page: Page, exit = '同意') =>
  page.getByRole('group', { name: `${exit} · 出口分支`, exact: true }).filter({ visible: true });
const branch = (page: Page, no: number) => exitGroup(page).getByRole('group', { name: `分支 ${no}`, exact: true });
const save = (page: Page) => page.getByRole('button', { name: '保存草稿', exact: true }).click();
async function addBranch(page: Page, kind: '添加条件分支' | '添加 Else') {
  const button = exitGroup(page).getByRole('button', { name: kind, exact: true });
  await expect(button, `出口分支编辑：${kind}`).toBeVisible();
  await button.click();
}

/** 就绪 = 可见设计器容器内标题“设计器”、节点导航与可用的保存按钮，且没有加载态（不靠固定等待）。 */
async function openDesigner(page: Page, draft: DraftKey) {
  await page.goto(`/config-center/workflow/processes/${manifest.designer.processes[draft]}`);
  await expect(designer(page).getByRole('heading', { name: '设计器', exact: true })).toBeVisible();
  await expect(designer(page).getByRole('navigation', { name: '流程节点' })).toBeVisible();
  await expect(designer(page).locator('.page-state[role="status"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
}
/** 切换编辑节点：以可见属性区的“节点名称”核对已切换（aria-current 另由错误定位用例断言）。 */
async function selectNode(page: Page, name: string) {
  await nodeButton(page, name).click();
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true }).filter({ visible: true })).toHaveValue(
    name,
  );
}
async function savedAndReloaded(page: Page, draft: DraftKey) {
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  await openDesigner(page, draft);
}

test('AC-APV-F478-26 来源：选“主体员工本人”“系统管理员”经真实接口保存并读回', async ({ context, page, baseURL }) => {
  const writes = await signIn(context, baseURL!, manifest.designer);
  await openDesigner(page, 'sources');
  await selectNode(page, '合成次节点');
  await choose(page, sources(page), '来源类型', exact('本对象字段'));
  await choose(page, sources(page), '来源值', '主体员工本人');
  await selectNode(page, '合成末节点');
  await choose(page, sources(page), '来源类型', exact('身份'));
  await choose(page, sources(page), '来源值', '系统管理员');
  await save(page);
  await savedAndReloaded(page, 'sources');
  expect(writes.map((write) => [write.method, write.status])).toEqual([['PUT', 200]]);
  const nodes = await storedNodes(context, 'sources');
  expect(nodes.map((node) => node.approver)).toEqual([
    { type: 'object_field', value: 'direct_manager' },
    { type: 'object_field', value: 'subject_employee' },
    { type: 'identity', value: 'system_admin' },
  ]);
  await selectNode(page, '合成次节点');
  await expect(sources(page).getByText('主体员工本人', { exact: true })).toBeVisible();
  await selectNode(page, '合成末节点');
  await expect(sources(page).getByText('系统管理员', { exact: true })).toBeVisible();
});

async function addListBranch(page: Page) {
  await addBranch(page, '添加条件分支');
  await expect(branch(page, 1).getByRole('spinbutton', { name: '优先级', exact: true })).toHaveValue('1');
  await branch(page, 1).getByRole('button', { name: '添加条件', exact: true }).click();
  await choose(page, branch(page, 1), '条件字段', exact('业务类型'));
  await choose(page, branch(page, 1), '运算符', exact('属于'));
  const values = branch(page, 1).getByRole('combobox', { name: '条件值', exact: true });
  for (const value of ['合成甲类', '合成乙类']) {
    await values.fill(value);
    await values.press('Enter');
  }
  await page.keyboard.press('Escape');
  await choose(page, branch(page, 1), '去向', exact('合成末节点'));
}

test('AC-APV-F478-26 分支：条件分支“属于”列表值 + Else，保存后接口与页面读回一致', async ({
  context,
  page,
  baseURL,
}) => {
  const writes = await signIn(context, baseURL!, manifest.designer);
  await openDesigner(page, 'branches');
  await expect(exitGroup(page).getByText('未配置分支：按默认顺序流转')).toBeVisible();
  await addListBranch(page);
  await addBranch(page, '添加 Else');
  await choose(page, branch(page, 2), '去向', exact('合成次节点'));
  await save(page);
  await savedAndReloaded(page, 'branches');
  expect(writes.map((write) => [write.method, write.status])).toEqual([['PUT', 200]]);
  const [first] = await storedNodes(context, 'branches');
  expect(first!.routes).toEqual([
    {
      exit: 'approve',
      branches: [
        {
          kind: 'condition',
          priority: 1,
          conditions: {
            expression: '1',
            items: [{ no: 1, field: 'business.kind', operator: 'in', value: ['合成甲类', '合成乙类'] }],
          },
          target: 'n3',
        },
        { kind: 'else', target: 'n2' },
      ],
    },
  ]);
  await expect(branch(page, 1).getByText('合成甲类', { exact: true })).toBeVisible();
  await expect(branch(page, 1).getByText('合成乙类', { exact: true })).toBeVisible();
  await expect(branch(page, 1).getByText('合成末节点', { exact: true })).toBeVisible();
  await expect(branch(page, 2).getByText('合成次节点', { exact: true })).toBeVisible();
});

test('AC-APV-F478-26 400：分支违规按 reason 定位到节点与分支，不提示保存成功', async ({ context, page, baseURL }) => {
  const writes = await signIn(context, baseURL!, manifest.designer);
  await openDesigner(page, 'routeError');
  await addBranch(page, '添加条件分支');
  await choose(page, branch(page, 1), '去向', exact('合成末节点'));
  await addBranch(page, '添加 Else');
  await choose(page, branch(page, 2), '去向', exact('合成次节点'));
  // 停在别的节点保存：定位须把编辑区切回出错节点
  await selectNode(page, '合成次节点');
  await save(page);
  await expect.poll(() => writes.map((write) => write.status)).toEqual([400]);
  await expect(nodeButton(page, '合成首节点')).toHaveAttribute('aria-current', 'true');
  await expect(
    page.getByText('节点“合成首节点” · 同意 · 分支 1：条件不完整或不合法', { exact: false }).first(),
  ).toBeVisible();
  await expect(branch(page, 1)).toBeVisible();
  await expect(page.getByText('草稿已保存', { exact: true })).toHaveCount(0);
  const [first] = await storedNodes(context, 'routeError');
  expect(first!.routes ?? []).toEqual([]);
});

test('AC-APV-F478-26 422：指定人员已失效，APPROVAL_SOURCE_INVALID 定位到该节点的审批人来源', async ({
  context,
  page,
  baseURL,
}) => {
  const writes = await signIn(context, baseURL!, manifest.designer);
  await openDesigner(page, 'sourceError');
  await selectNode(page, '合成末节点');
  await choose(page, sources(page), '来源类型', exact('指定人员'));
  await choose(page, sources(page), '指定人员', manifest.specified.name);
  await page.keyboard.press('Escape');
  const revoked = await context.request.post(`${manifest.url}/__smoke/revoke`, {
    data: { userId: manifest.specified.userId },
  });
  expect(revoked.status()).toBe(204);
  await selectNode(page, '合成首节点');
  await save(page);
  await expect.poll(() => writes.map((write) => write.status)).toEqual([422]);
  await expect(nodeButton(page, '合成末节点')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('节点“合成末节点” · 审批人来源：', { exact: false }).first()).toBeVisible();
  await expect(sources(page)).toBeVisible();
  await expect(page.getByText('草稿已保存', { exact: true })).toHaveCount(0);
  const nodes = await storedNodes(context, 'sourceError');
  expect(nodes[2]!.approver).toEqual({ type: 'department', value: 'record_department_head' });
});

const head = (page: Page) => page.locator('.approval-detail-head').filter({ visible: true });
const step = (page: Page, name: string) =>
  page.locator('.approval-progress .ant-steps-item').filter({ visible: true }).filter({ hasText: name });

async function openTodo(page: Page) {
  await page.goto('/approval/todos');
  await expect(page.getByRole('heading', { name: '待处理', exact: true }).filter({ visible: true })).toBeVisible();
  await page.locator('.approval-card-action').filter({ visible: true }).first().click();
  await expect(head(page).getByRole('button', { name: /^同意（/ })).toBeVisible();
}

for (const scene of [
  { key: 'rehire', shown: '同意（同时返聘）', hidden: '同意（不返聘）', exit: 'approve_rehire', state: '待办' },
  { key: 'plain', shown: '同意（不返聘）', hidden: '同意（同时返聘）', exit: 'approve_no_rehire', state: '不经过' },
] as const) {
  test(`AC-APV-F478-31 退休 HRBP 办理（${scene.shown}）：按钮来自接口且只显示一个，提交 ${scene.exit}`, async ({
    context,
    page,
    baseURL,
  }) => {
    const persona = manifest[scene.key].hrbp;
    const writes = await signIn(context, baseURL!, persona);
    await openTodo(page);
    await expect(head(page).getByRole('button', { name: scene.shown, exact: true })).toHaveCount(1);
    await expect(head(page).getByRole('button', { name: scene.hidden, exact: true })).toHaveCount(0);
    await expect(step(page, '返聘后经理确认')).toHaveCount(1);
    await expect(step(page, '返聘后经理确认').locator('.ant-steps-item-description')).toHaveText(scene.state);
    await head(page).getByRole('button', { name: scene.shown, exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ visible: true });
    await expect(dialog).toContainText(scene.shown);
    await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
    await expect
      .poll(() => writes.map((write) => [write.path.split('/').at(-1), write.status]))
      .toEqual([['approve', 200]]);
    expect(writes[0]!.body).toMatchObject({ exit: scene.exit });
    const instance = await backendGet<{ path: { nodeKey: string; state: string; exit?: string }[] }>(
      context,
      persona,
      `/api/tenant/approval/instances/${manifest[scene.key].instanceId}`,
    );
    expect(instance.path.find((item) => item.nodeKey === 'hr_interview')).toMatchObject({ exit: scene.exit });
  });
}
