import { ApiError, type ApiClient } from '../foundation/client.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { APP_ROUTES } from '../foundation/routes.js';
import { menuObjects } from './object-directory.js';

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
  // 当前用户数据范围读取接口缺失。不得把无法读取误作全部组织；业务列表继续由后端裁剪。
  scope: { status: 'unavailable' | 'ready'; organizationIds: readonly string[] };
  source: 'demo' | 'server';
}
export const emptyPermissions: PermissionSnapshot = {
  objects: {},
  menus: [],
  scope: { status: 'unavailable', organizationIds: [] },
  source: 'demo',
};
async function readable<T>(api: ApiClient, path: string, signal: AbortSignal): Promise<T | undefined> {
  try {
    return await api.request<T>(path, { signal });
  } catch (error) {
    if (error instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND', 'PAGE_PERMISSION_REQUIRED'].includes(error.code))
      return undefined;
    throw error;
  }
}
export function loadObjectPermission(api: ApiClient, object: string, signal: AbortSignal) {
  return readable<ObjectPermission>(api, `/api/tenant/permission/me/objects/${encodeURIComponent(object)}`, signal);
}

/** L2 菜单结构适配：没有全应用菜单接口，结构集中在此；可见性仍来自现有服务端接口，不判断角色。 */
export async function loadPermissions(api: ApiClient, signal: AbortSignal): Promise<PermissionSnapshot> {
  const objects: Record<string, ObjectPermission> = {};
  const results = await Promise.all(
    APP_ROUTES.map(async (route): Promise<MenuNode | undefined> => {
      let allowed = false;
      let children: MenuNode[] | undefined;
      if (route.objectCode) {
        for (const code of menuObjects(route)) {
          const permission = await loadObjectPermission(api, code, signal);
          if (permission) {
            objects[code] = permission;
            allowed = true;
            break;
          }
        }
      } else if (route.id === 'settings') {
        const response = await readable<{ items: { code: string; path: string; editable: boolean }[] }>(
          api,
          '/api/tenant/permission/admin-menus',
          signal,
        );
        children = response?.items.map((menu) => ({
          key: menu.code,
          label: menu.path,
          editable: menu.editable,
          group: route.group,
          path: `/settings/menu/${encodeURIComponent(menu.code)}`,
        }));
        allowed = !!children?.length;
      } else {
        const paths: Record<string, string> = {
          self: '/api/tenant/self-service/profile',
          manager: '/api/tenant/employment/transfers/manager',
          approval: '/api/tenant/approval/todos?page=1&pageSize=1',
        };
        allowed = (await readable(api, paths[route.id]!, signal)) !== undefined;
      }
      return allowed
        ? { key: route.id, label: route.label, path: route.path, group: route.group, children }
        : undefined;
    }),
  );
  return { ...emptyPermissions, objects, menus: results.filter((item) => item !== undefined) };
}
