/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-TRF-F481-FE-04（F-481 设计 §8.3、§12）：我的签署。
 * 两页签 待我签署 / 我已签署（tab=pending|done，limit / offset 分页）；行显示场景、发起人、发起时间、截止时间、文件名称、状态；
 * 详情抽屉逐份显示正文快照与两节点进度，可签时显示「确认签署」与“复刻模拟签署”说明；确认期间按钮禁用，确认后刷新详情、
 * 按钮消失；切换页签、关闭抽屉后迟到的旧响应不覆盖新数据；结果未知按 GET /mine/:id 回查，只能按原命令重发。
 * 同一组件同时挂在 电子签 > 我的签署 与 员工自助（/self/esign）。
 * 夹具形状按后端 apps/api esign/mine.ts：列表 mineViews(detail=false) { items }（无 total，无正文）；
 * 详情 mineViews(detail=true) 多 files[].content 与 nodes；确认 signMine → signReceipt（revision +1），
 * 过期 409 CONFLICT ESIGN_TASK_EXPIRED，版本不符 REVISION_CONFLICT；下载 record-routes.ts /mine/:id/files。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, Suspense } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { App, ConfigProvider } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { PAGES, MENU_ROUTES } = await import(resolve('apps/web/src/foundation/routes.ts'));
const { menuNodes } = await import(resolve('apps/web/src/foundation/permission-snapshot.ts'));

