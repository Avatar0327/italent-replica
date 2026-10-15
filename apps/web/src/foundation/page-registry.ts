import type { AppId } from '@italent/domain';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ui } from './messages.js';
import type { MenuNode, ServerSnapshot } from './permission-snapshot.js';

/**
 * 页面自注册（F-125 / DEC-476）：各模块在 `src/<模块>/pages.ts` 导出 `pages`，底座汇总。
 * 本文件只放纯函数和类型，不依赖 Vite，Playwright 在 Node 侧也用同一个汇总函数。
 * 顺序全部由底座决定：应用按 domain `APP_IDS`，应用内入口按 id，子路由按路径，与文件遍历顺序无关。
 */
export type AppGroup = keyof typeof ui.groups;
export interface ModulePage {
  /** 模块导出名，汇总快照用它核对页面没有换错 */
  readonly name: string;
  readonly Component: LazyExoticComponent<ComponentType>;
}
export interface AppPageDeclaration {
  readonly app: AppId;
  readonly label: string;
  readonly group: AppGroup;
  readonly objectCode?: string;
  /** 未登记页面时显示空首页 */
  readonly page?: ModulePage;
  /** 旧页面装在 .legacy-page 内，仅做租户与布局接入 */
  readonly legacy?: boolean;
  /** 菜单下一层的 L2 结构适配；可见性仍来自服务端快照，这里不授予权限 */
  readonly children?: (snapshot: ServerSnapshot, route: AppRoute) => MenuNode[];
}
/** 应用内单独的菜单入口（不新增后端应用）：所属应用的入口对象含 objectCode 时才显示；路由挂在 /<id>/*，子路径由入口页自管 */
export interface EntryPageDeclaration {
  readonly id: string;
  readonly app: AppId;
  readonly label: string;
  readonly group: AppGroup;
  readonly objectCode: string;
  readonly page?: ModulePage;
  readonly legacy?: boolean;
}
export interface SubRouteDeclaration {
  readonly path: string;
  readonly page: ModulePage;
  readonly legacy?: boolean;
  /** 只要求会话，不按菜单可见性拦截（个人设置） */
  readonly ungated?: boolean;
}
/**
 * 挂到别的模块已声明应用下的下级菜单（F-164 补契约）：原站一个应用的菜单可能分属多个业务模块
 * （员工自助 > 我的发展计划由 IDP 提供），子项由提供页面的模块登记；排在声明模块自己的子项之后，按模块名排序。
 * 可见性同 children：应用不可见时整组不显示，这里不授予权限。
 */
export interface MenuExtensionDeclaration {
  readonly app: AppId;
  readonly children: (snapshot: ServerSnapshot, route: AppRoute) => MenuNode[];
}
export interface ModulePages {
  readonly apps?: readonly AppPageDeclaration[];
  readonly menus?: readonly MenuExtensionDeclaration[];
  readonly entries?: readonly EntryPageDeclaration[];
  readonly routes?: readonly SubRouteDeclaration[];
}

interface Owned {
  readonly module: string;
  readonly path: string;
  readonly legacy: boolean;
}
export type AppRoute = Omit<AppPageDeclaration, 'legacy'> & Owned & { readonly id: AppId };
export type EntryRoute = Omit<EntryPageDeclaration, 'legacy'> & Owned;
export type MenuRoute = AppRoute | EntryRoute;
export type SubRoute = Omit<SubRouteDeclaration, 'legacy'> & Owned;
export interface PageRegistry {
  readonly apps: readonly AppRoute[];
  readonly entries: readonly EntryRoute[];
  readonly menus: readonly MenuRoute[];
  readonly routes: readonly SubRoute[];
  readonly ungated: ReadonlySet<string>;
}

export const isEntry = (route: MenuRoute): route is EntryRoute => route.id !== route.app;
/** 菜单路由的挂载路径：应用页精确匹配，应用内入口带 /* */
export const mountPath = (route: MenuRoute) => (isEntry(route) ? `${route.path}/*` : route.path);

