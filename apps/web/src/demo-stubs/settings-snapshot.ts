import type { Session } from '../foundation/Session.js';
import type { MenuNode } from './navigation.js';
/** F-113 未合入时的 L2 适配；只转接服务端菜单，不根据身份名称授予任何权限。 */
export function settingsSnapshot(session: Session, menus: readonly MenuNode[]) {
  return {
    session,
    apps: menus.map(({ key, path }) => ({ id: key, path })),
    scope: { status: 'unavailable' as const, organizationIds: [] as string[] },
    adminMenus: (menus.find((menu) => menu.key === 'settings')?.children ?? []).map((menu) => ({
      code: menu.key,
      path: menu.label,
      editable: menu.editable === true,
    })),
    source: 'demo' as const,
  };
}
