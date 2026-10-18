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

// F-220 / DEC-431①：与 React Router decodePath 一样逐段解码，编码斜杠不能变成路径分隔符。
export function routePath(path: string) {
  try {
    const pathname = path
      .split('/')
      .map((part) => decodeURIComponent(part).replace(/\//g, '%2F'))
      .join('/')
      .toLowerCase();
    // 仅会话豁免保留既有精确边界；编码、尾斜杠兼容项由 03 另行后补，本轮不扩展。
    return { pathname, ungated: pathname === path.toLowerCase() && PAGES.ungated.has(pathname) };
  } catch {
    return undefined;
  }
}

export function appRoute(path: string) {
  const normalized = routePath(path);
  if (!normalized) return undefined;
  let ownerPath = normalized.pathname;
  // 新子项及被拒路径按 AppPages 的实际挂载匹配；其他旧入口仍沿用原判定。
  // matchRoutes 内部解码一次，必须传原始路径，避免 %25 被二次解码后误认入口。
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
    ownerPath = routePath(matched?.path ?? path)?.pathname ?? '';
  return pageRoutes(MENU_ROUTES).find((item) => ownerPath === item.path || ownerPath.startsWith(`${item.path}/`));
}
export function legacyTarget(path: string, search = '', hash = ''): string | null {
  const target = ({ '/': '/transfer', '/jobs': '/job', '/account': '/settings/account' } as Record<string, string>)[
    path
  ];
  return target ? `${target}${search}${hash}` : null;
}