/** 模块页面懒加载：导出名受类型检查，代码拆分与原先逐页 lazy 相同 */
export function lazyPage<K extends string, M extends Record<K, ComponentType>>(
  name: K,
  load: () => Promise<M>,
): ModulePage {
  return { name, Component: lazy(() => load().then((m) => ({ default: m[name] }))) };
}

/** glob 键形如 `../<模块>/pages.ts`，取模块目录名 */
export const moduleName = (key: string) => key.split('/').at(-2) ?? key;
/** 按码点比较，不受运行环境区域设置影响；页面与注释汇总共用 */
export const compareText = (a: string, b: string) => Number(a > b) - Number(a < b);
const byKey = <T>(modules: Record<string, T>) =>
  Object.keys(modules)
    .sort(compareText)
    .map((key) => [moduleName(key), modules[key]] as const);

function declarations(modules: Record<string, unknown>) {
  return byKey(modules).map(([module, value]) => {
    const pages = (value as { pages?: ModulePages } | undefined)?.pages;
    if (!pages || typeof pages !== 'object') throw new Error(`页面登记缺少导出：${module}/pages.ts 须导出 pages`);
    return { module, pages };
  });
}
function claim(seen: Map<string, string>, kind: string, key: string, module: string) {
  const owner = seen.get(key);
  if (owner !== undefined) throw new Error(`页面登记重复：${kind} ${key}（${owner} 与 ${module}）`);
  seen.set(key, module);
}

type Children = NonNullable<AppPageDeclaration['children']>;
/** 声明模块自己的子项在前、扩展在后；同一层菜单键重复说明两处登记撞了，报错而不是静默覆盖。 */
const extend =
  (own: Children | undefined, more: Children, module: string): Children =>
  (snapshot, route) => {
    const menus = [...(own?.(snapshot, route) ?? []), ...more(snapshot, route)];
    const seen = new Map<string, string>();
    for (const menu of menus) claim(seen, `${route.id} 菜单键`, menu.key, module);
    return menus;
  };

export function collectPages(modules: Record<string, unknown>, appIds: readonly AppId[]): PageRegistry {
  const found = declarations(modules);
  const apps = new Map<string, AppRoute>();
  const ids = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const { module, pages } of found)
    for (const { legacy, ...app } of pages.apps ?? []) {
      if (!appIds.includes(app.app)) throw new Error(`页面登记了未知应用：${app.app}（${module}）`);
      claim(ids, '应用', app.app, module);
      apps.set(app.app, { ...app, id: app.app, path: `/${app.app}`, module, legacy: legacy ?? false });
    }
  const missing = appIds.filter((id) => !apps.has(id));
  if (missing.length) throw new Error(`页面登记缺少应用：${missing.join('、')}`);
  for (const { module, pages } of found)
    for (const extension of pages.menus ?? []) {
      const app = apps.get(extension.app);
      if (!app) throw new Error(`菜单扩展挂到了未知应用：${extension.app}（${module}）`);
      apps.set(extension.app, { ...app, children: extend(app.children, extension.children, module) });
    }
  const appRoutes = appIds.map((id) => apps.get(id)!);
  for (const route of appRoutes) claim(paths, '路径', route.path, route.module);
  const entries = found
    .flatMap(({ module, pages }) =>
      (pages.entries ?? []).map(({ legacy, ...entry }) => ({
        ...entry,
        path: `/${entry.id}`,
        module,
        legacy: legacy ?? false,
      })),
    )
    .sort((a, b) => compareText(a.id, b.id));
  for (const entry of entries) {
    claim(ids, '菜单键', entry.id, entry.module);
    claim(paths, '路径', entry.path, entry.module);
    claim(paths, '路径', mountPath(entry), entry.module);
  }
  const routes = found
    .flatMap(({ module, pages }) =>
      (pages.routes ?? []).map(({ legacy, ...route }) => ({ ...route, module, legacy: legacy ?? false })),
    )
    .sort((a, b) => compareText(a.path, b.path));
  for (const route of routes) claim(paths, '路径', route.path, route.module);
  return {
    apps: appRoutes,
    entries,
    menus: [...appRoutes, ...entries],
    routes,
    ungated: new Set(routes.filter((route) => route.ungated).map((route) => route.path)),
  };
}
