/**
 * F-326 F2a 页面测试的合成后端与渲染夹具。接口形状照 apps/api/src/modules/approval/matrix-routes.ts / matrices.ts /
 * source-usages.ts（列表 {items,offset,limit,hasMore}、详情 = 头部 + columns/rows/referenceNames、引用 {items,total}），
 * 真实接口另由 smoke/AC-APV-F326-24.smoke.spec.ts 经隔离库核对。数据全部合成。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { App } from 'antd';
import { vi } from 'vitest';
import { SessionProvider } from '../../foundation/Session.js';
import { PermissionsProvider } from '../../foundation/Permissions.js';
import { SettingsPage } from '../../settings/SettingsPage.js';

export const BASE = '/api/tenant/approval/matrices';
const USER = '20000000-0000-4000-8000-000000000326';
export const ids = {
  a: '81000000-0000-4000-8000-000000000001',
  b: '81000000-0000-4000-8000-000000000002',
  c: '81000000-0000-4000-8000-000000000003',
};
export interface Head {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: 'draft' | 'enabled' | 'disabled';
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}
export interface Reference {
  processId: string;
  processCode: string;
  processName: string;
  approvalType: string;
  versionKind: 'draft' | 'current' | 'in_flight';
  versionNo: number;
  nodeKey: string;
  nodeName: string;
  position: 'approver' | 'empty_approver';
  columnId: string | null;
  instanceCount: number | null;
}
export const head = (over: Partial<Head> & Pick<Head, 'id' | 'code' | 'name'>): Head => ({
  description: null,
  status: 'enabled',
  revision: 1,
  createdBy: USER,
  createdAt: '2026-11-10T03:00:00.000Z',
  updatedBy: USER,
  updatedAt: '2026-11-10T03:00:00.000Z',
  ...over,
});
export const reference = (over: Partial<Reference> = {}): Reference => ({
  processId: '82000000-0000-4000-8000-000000000001',
  processCode: 'P_SYNTH',
  processName: '合成来源流程',
  approvalType: 'transfer',
  versionKind: 'draft',
  versionNo: 1,
  nodeKey: 'n1',
  nodeName: '会签节点',
  position: 'approver',
  columnId: '83000000-0000-4000-8000-000000000001',
  instanceCount: null,
  ...over,
});
export interface Write {
  method: string;
  path: string;
  body: Record<string, unknown>;
  key: string | null;
}
type Fail = (write: Write) => Response | Promise<Response> | undefined;

function list(db: Map<string, Head>, url: URL) {
  const status = url.searchParams.get('status') ?? 'active';
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const rows = [...db.values()]
    .filter((item) => (status === 'active' ? item.status !== 'disabled' : item.status === 'disabled'))
    .filter((item) => !q || item.code.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
    .sort((x, y) => x.code.localeCompare(y.code));
  return { items: rows.slice(offset, offset + limit), offset, limit, hasMore: rows.length > offset + limit };
}
function seed(db: Map<string, Head>, refs: Map<string, { items: Reference[]; total?: number }>) {
  for (const item of [
    head({ id: ids.a, code: 'APPROVE_A', name: '合成矩阵甲', description: '合成描述', revision: 3 }),
    head({ id: ids.b, code: 'BUDGET_B', name: '合成矩阵乙', status: 'draft' }),
    head({ id: ids.c, code: 'COST_C', name: '合成矩阵丙', status: 'disabled', revision: 2 }),
  ])
    db.set(item.id, item);
  refs.set(ids.a, {
    items: [
      reference(),
      reference({ versionKind: 'in_flight', nodeKey: 'n2', nodeName: '复核节点', instanceCount: 3 }),
    ],
  });
}

/** 合成后端：按真实契约维护矩阵头部、版本与引用；fail 可截下一次写请求（409、结果未知、坏回执）。 */
export function fakeBackend() {
  const db = new Map<string, Head>();
  const refs = new Map<string, { items: Reference[]; total?: number }>();
  const writes: Write[] = [];
  const reads: URL[] = [];
  const state = { fail: undefined as Fail | undefined, created: 0 };
  const detail = (item: Head) => ({ ...item, columns: [], rows: [], referenceNames: {} });
  const error = (status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
    Response.json({ error: { code, message, details } }, { status });
  const references = (id: string) => refs.get(id) ?? { items: [] };
  function write(item: Head, body: Record<string, unknown>, change: Partial<Head>) {
    if (body.revision !== item.revision) return error(409, 'REVISION_CONFLICT', '审批数据已变更，请刷新后显式重提');
    const next = { ...item, ...change, revision: item.revision + 1 };
    db.set(item.id, next);
    return Response.json(detail(next));
  }
  async function handle(raw: string, init?: RequestInit): Promise<Response> {
    const url = new URL(raw, 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/me/snapshot')) return Response.json({ apps: [], scope: [], adminMenus: [] });
    if (!url.pathname.startsWith(BASE)) return Response.json({ items: [] });
    const [, id, action] = url.pathname.slice(BASE.length).split('/');
    if (method === 'GET') {
      reads.push(url);
      if (!id) return Response.json(list(db, url));
      const item = db.get(id);
      if (!item) return error(404, 'NOT_FOUND', '审批矩阵不存在');
      if (action === 'references') {
        const found = references(id);
        return Response.json({ items: found.items, total: found.total ?? found.items.length });
      }
      return Response.json(detail(item));
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const entry = { method, path: url.pathname, body, key: new Headers(init?.headers).get('idempotency-key') };
    writes.push(entry);
    const failed = await state.fail?.(entry);
    state.fail = undefined;
    if (failed) return failed;
    if (!id) {
      state.created += 1;
      const created = head({
        id: `81000000-0000-4000-8000-0000000009${String(state.created).padStart(2, '0')}`,
        code: String(body.code),
        name: String(body.name),
        description: (body.description as string | null | undefined) ?? null,
        status: body.enable ? 'enabled' : 'draft',
      });
      db.set(created.id, created);
      return Response.json(detail(created), { status: 201 });
    }
    const item = db.get(id)!;
    if (method === 'PATCH') {
      const { revision: _revision, ...fields } = body;
      return write(item, body, fields as Partial<Head>);
    }
    if (action === 'enable') {
      if (item.status === 'enabled') return error(409, 'CONFLICT', '矩阵当前状态不支持该操作');
      return write(item, body, { status: 'enabled' });
    }
    if (item.status !== 'enabled') return error(409, 'CONFLICT', '矩阵当前状态不支持该操作');
    const total = references(id).total ?? references(id).items.length;
    if (body.revision === item.revision && total !== (body.acknowledgedReferenceCount ?? 0))
      return error(409, 'CONFLICT', '引用该对象的流程节点已变化，请重新查看影响后再确认', { referenceCount: total });
    return write(item, body, { status: 'disabled' });
  }
  seed(db, refs);
  return { db, refs, writes, reads, state, handle, error };
}
export type FakeBackend = ReturnType<typeof fakeBackend>;

export const session = {
  tenantId: '10000000-0000-4000-8000-000000000326',
  userId: USER,
  identityKey: 'synthetic',
  tenantName: '合成租户',
  displayName: '合成管理员',
  timezone: 'Asia/Shanghai',
  source: 'server' as const,
};

export const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};
const squash = (value: string | null | undefined) => (value ?? '').replace(/\s/g, '');
export const text = (scope: ParentNode = document.body) => squash((scope as HTMLElement).textContent);
export const buttons = (scope: ParentNode = document) =>
  [...scope.querySelectorAll('button, [role="tab"]')].map((node) => squash(node.textContent));
export function find(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLElement>('button, [role="tab"]')].find(
    (node) => squash(node.textContent) === label,
  );
}
export async function click(label: string, scope: ParentNode = document) {
  const button = find(label, scope);
  if (!button) throw new Error(`找不到按钮：${label}；现有 ${buttons(scope).join(' | ')}`);
  await act(async () => button.click());
  await settle();
}
export async function clickNode(node: Element | null | undefined) {
  if (!node) throw new Error('找不到节点');
  await act(async () => (node as HTMLElement).click());
  await settle();
}
export async function type(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!input) throw new Error('找不到输入框');
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(2);
}
/** 最上层的弹窗（表单 / 确认 / 引用清单可能叠放）。 */
export const dialog = () => [...document.querySelectorAll<HTMLElement>('.ant-modal')].at(-1);
export const dialogs = () => [...document.querySelectorAll<HTMLElement>('.ant-modal')];

/** 经企业设置路由渲染（与真实入口一致）：/settings/menu/:code。菜单由测试 mock 的 usePermissions 给出。 */
export function harness(backend: FakeBackend) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => backend.handle(String(input), init)),
  );
  let host = document.createElement('div');
  document.body.append(host);
  let root: Root = createRoot(host);
  const render = async (path = '/settings/menu/matrix.manage') => {
    await act(async () =>
      root.render(
        h(
          MemoryRouter,
          { initialEntries: [path] },
          h(SessionProvider, {
            session,
            children: h(PermissionsProvider, {
              children: h(App, {}, h(Routes, {}, h(Route, { path: '/settings/menu/:code', element: h(SettingsPage) }))),
            }),
          }),
        ),
      ),
    );
    await settle(20);
  };
  return {
    render,
    /** 离开页面（卸载）再回来：模块级命令存储应保留结果未知的命令。 */
    async remount(path?: string) {
      await act(async () => root.unmount());
      host.remove();
      document.body.innerHTML = '';
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await render(path);
    },
    async close() {
      await act(async () => root.unmount());
      host.remove();
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
    },
  };
}
