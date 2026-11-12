import { APP_IDS, APP_OBJECT_DIRECTORY, type AppId } from '../../../../packages/domain/src/permission/app-directory.js';
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
interface ConfigurationPage {
  readonly id: string;
  readonly label: string;
  readonly access: ConfigurationAccess;
  /** 未挂载时为只读占位；后续页面可在该路径下继续声明详情等子路由。 */
  readonly page?: ModulePage;
}
export type ConfigurationPlacement = { readonly kind: 'global' } | { readonly kind: 'app'; readonly app: AppId };
/** F-326 §4.4：未声明 placement 的既有项仍属于组织员工。 */
export type ConfigurationPageDeclaration = ConfigurationPage &
  (
    | { readonly placement: { readonly kind: 'global' }; readonly section?: never }
    | { readonly placement?: { readonly kind: 'app'; readonly app: AppId }; readonly section: ConfigurationSection }
  );
export type ConfigurationRoute = ConfigurationPage & {
  readonly section?: ConfigurationSection;
  readonly placement: ConfigurationPlacement;
  readonly path: string;
  readonly module: string;
};

export function configurationSectionPath(app: AppId, section: ConfigurationSection): string {
  const root = app === 'staff' ? CONFIGURATION_ROOT : `${CONFIGURATION_ROOT}/apps/${app}`;
  return `${root}/${section}`;
}

export function collectConfigurations(
  declarations: readonly { module: string; configurations?: readonly ConfigurationPageDeclaration[] }[],
): ConfigurationRoute[] {
  if (CONFIGURATION_SECTIONS.some((section: string) => section === 'global' || section === 'apps'))
    throw new Error('配置页目录无效：global / apps 为保留字');
  const found: ConfigurationRoute[] = declarations.flatMap(({ module, configurations }) =>
    (configurations ?? []).map((entry) => {
      const placement = entry.placement ?? { kind: 'app', app: 'staff' };
      const validPlacement =
        placement.kind === 'global'
          ? !('section' in entry)
          : placement.kind === 'app' &&
            APP_IDS.includes(placement.app) &&
            entry.section !== undefined &&
            CONFIGURATION_SECTIONS.includes(entry.section);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || !validPlacement)
        throw new Error(`配置页登记无效：${module}/${entry.id}`);
      const parent =
        placement.kind === 'global'
          ? `${CONFIGURATION_ROOT}/global`
          : configurationSectionPath(placement.app, entry.section!);
      return { ...entry, placement, module, path: `${parent}/${entry.id}` };
    }),
  );
  const seen = new Set<string>();
  for (const entry of found) {
    if (seen.has(entry.id)) throw new Error(`配置页登记重复：${entry.id}`);
    seen.add(entry.id);
    if ('app' in entry.access && !APP_OBJECT_DIRECTORY[entry.access.app]?.includes(entry.access.objectCode))
      throw new Error(`配置页须引用既有应用对象：${entry.id}`);
    if ('adminMenu' in entry.access && !entry.access.adminMenu) throw new Error(`配置页须引用后台菜单：${entry.id}`);
  }
  return found.sort((a, b) => {
    const appOrder = (route: ConfigurationRoute) =>
      route.placement.kind === 'global' ? -1 : APP_IDS.indexOf(route.placement.app);
    const sectionOrder = (route: ConfigurationRoute) =>
      route.section === undefined ? -1 : CONFIGURATION_SECTIONS.indexOf(route.section);
    return appOrder(a) - appOrder(b) || sectionOrder(a) - sectionOrder(b) || Number(a.id > b.id) - Number(a.id < b.id);
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
