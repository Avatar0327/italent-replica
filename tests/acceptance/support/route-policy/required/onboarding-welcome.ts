/** BE-16 16a-7。欢迎信与入职手册为租户级配置：设置权仅管理员，字段操作权在命令内再次复核（DEC-967 / DEC-983）。 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/onboarding';
const ROUTES = 'apps/api/src/modules/onboarding/welcome-routes.ts';
const ACCESS = 'apps/api/src/modules/onboarding/welcome-access.ts';
const SETTINGS = 'TenantBase.EmploymentSettings';
const NONE = { scope: 'none' } as const;

const SETTINGS_CONST: Evidence = {
  role: 'const',
  unit: `${ACCESS}#WELCOME_SETTINGS`,
  anchor: 'MODULE_OBJECTS.employmentSettings.code',
};
const ALIAS_CONST: Evidence = {
  role: 'const',
  unit: `${ACCESS}#WELCOME_WRITE_ALIAS`,
  anchor: "'tenant.employment.configuration.write'",
};
const inAccess = (name: string, anchor: string): Evidence => ({ role: 'impl', unit: `${ACCESS}#${name}`, anchor });
const call = (route: string, anchor: string): Evidence => ({ role: 'call', unit: `${ROUTES}#route:${route}`, anchor });

interface Resource {
  readonly path: string;
  readonly name: 'Welcome' | 'Handbook';
  readonly fields: Evidence;
  readonly field: string;
}

function read(r: Resource, route: string, anchor: string): Obligation[] {
  const endpoint = call(route, anchor);
  return [
    {
      perm: 'admin:other_settings',
      need: NONE,
      facts: ['admin:admin.*'],
      at: [
        endpoint,
        inAccess('requireView', "await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' })"),
      ],
    },
    {
      perm: `obj:${SETTINGS}:view`,
      need: NONE,
      facts: ['object:object.* 动作', `objectOp:${SETTINGS}:view`],
      at: [
        endpoint,
        inAccess('requireView', "action: 'object.view', resource: WELCOME_SETTINGS, fields"),
        SETTINGS_CONST,
        r.fields,
      ],
    },
  ];
}

function actions(r: Resource, route: string, operation: 'create' | 'update'): Obligation {
  return {
    perm: `obj:${SETTINGS}:${operation}`,
    purpose: 'disclosure:availableActions',
    need: NONE,
    at: [
      call(route, `await ${r.name.toLowerCase()}AvailableActions(authorize, tenant, '${operation}')`),
      inAccess('availableActions', 'resource: WELCOME_SETTINGS, fields'),
      SETTINGS_CONST,
      r.fields,
    ],
  };
}

function write(r: Resource, route: string, operation: 'create' | 'update'): Obligation[] {
  const endpoint = call(route, `${r.name.toLowerCase()}Write(c, deps, '${operation}'`);
  const guard: Evidence = {
    role: 'call',
    unit: `${ROUTES}#settingsWrite`,
    anchor: 'guard: { before: (tx) => check(tx, tenant, operation) }',
  };
  const check: Evidence = {
    role: 'call',
    unit: `${ROUTES}#${r.name.toLowerCase()}Write`,
    anchor: `require${r.name}Write(authorizeInTransaction(deps.authorize, tx), ctx, op)`,
  };
  return [
    {
      perm: 'admin:other_settings',
      need: NONE,
      facts: ['admin:tenant.employment.configuration'],
      at: [
        endpoint,
        guard,
        check,
        inAccess('requireWrite', 'action: WELCOME_WRITE_ALIAS, resource: WELCOME_SETTINGS'),
        ALIAS_CONST,
      ],
    },
    {
      perm: `obj:${SETTINGS}:${operation}`,
      need: NONE,
      facts: ['object:requireObjectWrite（对象写操作权）'],
      at: [endpoint, guard, check, inAccess('requireWrite', 'objectCode: WELCOME_SETTINGS,'), SETTINGS_CONST],
    },
  ];
}

function resource(r: Resource): RequiredTable {
  const { path } = r;
  const view = `await require${r.name}View(authorize, tenant)`;
  const id = (suffix: string) => `${BASE}/${path}/:id${suffix}`;
  return {
    [`GET ${BASE}/${path}`]: [...read(r, `GET /${path}`, view), actions(r, `GET /${path}`, 'create')],
    [`GET ${id('')}`]: [...read(r, `GET /${path}/:id`, view), actions(r, `GET /${path}/:id`, 'update')],
    [`POST ${BASE}/${path}`]: write(r, `POST /${path}`, 'create'),
    [`PATCH ${id('')}`]: write(r, `PATCH /${path}/:id`, 'update'),
    [`DELETE ${id('')}`]: write(r, `DELETE /${path}/:id`, 'update'),
    [`POST ${id('/preview')}`]: read(r, `POST /${path}/:id/preview`, view),
  };
}

export const ONBOARDING_WELCOME: RequiredTable = {
  ...resource({
    path: 'welcome-letters',
    name: 'Welcome',
    field: 'welcomeLetters',
    fields: { role: 'const', unit: `${ACCESS}#WELCOME_FIELDS`, anchor: "['welcomeLetters']" },
  }),
  ...resource({
    path: 'handbooks',
    name: 'Handbook',
    field: 'handbooks',
    fields: { role: 'const', unit: `${ACCESS}#HANDBOOK_FIELDS`, anchor: "['handbooks']" },
  }),
};
