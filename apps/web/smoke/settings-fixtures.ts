import type { Page } from '@playwright/test';
import { snapshotFixture, tenant, user } from './fixtures.js';
export const ids = {
  user,
  profile: '40000000-0000-4000-8000-000000000001',
  mou: '50000000-0000-4000-8000-000000000001',
  grant: '60000000-0000-4000-8000-000000000001',
  audit: '70000000-0000-4000-8000-000000000001',
};
export const menus = [
  ['users.internal', '内部员工'],
  ['users.all', '全部用户'],
  ['users.external', '外部用户'],
  ['permission.profiles', '身份管理'],
  ['permission.user_grant', '用户授权'],
  ['permission.mous', '管理单元'],
  ['audit.business', '数据变更日志'],
];
export const rows = {
  user: {
    userId: user,
    displayName: '合成用户甲',
    email: 'user-a@example.com',
    userType: 'external',
    businessIdentity: '顾问',
    membershipStatus: 'active',
    membershipRevision: 2,
    employeeId: null,
  },
  profile: {
    id: ids.profile,
    name: '合成人事身份',
    code: 'DEMO_HR',
    apps: ['TenantBase'],
    description: '合成身份',
    source: 'custom',
    revision: 3,
    autoHeld: false,
    objects: [
      {
        objectCode: 'TenantBase.Employee',
        fields: [{ fieldCode: 'name', view: true, edit: false }],
        buttons: [],
      },
    ],
  },
  grant: { id: ids.grant, userId: user, profileId: ids.profile, source: 'manual', status: 'active', revision: 4 },
  mou: {
    id: ids.mou,
    name: '合成管理单元',
    code: 'DEMO_MOU',
    description: '合成范围',
    status: 'active',
    parentId: null,
    revision: 1,
    orgRanges: [],
  },
  audit: {
    id: ids.audit,
    occurredAt: '2026-10-12T03:00:00Z',
    operator: { name: '合成操作人' },
    operationLabel: '编辑',
    objectLabel: '员工',
    objectId: 'DEMO-001',
    content: '名称:从【甲】修改为【乙】',
    sourceAction: '编辑',
    traceId: 'demo-trace',
    snapshot: null,
  },
};
export async function settingsFixtures(page: Page, editable = true) {
  const url = process.env.FE0_BASE_URL ?? `http://127.0.0.1:${process.env.FE0_PORT ?? 4179}`;
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url },
    { name: 'italent_demo_user', value: user, url },
  ]);
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        adminMenus: [...menus, ['other.mou_settings', '管理单元设置']].map(([code, path]) => ({
          code,
          path,
          editable,
          implemented: true,
        })),
      },
    }),
  );
  await page.route('**/api/tenant/permission/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/admin-menus') || path.includes('/me/')) return route.fallback();
    const collection = (name: string, row: unknown) => (path.endsWith(`/${name}`) ? { items: [row] } : row);
    let body: unknown;
    if (path.includes('/users')) body = collection('users', rows.user);
    if (path.includes('/profiles')) body = collection('profiles', rows.profile);
    if (path.includes('/grantable-profiles')) body = { items: [rows.profile] };
    if (path.includes('/grants')) body = collection('grants', rows.grant);
    if (path.includes('/mous')) body = collection('mous', rows.mou);
    if (path.includes('/scopes/'))
      body = { userId: user, appCode: 'TenantBase', kind: 'default', revision: 6, mouId: null, orgRanges: [] };
    return body ? route.fulfill({ json: body }) : route.fallback();
  });
  await page.route('**/api/tenant/audit/**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/data-changes')
        ? { items: [rows.audit], nextCursor: null, window: { from: '2026-07-13', to: '2026-10-13' } }
        : rows.audit,
    }),
  );
}