const RECORD_OBJECT = 'TenantBase.ESignRecord';
const MINE = '/api/tenant/esign/mine';
const session = {
  tenantId: '10000000-0000-4000-8000-000000000482',
  userId: '20000000-0000-4000-8000-000000000482',
  identityKey: 'synthetic',
  tenantName: '合成租户',
  displayName: '合成用户',
  timezone: 'Asia/Shanghai',
  source: 'server',
};
const INITIATOR = '20000000-0000-4000-8000-000000000483';
const id = (n: number) => `84820000-0000-4000-8000-0000000008${String(n).padStart(2, '0')}`;
const M1 = id(1);
const M2 = id(2);
const D1 = id(3);
const D2 = id(4);
type Task = Record<string, unknown> & { id: string; revision: number; files: Record<string, unknown>[] };
const file = (seq: number, templateName: string) => ({
  seq,
  templateId: `74820000-0000-4000-8000-00000000090${seq}`,
  templateName,
  content: `${templateName}正文：合成员工甲调入合成研发部`,
});
const task = (taskId: string, extra: Partial<Task> = {}): Task => ({
  id: taskId,
  revision: 2,
  status: 'signing',
  currentNode: 'employee',
  employeeSignedAt: null,
  enterpriseSignedAt: null,
  completedAt: null,
  scene: 'transfer',
  initiator: { id: INITIATOR, name: '合成发起人' },
  initiatedAt: '2026-11-15T16:30:05.000Z',
  expiresAt: '2026-11-22T15:59:59.000Z',
  canSign: true,
  files: [file(1, '合成调动协议')],
  ...extra,
});
const initial = () => ({
  [M1]: task(M1),
  [M2]: task(M2, { files: [file(1, '合成保密协议')] }),
  [D1]: task(D1, {
    revision: 5,
    status: 'completed',
    currentNode: null,
    employeeSignedAt: '2026-11-15T20:00:00.000Z',
    enterpriseSignedAt: '2026-11-15T22:00:00.000Z',
    completedAt: '2026-11-15T22:00:00.000Z',
    canSign: false,
    files: [file(1, '合成竞业协议'), file(2, '合成岗位说明')],
  }),
  [D2]: task(D2, {
    revision: 3,
    currentNode: 'enterprise',
    employeeSignedAt: '2026-11-15T20:00:00.000Z',
    canSign: false,
    files: [file(1, '合成借调协议')],
  }),
});
const listView = ({ files, ...rest }: Task) => ({ ...rest, files: files.map(({ content: _c, ...item }) => item) });
const detailView = (item: Task) => ({
  ...item,
  nodes: [
    { node: 'employee', userId: session.userId, signedAt: item.employeeSignedAt },
    { node: 'enterprise', userId: INITIATOR, signedAt: item.enterpriseSignedAt },
  ],
});
const receipt = (item: Task) => ({
  id: item.id,
  revision: item.revision,
  status: item.status,
  currentNode: item.currentNode,
  employeeSignedAt: item.employeeSignedAt,
  enterpriseSignedAt: item.enterpriseSignedAt,
  completedAt: item.completedAt,
});
// 员工节点确认后：轮到企业确认，员工不再可签（signMine → applySignEvent）
const signed = (item: Task): Task => ({
  ...item,
  revision: item.revision + 1,
  currentNode: 'enterprise',
  employeeSignedAt: '2026-11-16T03:00:00.000Z',
  canSign: false,
});

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly file?: { readonly type: string; readonly name: string };
}
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
  readonly ifMatch: string | null;
}
type Write = Reply | (() => Reply | Promise<Reply>);
let tasks: Record<string, Task>;
let writes: Write[];
let sent: Sent[];
let fetched: URL[];
let details: Record<string, (() => Promise<Reply>)[]>;
let listGate: { tab: string; gate: Promise<void> } | undefined;
let saved: string[];
const pendingOf = (item: Task) => item.status === 'signing' && item.canSign === true;
const doneOf = (item: Task) => item.employeeSignedAt !== null;
async function replyOf(url: URL, init: RequestInit): Promise<Reply> {
  const path = url.pathname;
  const method = init.method ?? 'GET';
  if (path.endsWith('/me/snapshot')) return { body: { session, apps: [], scope: [], adminMenus: [] } };
  if (path.includes('/permission/me/objects/')) {
    const objectCode = decodeURIComponent(path.split('/').at(-1)!);
    const read = objectCode === RECORD_OBJECT;
    return {
      body: { objectCode, dataOperations: read ? { read } : {}, viewableFields: [], editableFields: [], buttons: [] },
    };
  }
  if (method !== 'GET') {
    const headers = new Headers(init.headers);
    sent.push({
      method,
      path,
      body: JSON.parse(String(init.body)),
      key: headers.get('idempotency-key'),
      ifMatch: headers.get('if-match'),
    });
    const next = writes.shift();
    return (typeof next === 'function' ? await next() : next) ?? { status: 500, body: {} };
  }
  if (path === MINE) {
    const tab = url.searchParams.get('tab') ?? 'pending';
    if (listGate?.tab === tab) await listGate.gate;
    const items = Object.values(tasks)
      .filter(tab === 'pending' ? pendingOf : doneOf)
      .map(listView);
    return { body: { items } };
  }
  const [, taskId, tail] = path.slice(MINE.length).split('/');
  if (tail === 'files') return { file: { type: 'application/pdf', name: `${tasks[taskId!]!.id}.pdf` } };
  if (taskId && tasks[taskId]) return (await details[taskId]?.shift()?.()) ?? { body: detailView(tasks[taskId]) };
  return { status: 404, body: { error: { code: 'NOT_FOUND', message: '签署任务不存在' } } };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  tasks = initial();
  writes = [];
  sent = [];
  fetched = [];
  details = {};
  listGate = undefined;
  saved = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const url = new URL(String(raw), 'http://localhost');
      fetched.push(url);
      const reply = await replyOf(url, init);
      if (!reply.file) return Response.json(reply.body, { status: reply.status ?? 200 });
      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(reply.file.name)}`;
      return new Response(new Blob(['合成文件'], { type: reply.file.type }), {
        status: 200,
        headers: { 'content-type': reply.file.type, 'content-disposition': disposition },
      });
    }),
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:synthetic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Page = { Component: unknown };
type Entry = { id: string; label: string; children?: Entry[]; page?: Page };
const child = (label: string) =>
  (PAGES.entries as Entry[]).find((entry) => entry.label === '电子签')?.children?.find((item) => item.label === label);
const selfRoute = () => (PAGES.routes as { path: string; page: Page }[]).find((route) => route.path === '/self/esign');
const settle = (ms = 30) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
async function mount(page: Page | undefined, path: string) {
  const theme = { token: { motion: false } };
  const node = h(Suspense, { fallback: null }, h(page!.Component as never));
  const shell = h(
    SessionProvider,
    { session },
    h(PermissionsProvider, {}, h(ConfigProvider, { theme }, h(App, {}, node))),
  );
  await act(async () => root.render(h(MemoryRouter, { initialEntries: [path] }, shell)));
  await rendered();
}
async function open() {
  const page = child('我的签署')?.page;
  expect(page, '电子签 > 我的签署 有页面').toBeTruthy();
  await mount(page, '/esign-mine');
}
// 懒加载页：轮询到目标页自己的可见容器就绪（标题对、读取结束），不认 Suspense 隐藏的旧页（FE-05 第 4 轮 P2-1）。
const PAGE_TIMEOUT_MS = 3000;
const visible = (target: HTMLElement | null | undefined) =>
  !!target && !target.closest('[hidden]') && !target.closest('[style*="display: none"]');
function missing() {
  const target = host.querySelector<HTMLElement>('.esign-mine');
  if (!visible(target)) return ['可见的 .esign-mine'];
  const title = target!.querySelector('.page-heading h1')?.textContent;
  return [
    ...(title === '我的签署' ? [] : [`标题「我的签署」（实为 ${title ?? '无'}）`]),
    ...(target!.querySelector('.list-page .ant-spin-spinning, .page-state .ant-spin') ? ['列表读取结束'] : []),
  ];
}
async function rendered(timeout = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (missing().length > 0 && Date.now() < deadline) await settle();
  expect(missing(), `我的签署：${timeout}ms 内页面未就绪，缺`).toEqual([]);
  await settle();
}
const drawer = () => document.querySelector<HTMLElement>('.ant-drawer-open .ant-drawer-content');
function drawerMissing(file: string) {
  const target = drawer();
  if (!visible(target)) return ['打开的详情抽屉'];
  return [
    ...(target!.querySelector('.ant-drawer-title')?.textContent === '签署详情' ? [] : ['标题「签署详情」']),
    ...(target!.querySelector('.ant-spin-spinning, .page-state .ant-spin') ? ['详情读取结束'] : []),
    ...(target!.textContent?.includes(file) ? [] : [`文件「${file}」`]),
  ];
}
async function detailReady(file: string) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (drawerMissing(file).length > 0 && Date.now() < deadline) await settle();
  expect(drawerMissing(file), '签署详情未就绪，缺').toEqual([]);
  await settle();
}
const pressable = (scope: ParentNode | null | undefined, label: string) =>
  Array.from(scope?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (item) => item.textContent?.replace(/\s/g, '') === label,
  );
async function click(element: Element | null | undefined) {
  expect(element, '可点击的元素').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
}
const tab = (label: string) =>
  Array.from(host.querySelectorAll<HTMLElement>('.ant-tabs-tab [role="tab"]')).find(
    (item) => item.textContent === label,
  );
const headers = () => Array.from(host.querySelectorAll('.ant-table-thead th'), (th) => th.textContent?.trim());
const rowOf = (text: string) =>
  Array.from(host.querySelectorAll<HTMLElement>('.ant-table-tbody tr')).find((tr) => tr.textContent?.includes(text));
const lists = () => fetched.filter((url) => url.pathname === MINE);
const detailReads = (taskId: string) => fetched.filter((url) => url.pathname === `${MINE}/${taskId}`);
const noticeText = () => document.querySelector('.ant-message')?.textContent ?? '';
async function openDetail(fileName: string) {
  await click(pressable(rowOf(fileName), '调动电子签署'));
  await detailReady(fileName);
}
async function closeDetail() {
  await click(drawer()?.parentElement?.querySelector('.ant-drawer-close'));
  expect(drawer()).toBeNull();
}
const signButton = () => pressable(drawer(), '确认签署');
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => (release = done));
  return { promise, release };
};
// 冲突、结果未知会把恢复槽留在模块级存储里：在途交错用例各加一条只属于本用例的待签任务，不碰别的用例的槽。
const fresh = (n: number, templateName: string) => {
  const item = task(id(n), { files: [file(1, templateName)] });
  tasks[item.id] = item;
  return item.id;
};
// 签署请求未返回：点确认后关闭抽屉、重开同一任务，重开的详情因共用恢复槽仍禁用按钮
async function reopenWhileSending(fileName: string) {
  await closeDetail();
  await openDetail(fileName);
  expect(signButton()?.disabled, '重开后请求仍在途、按钮禁用').toBe(true);
}

describe('AC-TRF-F481-FE-04 我的签署：列表与详情', () => {
  it('FE-04-01 两页签 待我签署 / 我已签署；行显示场景、发起人、发起时间、截止时间、文件名称、状态', async () => {
    await open();
    expect(Array.from(host.querySelectorAll('.ant-tabs-tab [role="tab"]'), (item) => item.textContent)).toEqual([
      '待我签署',
      '我已签署',
    ]);
    const first = lists().at(-1)!.searchParams;
    expect([first.get('tab'), first.get('offset')]).toEqual(['pending', '0']);
    expect(Number(first.get('limit'))).toBeGreaterThan(0);
    expect(headers()).toEqual(['签署场景', '发起人', '发起时间', '截止时间', '文件名称', '状态']);
    const row = rowOf('合成调动协议')?.textContent ?? '';
    for (const text of [
      '调动电子签署',
      '合成发起人',
      '2026-11-16 00:30:05',
      '2026-11-22 23:59:59',
      '签署中（待员工签署）',
    ])
      expect(row).toContain(text);
    expect(host.querySelectorAll('.ant-table-tbody .ant-table-row')).toHaveLength(2);
    await click(tab('我已签署'));
    await rendered();
    expect(lists().at(-1)!.searchParams.get('tab')).toBe('done');
    expect(rowOf('合成竞业协议')?.textContent).toContain('签署完成');
    expect(rowOf('合成竞业协议')?.textContent).toContain('合成竞业协议，合成岗位说明');
    expect(rowOf('合成借调协议')?.textContent).toContain('签署中（待企业确认）');
    expect(rowOf('合成调动协议'), '待我签署的行不在我已签署').toBeUndefined();
    for (const code of ['transfer', 'signing', 'employee', 'enterprise', 'completed'])
      expect(host.querySelector('.ant-table')?.textContent).not.toContain(code);
  });

  it('FE-04-02 详情：逐份显示正文与两节点进度，可签时显示「确认签署」与“复刻模拟签署”说明；已完成可下载', async () => {
    await open();
    await openDetail('合成调动协议');
    expect(detailReads(M1)).toHaveLength(1);
    const text = drawer()?.textContent ?? '';
    for (const item of [
      '合成调动协议正文：合成员工甲调入合成研发部',
      '员工本人',
      '企业确认',
      '待签署',
      '签署中（待员工签署）',
      '复刻模拟签署，不发送短信、不做实名认证',
    ])
      expect(text).toContain(item);
    expect(signButton()?.disabled).toBe(false);
    expect(pressable(drawer(), '下载文件')).toBeUndefined();
    await closeDetail();
    await click(tab('我已签署'));
    await rendered();
    await openDetail('合成竞业协议');
    const done = drawer()?.textContent ?? '';
    expect(done).toContain('合成竞业协议正文');
    expect(done).toContain('合成岗位说明正文');
    expect(done).toContain('2026-11-16 04:00:00');
    expect(done).toContain('2026-11-16 06:00:00');
    expect(done).not.toContain('复刻模拟签署');
    expect(signButton()).toBeUndefined();
    await click(pressable(drawer(), '下载文件'));
    await settle(60);
    expect(fetched.filter((url) => url.pathname === `${MINE}/${D1}/files`)).toHaveLength(1);
    expect(saved).toEqual([`${D1}.pdf`]);
  });

  it('FE-04-03 确认签署：请求期间按钮禁用；带详情版本、新命令 ID，不带 If-Match；成功后详情刷新、按钮消失、列表刷新', async () => {
    const pending = gate();
    writes = [
      async () => {
        await pending.promise;
        tasks[M1] = signed(tasks[M1]!);
        return { body: receipt(tasks[M1]!) };
      },
    ];
    await open();
    await openDetail('合成调动协议');
    const before = lists().length;
    await click(signButton());
    expect(signButton()?.disabled, '请求期间禁用').toBe(true);
    await click(signButton());
    expect(sent).toEqual([
      { method: 'POST', path: `${MINE}/${M1}/sign`, body: { revision: 2 }, key: expect.any(String), ifMatch: null },
    ]);
    await act(async () => pending.release());
    await settle(60);
    await detailReady('合成调动协议');
    expect(signButton(), '确认后按钮消失').toBeUndefined();
    expect(drawer()?.textContent).toContain('签署中（待企业确认）');
    expect(drawer()?.textContent).toContain('2026-11-16 11:00:00');
    expect(drawer()?.textContent).not.toContain('复刻模拟签署');
    expect(noticeText()).toContain('已确认签署');
    expect(lists().length, '列表已刷新').toBeGreaterThan(before);
    await closeDetail();
    await rendered();
    expect(rowOf('合成调动协议'), '已签的任务离开待我签署').toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('FE-04-04 迟到回调：关闭抽屉后旧的详情响应才到，不覆盖重开后的新数据，确认签署用新版本', async () => {
    const late = gate();
    const stale = { ...tasks[M1]!, revision: 1, files: [{ ...file(1, '合成调动协议'), content: '旧正文快照' }] };
    details[M1] = [
      async () => {
        await late.promise;
        return { body: detailView(stale) };
      },
    ];
    tasks[M1] = { ...tasks[M1]!, files: [{ ...file(1, '合成调动协议'), content: '新正文快照' }] };
    writes = [() => ({ body: receipt((tasks[M1] = signed(tasks[M1]!))) })];
    await open();
    await click(pressable(rowOf('合成调动协议'), '调动电子签署'));
    expect(drawer()).toBeTruthy();
    await closeDetail();
    // 列表行不带正文（mineViews detail=false）：按文件名找行，按正文判详情就绪。
    await click(pressable(rowOf('合成调动协议'), '调动电子签署'));
    await detailReady('新正文快照');
    await act(async () => late.release());
    await settle(60);
    expect(drawer()?.textContent).toContain('新正文快照');
    expect(drawer()?.textContent).not.toContain('旧正文快照');
    await click(signButton());
    await settle(60);
    expect(sent.map((item) => item.body)).toEqual([{ revision: 2 }]);
  });

  it('FE-04-05 迟到回调：待我签署的读取未返回时切到我已签署，旧响应不覆盖', async () => {
    await open();
    const late = gate();
    listGate = { tab: 'pending', gate: late.promise };
    await click(tab('我已签署'));
    await rendered();
    await click(tab('待我签署'));
    await click(tab('我已签署'));
    await rendered();
    await act(async () => late.release());
    await settle(60);
    expect(rowOf('合成竞业协议')).toBeTruthy();
    expect(rowOf('合成调动协议'), '待我签署的旧响应没有落到我已签署').toBeUndefined();
    expect(tab('我已签署')?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('AC-TRF-F481-FE-04 我的签署：被拒与冲突', () => {
  it('FE-04-06 409 签署任务已过期：提示原因、刷新详情，按钮消失，不自动重提', async () => {
    writes = [
      () => {
        tasks[M1] = { ...tasks[M1]!, revision: 3, status: 'expired', currentNode: null, canSign: false };
        return {
          status: 409,
          body: { error: { code: 'CONFLICT', message: '签署任务已过期', details: { reason: 'ESIGN_TASK_EXPIRED' } } },
        };
      },
    ];
    await open();
    await openDetail('合成调动协议');
    await click(signButton());
    await settle(60);
    expect(noticeText()).toContain('签署任务已过期');
    await detailReady('合成调动协议');
    expect(drawer()?.textContent).toContain('已过期');
    expect(signButton()).toBeUndefined();
    await settle(200);
    expect(sent).toHaveLength(1);
  });

  // 冲突留下的槽在旧版本上（真实场景里服务端版本已变，不会回到旧版本）；用 M2，免得锁住后面用例里 M1 的同版本槽。
  it('FE-04-07 409 REVISION_CONFLICT：只提示刷新并重读详情，不自动重提；再点按新版本、新命令 ID 提交', async () => {
    writes = [
      () => {
        tasks[M2] = { ...tasks[M2]!, revision: 3 };
        return { status: 409, body: { error: { code: 'REVISION_CONFLICT', message: '签署任务已变更，请刷新后重试' } } };
      },
      () => ({ body: receipt((tasks[M2] = signed(tasks[M2]!))) }),
    ];
    await open();
    await openDetail('合成保密协议');
    await click(signButton());
    await settle(60);
    expect(noticeText()).toContain('记录已被更新，请刷新后重新提交');
    expect(noticeText()).not.toContain('REVISION_CONFLICT');
    await detailReady('合成保密协议');
    expect(detailReads(M2).length).toBeGreaterThanOrEqual(2);
    await settle(200);
    expect(sent, '不自动重提').toHaveLength(1);
    expect(signButton()?.disabled).toBe(false);
    await click(signButton());
    await settle(60);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.path).toBe(`${MINE}/${M2}/sign`);
    expect(sent[1]!.body).toEqual({ revision: 3 });
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
    await detailReady('合成保密协议');
    expect(signButton()).toBeUndefined();
  });

  // 反向：后端只给本人的签署任务（mine.ts 按本人过滤，别人的 / 已不存在的一律 404 NOT_FOUND），前端不另判权限。
  it('FE-04-10 详情 404（不是本人的签署或已不存在）：抽屉提示“页面或记录不存在”，不显示正文与「确认签署」，不发写请求', async () => {
    details[M1] = [async () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: '签署任务不存在' } } })];
    await open();
    await click(pressable(rowOf('合成调动协议'), '调动电子签署'));
    const alert = () => drawer()?.querySelector('[role="alert"]');
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    while (!alert() && Date.now() < deadline) await settle();
    // 404 统一按“页面或记录不存在”提示（client.ts），不区分是别人的还是已删除
    expect(alert()?.textContent, '抽屉里的错误提示').toContain('页面或记录不存在');
    expect(drawer()?.textContent).not.toContain('合成调动协议正文');
    expect(signButton()).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

// 返工 P2-1：落定回调属于已关闭的旧详情；重开的同任务详情要随结果重读，不能留着旧的 canSign: true。
describe('AC-TRF-F481-FE-04 我的签署：请求在途时关闭重开', () => {
  it('FE-04-11 确认在途时关闭重开：成功回执到达后当前详情重读、显示签后进度、按钮消失，不再发写请求', async () => {
    const X = fresh(5, '合成兼职协议');
    const pending = gate();
    writes = [
      async () => {
        await pending.promise;
        return { body: receipt((tasks[X] = signed(tasks[X]!))) };
      },
    ];
    await open();
    await openDetail('合成兼职协议');
    await click(signButton());
    await reopenWhileSending('合成兼职协议');
    const reads = detailReads(X).length;
    await act(async () => pending.release());
    await settle(60);
    await detailReady('合成兼职协议');
    expect(detailReads(X).length, '当前打开的详情已重读').toBeGreaterThan(reads);
    expect(drawer()?.textContent).toContain('签署中（待企业确认）');
    expect(drawer()?.textContent).toContain('2026-11-16 11:00:00');
    expect(signButton(), '签后按钮消失').toBeUndefined();
    await settle(200);
    expect(sent).toHaveLength(1);
  });

  // 两种 409 都按 mine.ts signMine：版本先于状态校验，本人在另一入口已确认时旧版本得 REVISION_CONFLICT。
  it.each([
    {
      n: 6,
      code: 'ESIGN_TASK_EXPIRED',
      change: (item: Task): Task => ({ ...item, revision: 3, status: 'expired', currentNode: null, canSign: false }),
      error: { code: 'CONFLICT', message: '签署任务已过期', details: { reason: 'ESIGN_TASK_EXPIRED' } },
      notice: '签署任务已过期',
      shown: '已过期',
    },
    {
      n: 7,
      code: 'REVISION_CONFLICT',
      change: signed,
      error: { code: 'REVISION_CONFLICT', message: '签署任务已变更，请刷新后重试' },
      notice: '记录已被更新，请刷新后重新提交',
      shown: '签署中（待企业确认）',
    },
  ])('FE-04-12 确认在途时关闭重开，迟到 409 $code：当前详情重读、显示新状态、按钮消失，不自动重提', async (item) => {
    const X = fresh(item.n, '合成培训协议');
    const pending = gate();
    writes = [
      async () => {
        await pending.promise;
        tasks[X] = item.change(tasks[X]!);
        return { status: 409, body: { error: item.error } };
      },
    ];
    await open();
    await openDetail('合成培训协议');
    await click(signButton());
    await reopenWhileSending('合成培训协议');
    const reads = detailReads(X).length;
    await act(async () => pending.release());
    await settle(60);
    expect(noticeText()).toContain(item.notice);
    await detailReady('合成培训协议');
    expect(detailReads(X).length, '当前打开的详情已重读').toBeGreaterThan(reads);
    expect(drawer()?.textContent).toContain(item.shown);
    expect(signButton(), '不可再签，按钮消失').toBeUndefined();
    await settle(200);
    expect(sent, '不自动重提').toHaveLength(1);
  });
});

describe('AC-TRF-F481-FE-04 我的签署：员工自助挂载', () => {
  it('FE-04-08 员工自助 > 我的签署：/self/esign 挂同一个组件，菜单在员工自助下，同一接口', async () => {
    const route = selfRoute();
    expect(route, '登记了 /self/esign').toBeTruthy();
    expect(route!.page, '与 电子签 > 我的签署 同一个页面').toBe(child('我的签署')?.page);
    const snapshot = { apps: [{ app: 'self', visible: true, entryObjects: [] }], adminMenus: [] };
    const [self] = menuNodes(MENU_ROUTES, snapshot as never) as { key: string; children?: { label: string }[] }[];
    expect(self?.key).toBe('self');
    expect(self?.children?.find((menu) => menu.label === '我的签署')).toMatchObject({ path: '/self/esign' });
    await mount(route!.page, '/self/esign');
    expect(lists().at(-1)!.searchParams.get('tab')).toBe('pending');
    expect(rowOf('合成调动协议')).toBeTruthy();
  });
});

/** 结果未知钉在页面级存储（模块级 store）里，会留到后续用例，所以放在文件最后。 */
describe('AC-TRF-F481-FE-04 我的签署：结果未知', () => {
  it('FE-04-09 结果未知：自动按 GET /mine/:id 回查并锁定；关闭重开仍锁定、不另起命令；按原命令重发后完成', async () => {
    writes = [
      { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } } },
      () => ({ body: receipt((tasks[M1] = signed(tasks[M1]!))) }),
    ];
    await open();
    await openDetail('合成调动协议');
    const reads = detailReads(M1).length;
    await click(signButton());
    await settle(60);
    expect(drawer()?.textContent).toContain('结果待确认');
    expect(detailReads(M1).length, '已按 GET /mine/:id 回查').toBeGreaterThan(reads);
    expect(drawer()?.textContent).toContain('回查状态：签署中（待员工签署）');
    expect(signButton()?.disabled).toBe(true);
    await click(signButton());
    expect(sent).toHaveLength(1);
    await closeDetail();
    await openDetail('合成调动协议');
    expect(drawer()?.textContent).toContain('结果待确认');
    expect(signButton()?.disabled, '重开仍锁定').toBe(true);
    expect(sent).toHaveLength(1);
    await click(pressable(drawer(), '按原命令重发'));
    await settle(60);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    await detailReady('合成调动协议');
    expect(drawer()?.textContent).not.toContain('结果待确认');
    expect(signButton()).toBeUndefined();
    expect(drawer()?.textContent).toContain('签署中（待企业确认）');
  });

  // 同 P2-1 的重发路径：重发回执也落在已关闭的旧详情上。
  it('FE-04-13 按原命令重发在途时关闭重开：重发成功后当前详情重读、按钮消失，不另起命令', async () => {
    const X = fresh(8, '合成轮岗协议');
    const pending = gate();
    writes = [
      { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } } },
      async () => {
        await pending.promise;
        return { body: receipt((tasks[X] = signed(tasks[X]!))) };
      },
    ];
    await open();
    await openDetail('合成轮岗协议');
    await click(signButton());
    await settle(60);
    expect(drawer()?.textContent).toContain('结果待确认');
    await click(pressable(drawer(), '按原命令重发'));
    await reopenWhileSending('合成轮岗协议');
    const reads = detailReads(X).length;
    await act(async () => pending.release());
    await settle(60);
    await detailReady('合成轮岗协议');
    expect(detailReads(X).length, '当前打开的详情已重读').toBeGreaterThan(reads);
    expect(drawer()?.textContent).not.toContain('结果待确认');
    expect(drawer()?.textContent).toContain('签署中（待企业确认）');
    expect(signButton(), '签后按钮消失').toBeUndefined();
    await settle(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key, '重发沿用原命令 ID').toBe(sent[0]!.key);
  });
});
