/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { buildPermissionSnapshot } from '../../apps/api/src/modules/permission/me-snapshot.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, StrictMode } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { PermissionsProvider, PermissionObject, Can, usePermissions } = await import(
  resolve('apps/web/src/foundation/Permissions.tsx')
);
const { SessionProvider, useSession } = await import(resolve('apps/web/src/foundation/Session.tsx'));
type ResponseBody = Awaited<ReturnType<typeof buildPermissionSnapshot>>;
const body: ResponseBody = {
  session: {
    tenantId: 'tenant',
    tenantName: '快照租户',
    timezone: 'America/Chicago',
    today: '2026-10-13',
    userId: 'server-user',
    displayName: '快照用户',
    employeeId: null,
  },
  apps: [
    { app: 'job', visible: true, entryObjects: ['TenantBase.JobLayer'] },
    { app: 'manager', visible: false, entryObjects: [] },
    { app: 'settings', visible: true, entryObjects: [] },
    { app: 'approval', visible: true, entryObjects: [] },
  ],
  scope: [
    { app: 'job', status: 'limited', organizationIds: [], truncated: true },
    { app: 'org', status: 'all', organizationIds: [], truncated: false },
    { app: 'staff', status: 'none', organizationIds: [], truncated: false },
  ],
  adminMenus: [{ code: 'users', path: '用户管理', implemented: true, editable: false }],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: { permissions: ReturnType<typeof usePermissions>; session: ReturnType<typeof useSession> };
function Probe() {
  const permissions = usePermissions();
  latest = { permissions, session: useSession() };
  return h('button', { onClick: permissions.refresh }, '刷新');
}
async function render(child = h(Probe)) {
  await act(async () => {
    root.render(
      h(
        StrictMode,
        {},
        h(
          SessionProvider,
          {
            session: {
              tenantId: 'tenant',
              identityKey: 'untrusted-cookie',
              tenantName: '',
              timezone: '',
              displayName: '',
              source: 'server',
            },
          },
          h(PermissionsProvider, {}, h(PermissionObject, { object: 'TenantBase.JobLayer' }, child)),
        ),
      ),
    );
    await new Promise((done) => setTimeout(done, 20));
  });
}
function mockSnapshot(value = body) {
  const fetcher = vi.fn(async (path: string) =>
    path.endsWith('/me/snapshot')
      ? Response.json(value)
      : Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('AC-FE-F114 当前用户快照', () => {
  it('首屏 StrictMode 也只请求一次快照，零对象与业务探测', async () => {
    const fetcher = mockSnapshot();
    await render();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/tenant/permission/me/snapshot']);
  });
  it('应用和企业菜单完全来自快照，经理不因其他对象可见而放行', async () => {
    mockSnapshot();
    await render();
    expect(latest.permissions.menus.map((m: { key: string }) => m.key)).toEqual(['job', 'approval', 'settings']);
    expect(latest.permissions.menus.find((m: { key: string }) => m.key === 'settings')?.children).toMatchObject([
      { key: 'users', editable: false },
    ]);
    expect(latest.permissions.snapshot.source).toBe('server');
  });
  it('Session 名称、时区、身份等全部取自服务端', async () => {
    mockSnapshot();
    await render();
    expect(latest.session).toMatchObject({ ...body.session, identityKey: 'server-user', source: 'server' });
  });
  it('范围 ready 保留 all/limited/none 和截断；无范围应用不补项', async () => {
    mockSnapshot();
    await render();
    expect(latest.permissions.scope).toEqual({ status: 'ready', items: body.scope });
  });
  it.each(['network', '503', '401'])('快照 %s 失败保持空菜单和 unavailable，可重试', async (failure) => {
    const fetcher = vi.fn(async () => {
      if (failure === 'network') throw new TypeError('offline');
      return Response.json({ error: { code: 'FAILED' } }, { status: Number(failure) });
    });
    vi.stubGlobal('fetch', fetcher);
    await render();
    expect(latest.permissions.error).toBeDefined();
    expect(latest.permissions.menus).toEqual([]);
    expect(latest.permissions.scope.status).toBe('unavailable');
    mockSnapshot();
    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(latest.permissions.snapshot.source).toBe('server');
    expect(latest.permissions.menus).toHaveLength(3);
  });
  it.each([true, false])('AC-FE-F114 经理可见性与设置 editable 直接采用服务端 %s', async (visible) => {
    mockSnapshot({
      ...body,
      apps: [
        { app: 'manager', visible, entryObjects: [] },
        { app: 'settings', visible: true, entryObjects: [] },
      ],
      adminMenus: [{ ...body.adminMenus[0]!, editable: visible }],
    });
    await render();
    expect(latest.permissions.menus.some((m: { key: string }) => m.key === 'manager')).toBe(visible);
    expect(latest.permissions.menus.find((m: { key: string }) => m.key === 'settings')?.children?.[0]?.editable).toBe(
      visible,
    );
  });
  it('AC-FE-F114 对象摘要不授予按钮，重复消费者和再次读取共用一份明细', async () => {
    const fetcher = mockSnapshot();
    await render();
    const object = 'TenantBase.JobLayer';
    expect(latest.permissions.snapshot.objects[object]?.summary).toBe(true);
    const detail = {
      objectCode: object,
      dataOperations: {},
      viewableFields: ['name'],
      editableFields: [],
      buttons: [{ buttonCode: 'delete', level: 'detail' }],
    };
    fetcher.mockImplementation(async () => Response.json(detail));
    const signal = new AbortController().signal;
    let results;
    await act(async () => {
      results = await Promise.all([
        latest.permissions.ensure(object, signal),
        latest.permissions.ensure(object, signal),
      ]);
    });
    expect(results).toEqual([detail, detail]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await latest.permissions.ensure(object, signal)).toEqual(detail);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('AC-FE-F114 刷新撤权丢弃明细缓存，旧请求迟到不得恢复授权', async () => {
    const fetcher = mockSnapshot();
    await render();
    let reply!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const pending = latest.permissions.ensure('late-object', new AbortController().signal);
    mockSnapshot({ ...body, apps: [], adminMenus: [] });
    await act(async () => {
      latest.permissions.refresh();
    });
    await act(async () => {
      reply(Response.json({ objectCode: 'late-object', buttons: [{ buttonCode: 'delete', level: 'detail' }] }));
      await pending;
    });
    expect(latest.permissions.menus).toEqual([]);
    expect(latest.permissions.snapshot.objects).toEqual({});
  });
  it('AC-FE-F114 Can 仍可继承页面对象上下文并按需读取按钮明细', async () => {
    const fetcher = vi.fn(async (path: string) =>
      Response.json(
        path.endsWith('/me/snapshot')
          ? body
          : {
              objectCode: 'TenantBase.JobLayer',
              dataOperations: {},
              viewableFields: [],
              editableFields: [],
              buttons: [{ buttonCode: 'delete', level: 'detail' }],
            },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await render(h('div', {}, h(Probe), h(Can, { button: 'delete' }, '允许删除')));
    expect(host.textContent).toContain('允许删除');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/tenant/permission/me/snapshot',
      '/api/tenant/permission/me/objects/TenantBase.JobLayer',
    ]);
  });
});
