/**
 * F-326 F2b 浏览器集成（AC-APV-F326-25）：真实后端（隔离库 + 合成数据）+ 真实浏览器。
 * 矩阵、候选、权限快照一律代理到 f326f2a-live-server（加载 f326f2b-live-backend 预置），不造业务响应：
 * 列增删改、行添加 / 复制 / 删除 / 调序 / 批量删除都只改本地草稿，保存时一次 PUT structure；
 * 列数上限提示；他人先改（同一合成 HR 直接写后端）后保存得 409，重读核对后按新 revision 显式重提。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

interface Manifest {
  url: string;
  tenant: string;
  user: string;
  matrix: string;
}
interface Call {
  method: string;
  path: string;
  status: number;
  key: string | undefined;
  body: unknown;
}
interface Detail {
  revision: number;
  columns: { id: string; seq: number; kind: string; dimension: string | null; name: string }[];
  rows: { id: string; seq: number; cells: Record<string, string[]> }[];
}

const MATRICES = '/api/tenant/approval/matrices';
// Playwright 进程解析不到工作区源码包，上限照抄 packages/domain CONDITION_COLUMNS
const CONDITION_COLUMNS = 5;
let backend: ChildProcess;
let manifest: Manifest;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  const server = fileURLToPath(new URL('./f326f2a-live-server.mjs', import.meta.url));
  backend = spawn(process.execPath, [server, '/apps/web/smoke/f326f2b-live-backend.ts'], {
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
    backend.once('exit', (code) => reject(new Error(`F2b backend exited ${code}: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

/** 浏览器的 /api/tenant/** 全部转到真实后端；记录矩阵请求的方法、路径、状态与命令 ID。 */
async function live(context: BrowserContext, baseURL: string) {
  await context.addCookies([
    { name: 'italent_demo_tenant', value: manifest.tenant, url: baseURL },
    { name: 'italent_demo_user', value: manifest.user, url: baseURL },
  ]);
  const calls: Call[] = [];
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await context.request.fetch(`${manifest.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), 'x-f2a-user': manifest.user },
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
    return route.fulfill({ response });
  });
  return calls;
}

/** 直接读写真实后端（不经浏览器）：核对落库结果、模拟他人先改。 */
function direct(request: APIRequestContext) {
  const headers = { 'x-f2a-user': manifest.user, 'x-tenant-id': manifest.tenant };
  const path = `${manifest.url}${MATRICES}/${manifest.matrix}`;
  return {
    async read() {
      const response = await request.get(path, { headers });
      expect(response.status()).toBe(200);
      return (await response.json()) as Detail;
    },
    /** 他人改列名：按最新详情原样回写结构，只换第一列的名字。 */
    async rename(name: string) {
      const detail = await this.read();
      const columns = [...detail.columns].sort((a, b) => a.seq - b.seq);
      const keys = new Map(columns.map((column, index) => [column.id, `k${index}`]));
      const response = await request.put(`${path}/structure`, {
        headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        data: {
          revision: detail.revision,
          columns: columns.map((column, index) => ({
            ...column,
            seq: undefined,
            key: keys.get(column.id),
            name: index === 0 ? name : column.name,
          })),
          rows: [...detail.rows]
            .sort((a, b) => a.seq - b.seq)
            .map((row) => ({
              id: row.id,
              cells: Object.fromEntries(columns.map((column) => [keys.get(column.id), row.cells[column.id] ?? []])),
            })),
        },
      });
      expect(response.status()).toBe(200);
    },
  };
}

/** antd 两个汉字的按钮会插入空格（“保 存”）。 */
const two = (name: string) => new RegExp(`^${[...name].join('\\s*')}$`);
const editor = (page: Page) => page.locator('.matrix-structure');
const columnRows = (page: Page) => editor(page).locator('.matrix-columns tbody tr.ant-table-row');
const dataRows = (page: Page) => editor(page).locator('.matrix-rows tbody tr.ant-table-row');
const nameInput = (page: Page, index: number) => columnRows(page).nth(index).getByLabel('列名');
const rowButton = (page: Page, index: number, name: string) =>
  dataRows(page)
    .nth(index)
    .getByRole('button', { name: name.length === 2 ? two(name) : name });
const button = (page: Page, name: string) => editor(page).getByRole('button', { name });
/** 每行第一个条件单元格的已选名称（部门名），用来核对行顺序。 */
const firstCells = (page: Page) =>
  dataRows(page).evaluateAll((rows) =>
    rows.map((row) =>
      [...(row.querySelector('td.matrix-cell')?.querySelectorAll('.ant-select-selection-item-content') ?? [])]
        .map((item) => item.textContent)
        .join('、'),
    ),
  );

/** 保存成功没有提示条：等到第 n 个 PUT 回来、草稿与新基线一致（撤销修改变灰）。 */
async function saved(page: Page, puts: () => Call[], count: number) {
  await expect.poll(() => puts().length).toBe(count);
  await expect(button(page, '撤销修改')).toBeDisabled();
}

async function open(page: Page) {
  await page.goto('/settings/menu/matrix.manage');
  await page.locator('.matrix-list tbody tr', { hasText: '合成结构矩阵' }).click();
  await expect(page.locator('.matrix-head')).toContainText('合成结构矩阵');
  await expect(dataRows(page)).toHaveCount(3);
}

test('AC-APV-F326-25 列增删改、行添加 / 复制 / 删除 / 调序 / 批量删除，一次 PUT 保存并落库', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const calls = await live(context, baseURL!);
  const puts = () => calls.filter((call) => call.method === 'PUT');
  await open(page);
  // 已选值显示真实名称（详情 referenceNames）：部门名、人员姓名
  await expect(dataRows(page).nth(0)).toContainText('合成中心');
  await expect(dataRows(page).nth(0)).toContainText('合成甲');
  await expect(columnRows(page)).toHaveCount(2);

  // 列：改名（首尾空格提交时去掉）、新增角色列、新增条件列后又删掉
  await nameInput(page, 1).fill('  一级审批人  ');
  await button(page, '添加审批角色列').click();
  await nameInput(page, 2).fill('复核人');
  await button(page, '添加审批条件列').click();
  // 新条件列排在条件列之后、角色列之前
  await expect(columnRows(page)).toHaveCount(4);
  await expect(columnRows(page).nth(1)).toContainText('审批条件');
  await columnRows(page)
    .nth(1)
    .getByRole('button', { name: two('删除') })
    .click();
  await expect(columnRows(page)).toHaveCount(3);
  await expect(editor(page).locator('.matrix-rows thead')).toContainText('复核人');

  // 新列单元格：真实人员候选里选合成乙
  const picker = editor(page).getByRole('combobox', { name: '第1行「复核人」' });
  await picker.click();
  await picker.fill('合成乙');
  await page.locator('.ant-select-item-option', { hasText: '合成乙' }).first().click();
  await page.keyboard.press('Escape');
  await expect(dataRows(page).nth(0)).toContainText('合成乙');

  // 行：复制第 1 行（插到其后）、在第 2 行后添加空行再删掉、第 4 行上移、勾选两行批量删除
  await rowButton(page, 0, '复制').click();
  await expect(dataRows(page)).toHaveCount(4);
  await expect.poll(() => firstCells(page)).toEqual(['合成中心', '合成中心', '合成子部门', '合成人员部门']);
  await rowButton(page, 1, '添加').click();
  await expect(dataRows(page)).toHaveCount(5);
  await rowButton(page, 2, '删除').click();
  await expect(dataRows(page)).toHaveCount(4);
  await rowButton(page, 3, '上移').click();
  await expect.poll(() => firstCells(page)).toEqual(['合成中心', '合成中心', '合成人员部门', '合成子部门']);
  await expect(editor(page).locator('.matrix-seq')).toHaveText(['1', '2', '3', '4']);
  await dataRows(page).nth(1).getByRole('checkbox').check();
  await dataRows(page).nth(3).getByRole('checkbox').check();
  await button(page, '批量删除').click();
  await expect.poll(() => firstCells(page)).toEqual(['合成中心', '合成人员部门']);

  // 以上全是本地草稿：还没有任何写请求；保存时一次 PUT
  expect(puts()).toEqual([]);
  const before = await direct(request).read();
  await button(page, '保存结构').click();
  await saved(page, puts, 1);
  const [put] = puts();
  expect(put).toMatchObject({ path: `${MATRICES}/${manifest.matrix}/structure`, status: 200 });
  expect(put!.key).toBeTruthy();
  expect(put!.body).toMatchObject({ revision: before.revision });
  const body = put!.body as { columns: { name: string; id?: string }[]; rows: { id?: string }[] };
  expect(body.columns.map((column) => column.name)).toEqual(['条件', '一级审批人', '复核人']);
  expect(body.columns.map((column) => Boolean(column.id))).toEqual([true, true, false]);
  // 保留的两行沿用原行 ID（第 1 行与原第 3 行），不是删了重建
  expect(body.rows.map((row) => row.id)).toEqual([before.rows[0]!.id, before.rows[2]!.id]);

  // 落库：列名、列数、行顺序与草稿一致；刷新后编辑区按新结构显示
  const after = await direct(request).read();
  expect(after.revision).toBe(before.revision + 1);
  expect([...after.columns].sort((a, b) => a.seq - b.seq).map((column) => column.name)).toEqual(
    body.columns.map((column) => column.name),
  );
  expect([...after.rows].sort((a, b) => a.seq - b.seq).map((row) => row.id)).toEqual(body.rows.map((row) => row.id));
  await page.reload();
  await page.locator('.matrix-list tbody tr', { hasText: '合成结构矩阵' }).click();
  await expect(dataRows(page)).toHaveCount(2);
  await expect.poll(() => firstCells(page)).toEqual(['合成中心', '合成人员部门']);
  await expect(dataRows(page).nth(0)).toContainText('合成乙');
  await expect(nameInput(page, 1)).toHaveValue('一级审批人');
});

test('AC-APV-F326-25 列数到上限：添加按钮禁用并提示上限；撤销修改回到已保存结构，不发写请求', async ({
  page,
  context,
  baseURL,
}) => {
  const calls = await live(context, baseURL!);
  await page.goto('/settings/menu/matrix.manage');
  await page.locator('.matrix-list tbody tr', { hasText: '合成结构矩阵' }).click();
  await expect(columnRows(page)).toHaveCount(3);
  // 已有 1 个条件列；新条件列依次插在第 i 位（条件列之后、角色列之前）
  for (let i = 1; i < CONDITION_COLUMNS; i += 1) {
    await button(page, '添加审批条件列').click();
    await nameInput(page, i).fill(`合成条件${i}`);
  }
  await expect(button(page, '添加审批条件列')).toBeDisabled();
  await expect(editor(page)).toContainText(`审批条件列已达上限${CONDITION_COLUMNS}列`);
  await expect(button(page, '添加审批角色列')).toBeEnabled();
  await button(page, '撤销修改').click();
  await expect(columnRows(page)).toHaveCount(3);
  await expect(button(page, '添加审批条件列')).toBeEnabled();
  expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('AC-APV-F326-25 他人先改：保存得 409，锁定草稿；重读最新版本核对后按新 revision 显式重提', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const calls = await live(context, baseURL!);
  const puts = () => calls.filter((call) => call.method === 'PUT');
  await page.goto('/settings/menu/matrix.manage');
  await page.locator('.matrix-list tbody tr', { hasText: '合成结构矩阵' }).click();
  await expect(dataRows(page)).toHaveCount(2);
  await nameInput(page, 2).fill('二级复核人');

  // 浏览器打开之后他人改了第一列的名字：revision 前进
  await direct(request).rename('他人改的条件');
  const latest = await direct(request).read();
  await button(page, '保存结构').click();
  await expect(editor(page)).toContainText('版本冲突');
  expect(puts()).toHaveLength(1);
  expect(puts()[0]).toMatchObject({ status: 409, body: { revision: latest.revision - 1 } });
  await expect(nameInput(page, 2)).toBeDisabled();
  await expect(button(page, '保存结构')).toBeDisabled();

  // 重读最新版本：冲突区逐处列出他人的改动；他人改了、我没改的列名回填，我改的列名保留
  await button(page, '重读最新版本').click();
  await expect(editor(page)).toContainText('列「条件」·列名（已采用最新值）');
  await expect(nameInput(page, 0)).toHaveValue('他人改的条件');
  await button(page, '已核对差异，继续编辑').click();
  await expect(nameInput(page, 2)).toBeEnabled();
  await expect(nameInput(page, 2)).toHaveValue('二级复核人');
  expect(puts()).toHaveLength(1);

  // 显式重提：新 revision、新命令 ID；落库同时带着他人的列名与我的列名（第 2 轮：三方合并，不再整份覆盖）
  await button(page, '保存结构').click();
  await saved(page, puts, 2);
  expect(puts()[1]).toMatchObject({ status: 200, body: { revision: latest.revision } });
  expect(puts()[1]!.key).not.toBe(puts()[0]!.key);
  const stored = await direct(request).read();
  expect([...stored.columns].sort((a, b) => a.seq - b.seq).map((column) => column.name)).toEqual([
    '他人改的条件',
    '一级审批人',
    '二级复核人',
  ]);
});
