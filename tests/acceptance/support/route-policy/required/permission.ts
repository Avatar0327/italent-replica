/**
 * 必需项表：权限管理（modules/permission/routes.ts、user-routes.ts、data-scope-routes.ts、scope-policy-routes.ts）。
 * 管理员能力经 adminGuard（requirePermission admin.<能力>）、scopeAdminGuard（admin.other_settings，REQ-PRM-002
 * 首版只租户管理员配置范围）、mouViewGuard（admin.mou_manage）；人员绑定的写入口固定拒绝；授权带范围时另要
 * other_settings（条件守卫）。admin-menus / me/objects 只按成员读取本人数据，无管理员能力。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const DIR = 'apps/api/src/modules/permission';
const ROUTES = `${DIR}/routes.ts`;
const USERS = `${DIR}/user-routes.ts`;
const SCOPES = `${DIR}/data-scope-routes.ts`;
const POLICIES = `${DIR}/scope-policy-routes.ts`;
const ADMIN_GUARD: Evidence = {
  role: 'impl',
  unit: `${DIR}/admin-http.ts#adminGuard`,
  anchor: 'await requirePermission(deps.authorize, { ...ctx, action: `admin.${capability}` })',
};
const SCOPE_GUARD: Evidence = {
  role: 'impl',
  unit: `${SCOPES}#scopeAdminGuard`,
  anchor: "await requirePermission(deps.authorize, { ...ctx, action: 'admin.other_settings' })",
};
const MOU_GUARD: Evidence = {
  role: 'impl',
  unit: `${SCOPES}#mouViewGuard`,
  anchor: "await requirePermission(deps.authorize, { ...ctx, action: 'admin.mou_manage' })",
};
const route = (file: string, method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${file}#route:${method} /api/tenant/permission${path}`,
  anchor,
});
const ADMIN_FACTS = ['admin:adminGuard'];
const SCOPE_FACTS = ['admin:admin.*', 'admin:adminGuard'];

const guarded = (capability: string, method: string, path: string): Obligation => ({
  perm: `admin:${capability}`,
  facts: ADMIN_FACTS,
  at: [route(ROUTES, method, path, `await guard(c, deps, '${capability}')`), ADMIN_GUARD],
});
const users = (
  method: string,
  path: string,
  anchor = 'const ctx = await adminGuard(c, deps, CAPABILITY)',
): Obligation => ({
  perm: 'admin:user_manage',
  facts: ADMIN_FACTS,
  at: [
    path.endsWith('/status') || path.endsWith('/remove')
      ? { role: 'call', unit: `${USERS}#lifecycleRequest`, anchor }
      : route(USERS, method, path, anchor),
    ADMIN_GUARD,
    { role: 'const', unit: `${USERS}#CAPABILITY`, anchor: "'user_manage'" },
  ],
});
const scoped = (call: Evidence): Obligation => ({
  perm: 'admin:other_settings',
  facts: SCOPE_FACTS,
  at: [call, SCOPE_GUARD],
});
const scopeRoute = (file: string, method: string, path: string) =>
  scoped(route(file, method, path, 'const ctx = await scopeAdminGuard(c, deps)'));
const configRoute = scoped({
  role: 'call',
  unit: `${POLICIES}#configRoutes`,
  anchor: 'const ctx = await scopeAdminGuard(c, deps)',
});
const mouView = (path: string): Obligation => ({
  perm: 'admin:mou_manage',
  facts: SCOPE_FACTS,
  at: [route(SCOPES, 'GET', path, 'const ctx = await mouViewGuard(c, deps)'), MOU_GUARD],
});
const personLinksReadOnly: Obligation = {
  perm: 'guard:permission.personLinksReadOnly',
  facts: ['guard:permission.personLinksReadOnly'],
  note: 'DEC-128：写入口固定 403，绑定只随人员档案产生',
  at: [
    {
      role: 'call',
      unit: `${POLICIES}#personLinkRoutes`,
      anchor: "throw new AppError('FORBIDDEN', '用户与人员的绑定随人员档案自动产生，不能手工绑定或改绑'",
    },
  ],
};

export const PERMISSION: RequiredTable = {
  'GET /api/tenant/permission/profiles/:id/data-scopes/:appCode': [
    scopeRoute(POLICIES, 'GET', '/profiles/:id/data-scopes/:appCode'),
  ],
  'PUT /api/tenant/permission/profiles/:id/data-scopes/:appCode': [
    scopeRoute(POLICIES, 'PUT', '/profiles/:id/data-scopes/:appCode'),
  ],
  'GET /api/tenant/permission/scope-apps/:appCode': [configRoute],
  'PUT /api/tenant/permission/scope-apps/:appCode': [configRoute],
  'GET /api/tenant/permission/person-links/:userId': [scopeRoute(POLICIES, 'GET', '/person-links/:userId')],
  'PUT /api/tenant/permission/person-links/:userId': [personLinksReadOnly],
  'DELETE /api/tenant/permission/person-links/:userId': [personLinksReadOnly],
  'GET /api/tenant/permission/dynamic-org-grants/:grantId': [configRoute],
  'PUT /api/tenant/permission/dynamic-org-grants/:grantId': [configRoute],
  'DELETE /api/tenant/permission/dynamic-org-grants/:grantId': [configRoute],
  'GET /api/tenant/permission/scope-policies/:appCode/:objectCode/:targetKind/:targetCode': [configRoute],
  'PUT /api/tenant/permission/scope-policies/:appCode/:objectCode/:targetKind/:targetCode': [configRoute],
  'GET /api/tenant/permission/mous': [mouView('/mous')],
  'GET /api/tenant/permission/mous/:id': [mouView('/mous/:id')],
  'POST /api/tenant/permission/mous': [scopeRoute(SCOPES, 'POST', '/mous')],
  'PUT /api/tenant/permission/mous/:id': [scopeRoute(SCOPES, 'PUT', '/mous/:id')],
  'DELETE /api/tenant/permission/mous/:id': [scopeRoute(SCOPES, 'DELETE', '/mous/:id')],
  'GET /api/tenant/permission/scopes/:userId/:appCode': [scopeRoute(SCOPES, 'GET', '/scopes/:userId/:appCode')],
  'PUT /api/tenant/permission/scopes/:userId/:appCode': [scopeRoute(SCOPES, 'PUT', '/scopes/:userId/:appCode')],
  'GET /api/tenant/permission/grant-prefill/:userId/:profileId': [
    scopeRoute(SCOPES, 'GET', '/grant-prefill/:userId/:profileId'),
  ],
  'GET /api/tenant/permission/users': [users('GET', '/users')],
  'GET /api/tenant/permission/users/:userId': [users('GET', '/users/:userId')],
  'POST /api/tenant/permission/users': [users('POST', '/users')],
  'PUT /api/tenant/permission/users/:userId': [users('PUT', '/users/:userId')],
  'POST /api/tenant/permission/users/:userId/status': [users('POST', '/users/:userId/status')],
  'POST /api/tenant/permission/users/:userId/remove': [users('POST', '/users/:userId/remove')],
  'GET /api/tenant/permission/profiles': [guarded('profile_manage', 'GET', '/profiles')],
  'GET /api/tenant/permission/profiles/:id': [guarded('profile_manage', 'GET', '/profiles/:id')],
  'POST /api/tenant/permission/profiles': [guarded('profile_manage', 'POST', '/profiles')],
  'PUT /api/tenant/permission/profiles/:id/objects/:objectCode': [
    guarded('profile_manage', 'PUT', '/profiles/:id/objects/:objectCode'),
  ],
  'GET /api/tenant/permission/grantable-profiles': [guarded('user_grant', 'GET', '/grantable-profiles')],
  'GET /api/tenant/permission/grants': [guarded('user_grant', 'GET', '/grants')],
  'POST /api/tenant/permission/grants': [
    guarded('user_grant', 'POST', '/grants'),
    {
      perm: 'guard:permission.grantScopesRequireOtherSettings',
      facts: ['guard:permission.grantScopesRequireOtherSettings'],
      note: '条件守卫：授权请求带 scopes 时另要 other_settings',
      at: [
        route(
          ROUTES,
          'POST',
          '/grants',
          'if (body.scopes?.length) await requirePermission(deps.authorize, ' +
            "{ ...ctx, action: 'admin.other_settings' })",
        ),
      ],
    },
    {
      perm: 'admin:other_settings',
      purpose: 'when:permission.grantScopesRequireOtherSettings',
      facts: ['admin:admin.*'],
      at: [
        route(
          ROUTES,
          'POST',
          '/grants',
          'if (body.scopes?.length) await requirePermission(deps.authorize, ' +
            "{ ...ctx, action: 'admin.other_settings' })",
        ),
      ],
    },
  ],
  'POST /api/tenant/permission/grants/:id/revoke': [guarded('user_grant', 'POST', '/grants/:id/revoke')],
  'GET /api/tenant/permission/admins': [guarded('admin_manage', 'GET', '/admins')],
  'GET /api/tenant/permission/admins/:id': [guarded('admin_manage', 'GET', '/admins/:id')],
  'POST /api/tenant/permission/admins': [guarded('admin_manage', 'POST', '/admins')],
  'PUT /api/tenant/permission/admins/:id': [guarded('admin_manage', 'PUT', '/admins/:id')],
  'GET /api/tenant/permission/licenses': [guarded('license_balance', 'GET', '/licenses')],
  'GET /api/tenant/permission/licenses/:licenseType/seats': [
    guarded('license_usage', 'GET', '/licenses/:licenseType/seats'),
  ],
  'GET /api/tenant/permission/admin-roles': [guarded('admin_manage', 'GET', '/admin-roles')],
  'GET /api/tenant/permission/admin-menus': [],
  'GET /api/tenant/permission/me/objects/:objectCode': [],
};
