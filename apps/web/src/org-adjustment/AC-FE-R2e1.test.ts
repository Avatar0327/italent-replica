import { MODULE_OBJECTS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../foundation/permission-snapshot.js';
import { MENU_ROUTES } from '../foundation/routes.js';

describe('AC-FE-R2e1 组织管理入口', () => {
  it('在组织管理下提供一体化组织调整审批入口', () => {
    const snapshot = {
      apps: [{ app: 'org', visible: true, entryObjects: [MODULE_OBJECTS.organization.code] }],
    } satisfies Pick<ServerSnapshot, 'apps'>;
    const menu = menuNodes(MENU_ROUTES, snapshot as ServerSnapshot).find(({ key }) => key === 'org');
    expect(menu?.children?.find(({ path }) => path === '/org/adjustments')?.label ?? '入口缺失').toBe(
      '一体化组织调整审批',
    );
  });
});
