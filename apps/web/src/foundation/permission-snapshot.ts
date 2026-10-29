import { APP_OBJECT_DIRECTORY } from '@italent/domain';
import type { buildPermissionSnapshot } from '../../../api/src/modules/permission/me-snapshot.js';
import { ApiError, type ApiClient } from './client.js';
import type { ObjectPermission } from './permission-model.js';
import { visibleConfigurationPages } from './configuration-registry.js';
import { isEntry } from './page-registry.js';
import { PAGES, MENU_ROUTES, type AppRoute, type MenuRoute } from './routes.js';

// 只引用后端推导类型，运行时不打包 API 或数据库代码。
export type ServerSnapshot = Awaited<ReturnType<typeof buildPermissionSnapshot>>;
export interface MenuNode {
  key: string;
  label: string;
  path: string;
  group: string;
  editable?: boolean;
  children?: MenuNode[];
  directory?: boolean;
}
export interface PermissionSnapshot {
  configurationPages?: readonly string[];
  objects: Record<string, ObjectPermission>;
  menus: MenuNode[];
  scope: { status: 'unavailable' | 'ready'; items: ServerSnapshot['scope'] };
  source: 'server';
}
export const emptyPermissions: PermissionSnapshot = {
  configurationPages: [],
  objects: {},
  menus: [],
  scope: { status: 'unavailable', items: [] },
  source: 'server',
};
export const menuObjects = (route: AppRoute) => APP_OBJECT_DIRECTORY[route.id];

/** 应用按服务端可见性显示；应用内入口还要求所属应用的入口对象含其对象。下一层结构由模块登记的 children 适配。 */
export function menuNodes(routes: readonly MenuRoute[], response: ServerSnapshot): MenuNode[] {
  const visible = (route: MenuRoute) =>
    response.apps.some(
      (app) =>
        app.app === route.app && app.visible && (!isEntry(route) || app.entryObjects.includes(route.objectCode ?? '')),
    );
  return routes.flatMap((route): MenuNode[] => {
    if (isEntry(route) && route.children) {
      const children = menuNodes(route.children, response);
      return children.length
        ? [
            {
              key: route.id,
              label: route.label,
              path: children[0]!.path,
              group: route.group,
              directory: true,
              children,
            },
          ]
        : [];
    }
    return visible(route)
      ? [
          {
            key: route.id,
            label: route.label,
            path: route.path,
            group: route.group,
            ...(!isEntry(route) && route.children ? { children: route.children(response, route) } : {}),
          },
        ]
      : [];
  });
}

export async function loadSnapshot(api: ApiClient, signal: AbortSignal) {
  const response = await api.request<ServerSnapshot>('/api/tenant/permission/me/snapshot', { signal });
  const session = { ...response.session, identityKey: response.session.userId, source: 'server' as const };
  const menus = menuNodes(MENU_ROUTES, response);
  // 入口摘要不授予字段或按钮权限；需要明细的页面用同一个按需读取入口补齐。
  const objects: Record<string, ObjectPermission> = Object.fromEntries(
    response.apps.flatMap((app) =>
      app.entryObjects.map((objectCode) => [
        objectCode,
        {
          objectCode,
          summary: true,
          dataOperations: {},
          viewableFields: [],
          editableFields: [],
          buttons: [],
        },
      ]),
    ),
  );
  const snapshot: PermissionSnapshot = {
    objects,
    menus,
    configurationPages: visibleConfigurationPages(PAGES.configurations, response),
    scope: { status: 'ready', items: response.scope },
    source: 'server',
  };
  return { session, snapshot };
}

/** 仅供页面懒加载；403/404 表示该对象不可用，网络、认证和租户错误不得吞掉。 */
export async function fetchObjectPermission(api: ApiClient, object: string, signal: AbortSignal) {
  try {
    return await api.request<ObjectPermission>(`/api/tenant/permission/me/objects/${encodeURIComponent(object)}`, {
      signal,
    });
  } catch (error) {
    if (error instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND', 'PAGE_PERMISSION_REQUIRED'].includes(error.code))
      return undefined;
    throw error;
  }
}
