import type { MenuNode } from './permission-snapshot.js';

/** 全部菜单搜索命中：菜单名 + 原站右侧灰字路径（应用 > 上级菜单 > 目录）。 */
export interface MenuHit {
  key: string;
  label: string;
  path: string;
  trail: string[];
}

/**
 * 原站全部菜单搜索会命中各级菜单并平铺成“搜索结果 N”。
 * 传入的菜单已按权限裁剪，这里只递归、不再放宽；下级菜单名形如“目录/菜单”，目录并入路径，只按菜单名匹配。
 */
export function searchMenus(menus: MenuNode[], keyword: string, groups: Record<string, string>): MenuHit[] {
  const text = keyword.trim();
  if (!text) return [];
  const visit = (nodes: MenuNode[], trail: string[]): MenuHit[] =>
    nodes.flatMap((node) => {
      const segments = node.label.split('/');
      const label = segments.pop() ?? node.label;
      const own = [...trail, ...segments];
      const hit = label.includes(text) ? [{ key: node.key, label, path: node.path, trail: own }] : [];
      return [...hit, ...visit(node.children ?? [], [...own, label])];
    });
  return menus.flatMap((menu) => visit([menu], [groups[menu.group] ?? menu.group]));
}

/** 原站顶栏显示当前所在应用，左侧只列该应用的菜单；当前页不属于任何有权菜单时没有当前应用。 */
export function currentApp(menus: MenuNode[], activePath: string | undefined, groups: Record<string, string>) {
  const active = menus.find(
    (menu) => menu.path === activePath || (menu.directory && menu.children?.some((child) => child.path === activePath)),
  );
  if (!active) return undefined;
  return {
    key: active.group,
    label: groups[active.group] ?? active.group,
    menus: menus.filter((menu) => menu.group === active.group),
  };
}
