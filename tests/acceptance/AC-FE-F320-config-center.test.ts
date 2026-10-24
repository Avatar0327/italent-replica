import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { loadSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';

const processObject = 'TenantBase.ApprovalProcess';
afterEach(() => vi.unstubAllGlobals());
async function snapshot(entryObjects: string[], visible = true, adminMenus: unknown[] = []) {
  vi.stubGlobal('fetch', async () =>
    Response.json({
      session: { tenantId: 'synthetic-tenant', userId: 'synthetic-user' },
      apps: [
        { app: 'approval', visible, entryObjects },
        { app: 'settings', visible: adminMenus.length > 0, entryObjects: [] },
      ],
      adminMenus,
      scope: [],
    }),
  );
  return (
    await loadSnapshot(
      createApiClient(() => ({ tenantId: 'synthetic-tenant', identityKey: 'synthetic-user' })),
      new AbortController().signal,
    )
  ).snapshot;
}

describe('AC-FE-F320 配置中心入口最小外壳', () => {
  it('01 服务端授予流程对象才有可见配置页，业务菜单不增加配置中心应用', async () => {
    const result = await snapshot([processObject]);
    expect(result).toHaveProperty('configurationPages', ['processes']);
    expect(result.menus.map((menu) => menu.key)).toEqual(['approval']);
  });
  it.each([
    { entries: [], visible: true },
    { entries: ['TenantBase.ApprovalInstance'], visible: true },
    { entries: [processObject], visible: false },
  ])('02 无配置页权限时集合为空：$entries / $visible', async ({ entries, visible }) => {
    expect(await snapshot(entries, visible)).toHaveProperty('configurationPages', []);
  });
  it('03 企业设置 adminMenus 不自动授予流程配置，原入口完整保留', async () => {
    const result = await snapshot([], true, [{ code: 'users.all', path: '用户管理/全部用户', editable: false }]);
    expect(result).toHaveProperty('configurationPages', []);
    expect(result.menus.find((menu) => menu.key === 'settings')?.children).toEqual([
      {
        key: 'users.all',
        label: '用户管理/全部用户',
        path: '/settings/menu/users.all',
        group: 'settings',
        editable: false,
      },
    ]);
  });
  it('04 流程挂载点由模块 pages.ts 汇入同一个页面注册表', () => {
    expect(PAGES).toHaveProperty('configurations', [
      {
        id: 'processes',
        label: '流程',
        section: 'workflow',
        access: { app: 'approval', objectCode: processObject },
        path: '/config-center/workflow/processes',
        module: 'approval',
      },
    ]);
    expect(PAGES.apps.some((app) => String(app.id) === 'config-center')).toBe(false);
    expect(PAGES.ungated.has('/config-center/*')).toBe(false);
  });
});
