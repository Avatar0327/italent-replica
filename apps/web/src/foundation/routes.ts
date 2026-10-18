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
  // F-220 / DEC-431①：与 React Router 的大小写无关匹配一致，统一页面与应用权限归属。
  path = path.toLowerCase();
  // 新子项及被拒路径按 AppPages 的实际挂载匹配；其他旧入口仍沿用原判定。
  const matched = matchRoutes(
    [
      ...pageRoutes(MENU_ROUTES).map((item) => ({ path: mountPath(item), handle: item })),
      ...SUB_ROUTES.map((item) => ({ path: item.path, handle: undefined })),
    ],
    path,
  )?.[0]?.route;
  const child = matched?.handle;
  if (child && PAGES.entries.some((entry) => entry.children?.some((item) => item === child))) return child;
  if (
    matchRoutes(
      PAGES.rejectedPaths.map((path) => ({ path })),
      path,
    )
  )
    path = matched?.path ?? path;
  return pageRoutes(MENU_ROUTES).find((item) => path === item.path || path.startsWith(`${item.path}/`));
}
export function legacyTarget(path: string, search = '', hash = ''): string | null {
  const target = ({ '/': '/transfer', '/jobs': '/job', '/account': '/settings/account' } as Record<string, string>)[
    path
  ];
  return target ? `${target}${search}${hash}` : null;
}
