import { contractRoute } from '../contracts/route.js';
import { APP_OBJECT_DIRECTORY } from '@italent/domain';
import type { buildPermissionSnapshot } from '../../../api/src/modules/permission/me-snapshot.js';
import { ApiError, type ApiClient } from './client.js';
import type { ObjectPermission } from './permission-model.js';
import { APP_ROUTES, type AppRoute } from './routes.js';

// 只引用后端推导类型，运行时不打包 API 或数据库代码。
export type ServerSnapshot = Awaited<ReturnType<typeof buildPermissionSnapshot>>;
export interface MenuNode {
  key: string;
  label: string;
  path: string;
  group: string;
  editable?: boolean;
  children?: MenuNode[];
}
export interface PermissionSnapshot {
  objects: Record<string, ObjectPermission>;
  menus: MenuNode[];
  scope: { status: 'unavailable' | 'ready'; items: ServerSnapshot['scope'] };
  source: 'server';
}
export const emptyPermissions: PermissionSnapshot = {
  objects: {},
  menus: [],
  scope: { status: 'unavailable', items: [] },
  source: 'server',
};
export const menuObjects = (route: AppRoute) => APP_OBJECT_DIRECTORY[route.id];

export async function loadSnapshot(api: ApiClient, signal: AbortSignal) {
  const response = await api.request<ServerSnapshot>('/api/tenant/permission/me/snapshot', { signal });
  const session = { ...response.session, identityKey: response.session.userId, source: 'server' as const };
  const menus: MenuNode[] = APP_ROUTES.filter((route) =>
    response.apps.some((app) => app.app === route.id && app.visible),
  ).map((route) => ({
    key: route.id,
    label: route.label,
    path: route.path,
    group: route.group,
    ...(route.id === 'settings'
      ? {
          children: response.adminMenus.map((menu) => ({
            key: menu.code,
            label: menu.path,
            path: `/settings/menu/${encodeURIComponent(menu.code)}`,
            group: route.group,
            editable: menu.editable,
          })),
        }
      : {}),
  }));
  // 合同仍属于 staff，仅将服务端已授权的合同对象映射为本模块入口。
  if (
    response.apps.some(
      (app) => app.app === 'staff' && app.visible && app.entryObjects.includes(contractRoute.objectCode),
    )
  )
    menus.push({ ...contractRoute, key: contractRoute.id });
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
