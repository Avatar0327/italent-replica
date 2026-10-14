import { APP_ROUTES } from './page-registry.js';
import { test as base, expect } from '@playwright/test';

export const tenant = '10000000-0000-4000-8000-000000000001';
export const user = '20000000-0000-4000-8000-000000000001';
export const employee = '30000000-0000-4000-8000-000000000001';

export const snapshotFixture = {
  session: {
    tenantId: tenant,
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    today: '2026-10-13',
    userId: user,
    displayName: '合成演示用户',
    employeeId: employee,
  },
  apps: APP_ROUTES.map(({ id, objectCode }) => ({
    app: id,
    visible: true,
    entryObjects: objectCode ? [objectCode] : [],
  })),
  scope: [],
  adminMenus: [{ code: 'users.all', path: '用户管理/全部用户', implemented: true, editable: false }],
};

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/__demo/personas', (route) =>
      route.fulfill({
        json: {
          tenantId: tenant,
          current: route.request().headers().cookie?.includes(user) ? user : null,
          personas: [{ userId: user, name: '合成演示用户', role: '演示身份', entry: '/staff' }],
        },
      }),
    );
    await page.route('**/api/tenant/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { items: [], total: 0, hasDataPermission: true };
      if (path.endsWith('/permission/me/snapshot')) body = snapshotFixture;
      if (path.includes('/permission/me/objects/'))
        body = {
          objectCode: decodeURIComponent(path.split('/').at(-1)!),
          dataOperations: { read: true },
          viewableFields: ['name'],
          editableFields: [],
          buttons: [],
        };
      if (path.endsWith('/permission/admin-menus'))
        body = {
          items: [{ code: 'users.all', path: '用户管理/全部用户', implemented: true, editable: false }],
        };
      if (path.endsWith('/self-service/profile'))
        body = {
          employee: { id: employee, name: '合成员工', code: 'DEMO-001' },
          timezone: 'Asia/Shanghai',
          today: '2026-10-12',
          record: null,
        };
      if (path.endsWith('/transfers/manager')) body = { canApply: false, canViewReporting: false };
      if (path.endsWith('/transfers/catalog')) body = { types: [], reasons: [], today: '2026-10-12' };
      return route.fulfill({ json: body });
    });
    await use(page);
  },
});
export { expect };
