import { expect, it } from 'vitest';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';

it('AC-FE-R2b1-入口 在任职应用下独立登记且不自行授予范围', () => {
  const entry = PAGES.entries.find((item) => item.id === 'offers');
  expect(entry).toMatchObject({ app: 'transfer', objectCode: 'TenantBase.EmploymentRecord', path: '/offers' });
  const snapshot = (entryObjects: string[]) =>
    ({
      apps: [{ app: 'transfer', visible: true, entryObjects }],
      adminMenus: [],
    }) as unknown as ServerSnapshot;
  expect(menuNodes(PAGES.menus, snapshot([])).some((item) => item.key === 'offers')).toBe(false);
  expect(menuNodes(PAGES.menus, snapshot(['TenantBase.EmploymentRecord'])).some((item) => item.key === 'offers')).toBe(
    true,
  );
});
