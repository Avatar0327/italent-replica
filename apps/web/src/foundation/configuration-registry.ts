import { APP_OBJECT_DIRECTORY, type AppId } from '../../../../packages/domain/src/permission/app-directory.js';
import { matchRoutes } from 'react-router';
import type { ModulePage } from './page-registry.js';
import type { ServerSnapshot } from './permission-snapshot.js';

export const CONFIGURATION_ROOT = '/config-center';
export const CONFIGURATION_SECTIONS = [
  'business',
  'workflow',
  'objects',
  'data',
  'templates',
  'identity',
  'canvas',
  'pages',
  'application',
  'employee-detail',
  'initialization',
] as const;
export type ConfigurationSection = (typeof CONFIGURATION_SECTIONS)[number];
/** 只引用既有服务端入口，不以角色名或前端按钮猜权限。 */
export type ConfigurationAccess = { app: AppId; objectCode: string } | { adminMenu: string };
export interface ConfigurationPageDeclaration {
  readonly id: string;
  readonly label: string;
  readonly section: ConfigurationSection;
  readonly access: ConfigurationAccess;
  /** 未挂载时为只读占位；后续页面可在该路径下继续声明详情等子路由。 */
  readonly page?: ModulePage;
}
export type ConfigurationRoute = ConfigurationPageDeclaration & { readonly path: string; readonly module: string };

export function collectConfigurations(
  declarations: readonly { module: string; configurations?: readonly ConfigurationPageDeclaration[] }[],
): ConfigurationRoute[] {
  const found = declarations.flatMap(({ module, configurations }) =>
    (configurations ?? []).map((entry) => ({
      ...entry,
      module,
      path: `${CONFIGURATION_ROOT}/${entry.section}/${entry.id}`,
    })),
  );
  const seen = new Set<string>();
  for (const entry of found) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || !CONFIGURATION_SECTIONS.includes(entry.section))
      throw new Error(`配置页登记无效：${entry.module}/${entry.id}`);
    if (seen.has(entry.id)) throw new Error(`配置页登记重复：${entry.id}`);
    seen.add(entry.id);
    if ('app' in entry.access && !APP_OBJECT_DIRECTORY[entry.access.app]?.includes(entry.access.objectCode))
      throw new Error(`配置页须引用既有应用对象：${entry.id}`);
    if ('adminMenu' in entry.access && !entry.access.adminMenu) throw new Error(`配置页须引用后台菜单：${entry.id}`);
  }
  return found.sort((a, b) => {
    const section = CONFIGURATION_SECTIONS.indexOf(a.section) - CONFIGURATION_SECTIONS.indexOf(b.section);
    return section || Number(a.id > b.id) - Number(a.id < b.id);
  });
}

export function visibleConfigurationPages(routes: readonly ConfigurationRoute[], snapshot: ServerSnapshot): string[] {
  return routes
    .filter(({ access }) =>
      'adminMenu' in access
        ? snapshot.adminMenus.some((menu) => menu.code === access.adminMenu)
        : snapshot.apps.some(
            (app) => app.app === access.app && app.visible && app.entryObjects.includes(access.objectCode),
          ),
    )
    .map((route) => route.id);
}

/** 与实际挂载使用同一种路径匹配，编码/大小写别名不能绕过守卫。 */
export const isConfigurationPath = (path: string) => !!matchRoutes([{ path: `${CONFIGURATION_ROOT}/*` }], path);
