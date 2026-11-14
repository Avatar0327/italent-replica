/**
 * AC-APV-F326-22（F1 部分）：配置中心目录层级里的「公共变量」「应用变量」登记与可见性。
 * 设计 docs/08_设计/F-326_公共变量应用变量审批矩阵_设计.md §4.4「本期登记」；企业设置「流程矩阵」归 F2a，不在本文件。
 * 浏览器渲染（目录分组、无菜单账号看不到）由 apps/web/smoke/AC-APV-F326-23.smoke.spec.ts 在真实后端上核对。
 */
import { describe, expect, it } from 'vitest';
import { APP_IDS } from '../../packages/domain/src/permission/app-directory.js';
import { APPROVAL_VARIABLE_APPS } from '../../packages/domain/src/approval/type-apps.js';
import { visibleConfigurationPages } from '../../apps/web/src/foundation/configuration-registry.js';
import type { ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';

const MENU = { code: 'matrix.manage', path: '流程矩阵/矩阵管理', editable: true, implemented: true };
const snapshot = (adminMenus: unknown[]) =>
  ({
    apps: [{ app: 'approval', visible: true, entryObjects: ['TenantBase.ApprovalProcess'] }],
    adminMenus,
  }) as unknown as ServerSnapshot;
const route = (id: string) => PAGES.configurations.find((item) => item.id === id);
const variableRoutes = () => PAGES.configurations.filter((item) => item.id.startsWith('app-variables-'));
const appPath = (app: string) =>
  app === 'staff'
    ? '/config-center/workflow/app-variables-staff'
    : `/config-center/apps/${app}/workflow/app-variables-${app}`;

describe('AC-APV-F326-22 公共变量 / 应用变量的配置中心登记', () => {
  it('公共变量挂在全局项，路径 /config-center/global/public-variables，按 matrix.manage 判可见', () => {
    expect(route('public-variables')).toMatchObject({
      label: '公共变量',
      placement: { kind: 'global' },
      path: '/config-center/global/public-variables',
      access: { adminMenu: 'matrix.manage' },
      module: 'approval',
    });
    expect(route('public-variables')?.section).toBeUndefined();
    expect(route('public-variables')?.page?.name).toBe('PublicVariablesPage');
  });

  it('应用变量按审批类型所属应用各一份，挂流程任务管理，staff 沿用组织员工路径', () => {
    expect(new Set(APPROVAL_VARIABLE_APPS)).toEqual(
      new Set(['staff', 'transfer', 'org', 'idp', 'talent-review', 'self']),
    );
    for (const app of APPROVAL_VARIABLE_APPS)
      expect(route(`app-variables-${app}`), app).toMatchObject({
        label: '应用变量',
        placement: { kind: 'app', app },
        section: 'workflow',
        path: appPath(app),
        access: { adminMenu: 'matrix.manage' },
        module: 'approval',
      });
    expect(variableRoutes()).toHaveLength(APPROVAL_VARIABLE_APPS.length);
  });

  it('每个应用容器只有本应用一份；公共变量不进任何应用容器；只有一个应用变量页面组件', () => {
    for (const app of APP_IDS) {
      const own = PAGES.configurations.filter(
        (item) => item.placement.kind === 'app' && item.placement.app === app && item.label === '应用变量',
      );
      expect(
        own.map((item) => item.id),
        app,
      ).toEqual(APPROVAL_VARIABLE_APPS.includes(app) ? [`app-variables-${app}`] : []);
    }
    expect(PAGES.configurations.filter((item) => item.label === '公共变量').map((item) => item.placement)).toEqual([
      { kind: 'global' },
    ]);
    const pages = new Set(variableRoutes().map((item) => item.page));
    expect(pages.size).toBe(1);
    expect([...pages][0]?.name).toBe('AppVariablesPage');
  });

  it('「流程」设计器仍在组织员工 › 流程任务管理，路径与权限不变', () => {
    expect(route('processes')).toMatchObject({
      label: '流程',
      placement: { kind: 'app', app: 'staff' },
      section: 'workflow',
      path: '/config-center/workflow/processes',
      access: { app: 'approval', objectCode: 'TenantBase.ApprovalProcess' },
    });
  });

  it('有 matrix.manage 时公共变量与全部应用变量可见；无该菜单时一个都不可见，流程设计器不受影响', () => {
    const ids = ['public-variables', ...APPROVAL_VARIABLE_APPS.map((app) => `app-variables-${app}`)];
    const granted = visibleConfigurationPages(PAGES.configurations, snapshot([MENU]));
    expect(granted).toEqual(expect.arrayContaining([...ids, 'processes']));
    const other = { code: 'users.all', path: '用户管理/全部用户', editable: false, implemented: true };
    const denied = visibleConfigurationPages(PAGES.configurations, snapshot([other]));
    expect(denied).toEqual(['processes']);
    expect(visibleConfigurationPages(PAGES.configurations, { ...snapshot([]), apps: [] })).toEqual([]);
  });
});
