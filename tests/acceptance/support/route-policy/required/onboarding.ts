/** BE-16 16b-0。任务池为租户级任职设置，配置字段与管理员能力在命令内再次复核。 */
import { ONBOARDING_COLLECTION } from './onboarding-collection.js';
import { ONBOARDING_TASKS } from './onboarding-tasks.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';
import { ONBOARDING_SCHEMES } from './onboarding-schemes.js';

const BASE = '/api/tenant/onboarding/integration/task-pool';
const ROUTES = 'apps/api/src/modules/onboarding/integration-pool-routes.ts';
const ACCESS = 'apps/api/src/modules/onboarding/integration-pool-access.ts';
const SETTINGS = 'TenantBase.EmploymentSettings';
const NONE = { scope: 'none' } as const;
const SETTINGS_CONST: Evidence = {
  role: 'const',
  unit: `${ACCESS}#POOL_SETTINGS`,
  anchor: 'MODULE_OBJECTS.employmentSettings.code',
};
const ALIAS_CONST: Evidence = {
  role: 'const',
  unit: `${ACCESS}#POOL_WRITE_ALIAS`,
  anchor: "'tenant.employment.configuration.write'",
};
const FIELD_CONST: Evidence = {
  role: 'const',
  unit: `${ACCESS}#POOL_FIELDS`,
  anchor: "['integrationTaskPool']",
};
const call = (route: string, anchor: string): Evidence => ({ role: 'call', unit: `${ROUTES}#route:${route}`, anchor });

function read(route: string, anchor: string): Obligation[] {
  const endpoint = call(route, anchor);
  const unit = `${ACCESS}#requirePoolView`;
  return [
    {
      perm: 'admin:other_settings',
      need: NONE,
      facts: ['admin:admin.*'],
      at: [
        endpoint,
        {
          role: 'impl',
          unit,
          anchor: "await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' })",
        },
      ],
    },
    {
      perm: `obj:${SETTINGS}:view`,
      need: NONE,
      facts: ['object:object.* 动作', `objectOp:${SETTINGS}:view`],
      at: [
        endpoint,
        { role: 'impl', unit, anchor: "action: 'object.view', resource: POOL_SETTINGS, fields: POOL_FIELDS" },
        SETTINGS_CONST,
        FIELD_CONST,
      ],
    },
  ];
}

function actions(route: string, operation: 'create' | 'update'): Obligation {
  return {
    perm: `obj:${SETTINGS}:${operation}`,
    purpose: 'disclosure:availableActions',
    need: NONE,
    at: [
      call(route, `await poolAvailableActions(authorize, tenant, '${operation}')`),
      {
        role: 'impl',
        unit: `${ACCESS}#poolAvailableActions`,
        anchor: 'resource: POOL_SETTINGS, fields: POOL_FIELDS',
      },
      SETTINGS_CONST,
      FIELD_CONST,
    ],
  };
}

function write(route: string, operation: 'create' | 'update'): Obligation[] {
  const endpoint = call(route, `poolWrite(c, deps, '${operation}'`);
  const guard: Evidence = {
    role: 'call',
    unit: `${ROUTES}#poolWrite`,
    anchor: 'before: (tx) => requirePoolWrite(authorizeInTransaction(deps.authorize, tx), tenant, operation)',
  };
  return [
    {
      perm: 'admin:other_settings',
      need: NONE,
      facts: ['admin:tenant.employment.configuration'],
      at: [
        endpoint,
        guard,
        {
          role: 'impl',
          unit: `${ACCESS}#requirePoolWrite`,
          anchor: 'await requirePermission(authorize, { ...ctx, action: POOL_WRITE_ALIAS, resource: POOL_SETTINGS })',
        },
        ALIAS_CONST,
      ],
    },
    {
      perm: `obj:${SETTINGS}:${operation}`,
      need: NONE,
      facts: ['object:requireObjectWrite（对象写操作权）'],
      at: [
        endpoint,
        guard,
        {
          role: 'impl',
          unit: `${ACCESS}#requirePoolWrite`,
          anchor: 'objectCode: POOL_SETTINGS, operation, payload: { integrationTaskPool: true }',
        },
        SETTINGS_CONST,
      ],
    },
  ];
}

export const ONBOARDING: RequiredTable = {
  ...ONBOARDING_COLLECTION,
  ...ONBOARDING_TASKS,
  ...ONBOARDING_SCHEMES,
  [`GET ${BASE}/categories`]: read(
    'GET /categories',
    'await requirePoolView(authorizeInTransaction(deps.authorize, tx), tenantOf(c))',
  ),
  [`GET ${BASE}`]: [...read('GET /', 'await requirePoolView(authorize, tenant)'), actions('GET /', 'create')],
  [`GET ${BASE}/:id`]: [...read('GET /:id', 'await requirePoolView(authorize, tenant)'), actions('GET /:id', 'update')],
  [`POST ${BASE}`]: write('POST /', 'create'),
  [`PATCH ${BASE}/:id`]: write('PATCH /:id', 'update'),
  [`DELETE ${BASE}/:id`]: write('DELETE /:id', 'update'),
};
