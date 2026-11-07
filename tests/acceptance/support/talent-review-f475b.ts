/// <reference lib="dom" />
/**
 * F-475 2/3 盘点 B 的整页挂载：真实 TalentReviewPage、PermissionsProvider、表单内核，只替换 fetch。
 * 夹具按后端真实返回形态写（apps/api/src/modules/talent-review/*-view.ts、config-kit 列表信封）。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { TalentReviewPage } = await import(resolve('apps/web/src/talent-review/TalentReviewPage.tsx'));

export const base = '/api/tenant/talent-review';
export interface Sent {
  method: string;
  url: string;
  ifMatch: string | null;
  key: string | null;
  body: Record<string, unknown>;
}
type Reply = Response | Error | ((sent: Sent) => Response);
export const server = {
  /** 集合路径（如 templates）→ 列表 items；详情按 id 在其中查找。 */
  collections: {} as Record<string, Record<string, unknown>[]>,
  /** 对象编码 → 可见字段 / 可编辑字段 / 按钮。 */
  fields: {} as Record<string, string[]>,
  editable: {} as Record<string, string[]>,
  buttons: ['create', 'update'],
  writes: [] as Sent[],
  /** 写请求的排队回复；空时按真实后端只改带上的字段、revision + 1。 */
  replies: [] as Reply[],
  reads: [] as string[],
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const conflict = () => json({ error: { code: 'REVISION_CONFLICT', message: '记录已被修改' } }, 409);

function write(url: string, init: RequestInit): Response | Promise<Response> {
  const headers = new Headers(init.headers);
  const sent: Sent = {
    method: init.method!,
    url,
    ifMatch: headers.get('if-match'),
    key: headers.get('idempotency-key'),
    body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
  };
  server.writes.push(sent);
  const reply = server.replies.shift();
  if (reply instanceof Error) throw reply;
  if (reply) return typeof reply === 'function' ? reply(sent) : reply;
  const [collection, id] = new URL(url, 'http://local').pathname.replace(`${base}/`, '').split('/');
  const rows = server.collections[collection!]!;
  if (!id) {
    const created = { id: `new-${rows.length}`, revision: 1, ...sent.body };
    rows.push(created);
    return json(created, 201);
  }
  const index = rows.findIndex((row) => row.id === id);
  rows[index] = { ...rows[index], ...sent.body, revision: Number(rows[index]!.revision) + 1 };
  return json(rows[index]);
}

function read(url: string): Response {
  server.reads.push(url);
  if (url.endsWith('/me/snapshot'))
    return json({ session: { tenantId: 't', userId: 'u' }, apps: [], scope: [], adminMenus: [] });
  if (url.includes('/permission/me/objects/')) {
    const objectCode = url.split('/').at(-1)!;
    const fields = server.fields[objectCode] ?? [];
    return json({
      objectCode,
      dataOperations: { view: true, create: true, update: true },
      viewableFields: fields,
      editableFields: server.editable[objectCode] ?? fields,
      buttons: server.buttons.map((buttonCode) => ({ buttonCode, level: buttonCode === 'create' ? 'list' : 'detail' })),
    });
  }
  const path = new URL(url, 'http://local').pathname.replace(`${base}/`, '');
  const [collection, id] = path.split('/');
  const rows = server.collections[collection!];
  if (rows && id) {
    const row = rows.find((item) => item.id === id);
    return row ? json(row) : json({ error: { code: 'NOT_FOUND', message: '不存在' } }, 404);
  }
  if (rows) return json({ page: 1, pageSize: 200, hasDataPermission: true, items: rows });
  return json({ page: 1, pageSize: 200, hasDataPermission: true, items: [] });
}

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
export function resetServer() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  server.collections = {};
  server.fields = {};
  server.editable = {};
  server.buttons = ['create', 'update'];
  server.writes = [];
  server.replies = [];
  server.reads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) =>
      init.method && init.method !== 'GET' ? write(String(path), init) : read(String(path)),
    ),
  );
}
export async function unmount() {
  if (root) await act(() => root!.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
}
export const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
export async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const session = {
    tenantId: 't',
    identityKey: 'u',
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成用户',
    source: 'server',
  };
  await act(async () =>
    root!.render(
      h(
        MemoryRouter,
        { initialEntries: ['/talent-review'] },
        h(SessionProvider, { session }, h(PermissionsProvider, {}, h(TalentReviewPage))),
      ),
    ),
  );
  await settle();
}

export const text = (scope: ParentNode = document.body) => scope.textContent ?? '';
export const squash = (value: string | null | undefined) => (value ?? '').replace(/\s/g, '');
export const buttons = (label: string, scope: ParentNode = document.body) =>
  Array.from(scope.querySelectorAll('button')).filter((b) => squash(b.textContent) === label);
export const button = (label: string, scope: ParentNode = document.body) => buttons(label, scope)[0];
export async function click(element: Element | undefined | null) {
  if (!element) throw new Error('目标元素不存在');
  await act(async () => (element as HTMLElement).click());
  await settle();
}
export async function openTab(label: string) {
  const tab = Array.from(document.body.querySelectorAll('.ant-tabs-tab-btn')).find((node) => node.textContent === label);
  await click(tab);
}
export async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
/** 表头文字（去掉排序、提示等内部标记）；scope 默认整页第一张表。 */
export function headers(scope: ParentNode = document.body) {
  return Array.from(scope.querySelectorAll('thead th')).map((th) => squash(th.textContent));
}
export function headerWidths(scope: ParentNode = document.body) {
  return Array.from(scope.querySelectorAll('colgroup col')).map((col) => (col as HTMLElement).style.width);
}
