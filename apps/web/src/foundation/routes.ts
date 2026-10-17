/// <reference types="vite/client" />
import { APP_IDS } from '@italent/domain';
import { matchRoutes } from 'react-router';
import { collectPages, mountPath, pageRoutes, type AppRoute, type MenuRoute } from './page-registry.js';

export type { AppRoute, EntryRoute, MenuRoute, SubRoute } from './page-registry.js';

// 页面契约注册点（F-125）：各模块在 src/<模块>/pages.ts 自带登记，这里只汇总；菜单可见性见 permission-snapshot.ts。
export const PAGES = collectPages(import.meta.glob('../*/pages.ts', { eager: true }), APP_IDS);
export const APP_ROUTES: readonly AppRoute[] = PAGES.apps;
export const MENU_ROUTES: readonly MenuRoute[] = PAGES.menus;
export const SUB_ROUTES = PAGES.routes;

export function appRoute(path: string) {
  // 与 AppPages 使用相同挂载顺序、优先级和解码，只为实际命中的新子项替换旧入口判定。
  const child = matchRoutes(
    [
      ...pageRoutes(MENU_ROUTES).map((item) => ({ path: mountPath(item), handle: item })),
      ...SUB_ROUTES.map((item) => ({ path: item.path, handle: undefined })),
    ],
    path,
  )?.[0]?.route.handle;
  if (child && PAGES.entries.some((entry) => entry.children?.some((item) => item === child))) return child;
  return pageRoutes(MENU_ROUTES).find((item) => path === item.path || path.startsWith(`${item.path}/`));
}
export function legacyTarget(path: string, search = '', hash = ''): string | null {
  const target = ({ '/': '/transfer', '/jobs': '/job', '/account': '/settings/account' } as Record<string, string>)[
    path
  ];
  return target ? `${target}${search}${hash}` : null;
}
