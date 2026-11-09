// @vitest-environment happy-dom
/**
 * F-508 第 1 轮 P2-1：兼职列表切视图期间旧视图不得“接受点击后静默丢弃”。
 * BrowserRouter 以 transition 更新 location，新视图提交前旧表格仍在页面上；选中态按视图存放（list-state.ts），
 * 旧行“查看详情”若被接受，选中态会挂在旧视图上、提交时随视图重置丢掉。这里用一个在目标视图上挂起的组件
 * 把 transition 卡住，模拟“新视图尚未提交”的窗口，在窗口内点旧行，核对点击被明确阻止、提交后也没有残留。
 * 接口形状沿用冒烟夹具（part-time-fixtures / part-time-request-fixtures，对照 PT-5 queries.ts）。
 */
import { act, createElement as h, Suspense, use } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { PermissionsProvider } from '../foundation/Permissions.js';
import { fields, listRecord, request } from '../../smoke/part-time-fixtures.js';
import { PartTimePage } from './PartTimePage.js';

// smoke/fixtures.ts 依赖 Playwright 与文件系统（page-registry），这里只取兼职夹具用到的合成 ID。
vi.mock('../../smoke/fixtures.js', () => ({
  employee: '30000000-0000-4000-8000-000000000001',
  user: '20000000-0000-4000-8000-000000000001',
  snapshotFixture: {},
}));
const snapshot = {
  session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai', today: '2026-10-13' },
  apps: [],
  scope: [],
  adminMenus: [],
};

let host: HTMLDivElement;
let root: Root;
/** 挂起中的目标视图：路由渲染到该视图时挂起，transition 无法提交，页面停在旧视图。 */
let gate: { view: string; promise: Promise<void>; release(): void } | undefined;

function hold(view: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  gate = { view, promise, release };
  return gate;
}
function Gate() {
  const [params] = useSearchParams();
  const view = params.get('view') ?? 'ongoing';
  if (gate && gate.view === view) use(gate.promise);
  return null;
}
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
async function render(url: string) {
  window.history.replaceState(null, '', url);
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: 'synthetic-tenant',
          identityKey: 'synthetic-hr',
          tenantName: '合成租户',
          timezone: 'Asia/Shanghai',
          displayName: '合成管理员',
          source: 'server',
        },
        children: h(PermissionsProvider, {
          children: h(BrowserRouter, null, h(Suspense, { fallback: null }, h(Gate), h(PartTimePage))),
        }),
      }),
    ),
  );
  for (let i = 0; i < 100 && !openButtons().length; i += 1) await settle();
  expect(openButtons().length, '列表行渲染出“查看详情”').toBeGreaterThan(0);
}
const viewButton = (name: string) => host.querySelector<HTMLButtonElement>(`nav button[aria-label="${name}"]`)!;
const openButtons = () =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (node) => node.textContent?.replace(/\s/g, '') === '查看详情',
  );
const drawerTitles = () => [...document.querySelectorAll('.ant-drawer h2')].map((node) => node.textContent);
const rowCodes = () => [...host.querySelectorAll('.part-time-table tbody tr')].map((node) => node.textContent);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  gate = undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname.endsWith('/permission/me/snapshot')) return Response.json(snapshot);
    if (url.pathname.includes('/permission/me/objects/'))
      return Response.json({
        objectCode: decodeURIComponent(url.pathname.split('/').at(-1)!),
        dataOperations: { read: true },
        viewableFields: fields,
        editableFields: [],
        buttons: [],
      });
    if (url.pathname.endsWith('/employment/part-times'))
      return Response.json({
        items: url.searchParams.get('view') === 'in_approval' ? [request] : [listRecord],
        total: 1,
        page: 1,
        pageSize: 30,
        hasDataPermission: true,
      });
    if (url.pathname.includes('/employment/part-time-requests/')) return Response.json(request);
    if (url.pathname.includes('/employment/part-times/')) return Response.json(listRecord);
    return Response.json({ items: [] });
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  gate?.release();
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-FE-R2d2b 切视图期间旧列表不接受操作（F-508 P2-1）', () => {
  it('点“审批中的兼职”后、新视图提交前：旧行“查看详情”被阻止；提交后无残留，新行可正常打开', async () => {
    await render('/part-time');
    const pending = hold('in_approval');
    await act(async () => viewButton('审批中的兼职').click());
    await settle();
    // 窗口内：URL 已是新视图，页面仍是旧视图（兼职中）的行。
    expect(new URLSearchParams(window.location.search).get('view')).toBe('in_approval');
    expect(viewButton('兼职中').getAttribute('aria-pressed')).toBe('true');
    expect(rowCodes().join()).toContain(listRecord.employee.code);
    const stale = openButtons()[0]!;
    await act(async () => stale.click());
    await settle();
    expect(drawerTitles(), '切换期间点击不被接受：不打开旧视图详情').toEqual([]);
    expect(stale.disabled && !!stale.closest('[inert]'), '旧行“查看详情”与旧列表在切换期间不可交互').toBe(true);

    await act(async () => pending.release());
    await settle();
    expect(viewButton('审批中的兼职').getAttribute('aria-pressed')).toBe('true');
    expect(drawerTitles(), '新视图提交后没有残留的旧选中态').toEqual([]);
    expect(openButtons()[0]!.disabled).toBe(false);
    expect(openButtons()[0]!.closest('[inert]')).toBeNull();
    await act(async () => openButtons()[0]!.click());
    await settle();
    expect(drawerTitles()).toEqual(['兼职申请详情']);
  });

  it('浏览器后退（popstate）切回旧视图期间同样阻止旧行操作', async () => {
    await render('/part-time');
    await act(async () => viewButton('审批中的兼职').click());
    await settle();
    expect(viewButton('审批中的兼职').getAttribute('aria-pressed')).toBe('true');
    const pending = hold('ongoing');
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    await act(async () => {
      window.history.back();
      await popped;
    });
    await settle();
    expect(viewButton('审批中的兼职').getAttribute('aria-pressed')).toBe('true');
    const stale = openButtons()[0]!;
    await act(async () => stale.click());
    await settle();
    expect(drawerTitles(), '后退切换期间点击不被接受').toEqual([]);
    expect(stale.disabled && !!stale.closest('[inert]'), '后退切换期间旧列表不可交互').toBe(true);

    await act(async () => pending.release());
    await settle();
    expect(viewButton('兼职中').getAttribute('aria-pressed')).toBe('true');
    expect(drawerTitles()).toEqual([]);
    expect(openButtons()[0]!.disabled).toBe(false);
  });
});
