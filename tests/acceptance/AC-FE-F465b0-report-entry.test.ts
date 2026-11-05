/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { APP_OBJECT_DIRECTORY, MODULE_OBJECTS } from '@italent/domain';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectPages, lazyPage, type MenuRoute } from '../../apps/web/src/foundation/page-registry.js';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { MENU_ROUTES, PAGES, appRoute, routePath } from '../../apps/web/src/foundation/routes.js';
import { ui } from '../../apps/web/src/foundation/messages.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { AppPages } = await import(resolve('apps/web/src/foundation/AppPages.tsx'));
const reports = [MODULE_OBJECTS.hrRoster, MODULE_OBJECTS.hrMovementReport, MODULE_OBJECTS.hrStructureReport];
// F-465b 的登记样例仅存在于测试，不新增运行时菜单；页面内部各报表仍由接口鉴权。
const registry = collectPages(
  {
    '../fixture/pages.ts': {
      pages: {
        apps: [{ app: 'staff', label: '员工', group: 'people' }],
        entries: [
          {
            id: 'fixture-reports',
            app: 'staff',
            group: 'people',
            label: '报表',
            objectCodes: reports.map((object) => object.code),
            page: lazyPage('Fixture', async () => ({ Fixture: () => h('div', {}, '已进入报表页') })),
          },
        ],
      },
    },
  },
  ['staff'],
);
let current = { apps: [] } as unknown as ServerSnapshot;
vi.mock('../../apps/web/src/foundation/Session.js', () => ({
  useSession: () => ({ tenantId: 'fixture', identityKey: 'fixture' }),
}));
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({ loading: false, snapshot: {}, menus: menuNodes(registry.entries, current) }),
}));
const snapshot = (entryObjects: string[], visible = true) =>
  ({ apps: [{ app: 'staff', visible, entryObjects }] }) as ServerSnapshot;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalLength = MENU_ROUTES.length;
beforeAll(() => {
  (MENU_ROUTES as MenuRoute[]).push(...registry.entries);
});
afterAll(() => {
  (MENU_ROUTES as MenuRoute[]).splice(originalLength);
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function open(entryObjects: string[], path = '/fixture-reports/structure', visible = true) {
  current = snapshot(entryObjects, visible);
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: [path] }, h(AppPages)));
  });
}

describe('AC-FE-F465b0 / DEC-803① 报表入口契约', () => {
  it.each(reports)('$code 登记到 staff 目录', ({ code }) => {
    expect(APP_OBJECT_DIRECTORY.staff).toContain(code);
    expect(APP_OBJECT_DIRECTORY.staff[0]).toBe(MODULE_OBJECTS.employee.code);
  });
  it.each(reports)('仅 $code 可看：报表菜单显示，另一报表直链仍交给页面接口鉴权', async ({ code }) => {
    expect(menuNodes(registry.entries, snapshot([code]))).toEqual([
      { key: 'fixture-reports', label: '报表', path: '/fixture-reports', group: 'people' },
    ]);
    await open([code]);
    expect(host.textContent).toContain('已进入报表页');
    expect(routePath('/fixture-reports/structure')?.ungated).toBe(false);
    expect(appRoute('/fixture-reports/structure')?.id).toBe('fixture-reports');
  });
  it.each([{ codes: [] }, { codes: [MODULE_OBJECTS.employee.code] }])(
    '全无报表权 $codes：菜单隐藏、直链拒绝',
    async ({ codes }) => {
      expect(menuNodes(registry.entries, snapshot(codes))).toEqual([]);
      await open(codes);
      expect(host.textContent).toContain(ui.denied);
      expect(host.textContent).not.toContain('已进入报表页');
    },
  );
  it('应用不可见或对象只出现在别的应用时不能放行；空集合默认拒绝', async () => {
    await open([reports[0]!.code], '/fixture-reports', false);
    expect(host.textContent).toContain(ui.denied);
    expect(
      menuNodes(registry.entries, {
        apps: [{ app: 'job', visible: true, entryObjects: reports.map((o) => o.code) }],
      } as ServerSnapshot),
    ).toEqual([]);
    expect(menuNodes([{ ...registry.entries[0]!, objectCodes: [] }], snapshot(reports.map((o) => o.code)))).toEqual([]);
  });
  it('三个既有单对象入口逐字保持：合同、入职、带教子项', () => {
    const existing = [
      ...PAGES.entries.filter((entry) => ['contracts', 'entries'].includes(entry.id)),
      ...PAGES.entries.flatMap((entry) => entry.children ?? []).slice(0, 1),
    ];
    expect(existing).toHaveLength(3);
    for (const entry of existing) {
      const response = {
        apps: [{ app: entry.app, visible: true, entryObjects: [entry.objectCode!] }],
      } as ServerSnapshot;
      expect(menuNodes([entry], response)).toEqual([
        { key: entry.id, label: entry.label, path: entry.path, group: entry.group },
      ]);
      expect(
        menuNodes([entry], { ...snapshot([]), apps: [{ app: entry.app, visible: true, entryObjects: [] }] }),
      ).toEqual([]);
    }
  });
});
