/**
 * 必需项表：租户配置（modules/tenant-settings/routes.ts）。三个处理函数各自 requirePermission
 * tenant.settings.read / write，动作别名经 MODULE_ACTIONS 映射到管理员能力 other_settings。
 */
import type { RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/tenant-settings/routes.ts';
const REQUIRE = {
  role: 'impl',
  unit: 'apps/api/src/authorization.ts#requirePermission',
  anchor: "if (!(await authorizer(request))) throw new AppError('FORBIDDEN'",
} as const;
const ALIAS = {
  role: 'const',
  unit: 'packages/domain/src/permission/module-actions.ts#actions',
  anchor: "'tenant.settings.read': tenantConfiguration, 'tenant.settings.write': tenantConfiguration",
} as const;
const CAPABILITY = {
  role: 'const',
  unit: 'packages/domain/src/permission/module-actions.ts#tenantConfiguration',
  anchor: "{ kind: 'admin', capability: 'other_settings' }",
} as const;

export const TENANT_SETTINGS: RequiredTable = {
  'GET /api/tenant/settings/:key': [
    {
      perm: 'admin:other_settings',
      facts: ['admin:tenant.settings.*'],
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:GET /api/tenant/settings/:key`,
          anchor:
            "requirePermission(deps.authorize, { tenantId, userId, action: 'tenant.settings.read', resource: key })",
        },
        REQUIRE,
        ALIAS,
        CAPABILITY,
      ],
    },
  ],
  'PUT /api/tenant/settings/:key': [
    {
      perm: 'admin:other_settings',
      facts: ['admin:tenant.settings.*'],
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:PUT /api/tenant/settings/:key`,
          anchor: "requirePermission(deps.authorize, { ...ctx, action: 'tenant.settings.write', resource: key })",
        },
        REQUIRE,
        ALIAS,
        CAPABILITY,
      ],
    },
  ],
  'DELETE /api/tenant/settings/:key/override': [
    {
      perm: 'admin:other_settings',
      facts: ['admin:tenant.settings.*'],
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:DELETE /api/tenant/settings/:key/override`,
          anchor: "requirePermission(deps.authorize, { ...ctx, action: 'tenant.settings.write', resource: key })",
        },
        REQUIRE,
        ALIAS,
        CAPABILITY,
      ],
    },
  ],
};
