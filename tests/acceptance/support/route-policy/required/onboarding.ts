import type { Evidence, Need, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/onboarding';
const ROUTES = 'apps/api/src/modules/onboarding/collection-config-routes.ts';
const CONFIG = 'apps/api/src/modules/onboarding/collection-config.ts';
const SCOPE = 'apps/api/src/modules/onboarding/collection-config-scope.ts';
const OBJECT = 'TenantBase.EmploymentSettings';

const apiCall = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:${method} ${path}`,
  anchor,
});
const inFn = (role: Evidence['role'], file: string, name: string, anchor: string): Evidence => ({
  role,
  unit: `${file}#${name}`,
  anchor,
});

const scopes = {
  ruleList: {
    need: { scope: 'list', predicate: 'onboarding.ruleScopeSql' },
    at: inFn('scope', CONFIG, 'readCollectionConfig', 'ruleScopeSql(ctx, scope, sql`${table.id}`)'),
  },
  ruleDetail: {
    need: { scope: 'guard', guard: 'onboarding.ruleScopeSql' },
    at: inFn('scope', CONFIG, 'readCollectionConfig', 'ruleScopeSql(ctx, scope, sql`${table.id}`)'),
  },
  createRule: {
    need: { scope: 'guard', guard: 'onboarding.collectionConfigScope' },
    at: inFn('scope', CONFIG, 'saveRule', 'await requireCollectionOrgScope(tx, ctx, scope, orgIds)'),
  },
  scopedTarget: {
    need: { scope: 'guard', guard: 'onboarding.collectionConfigScope' },
    at: inFn(
      'scope',
      ROUTES,
      'writeConfig',
      'await requireCollectionTarget(tx, { ctx, scope: await collectionScope(deps, tx, ctx) }, kind, id)',
    ),
  },
} satisfies Record<string, { need: Need; at: Evidence }>;

function obligations(
  method: string,
  path: string,
  operation: 'view' | 'create' | 'update',
  scope?: keyof typeof scopes,
): Obligation[] {
  const read = operation === 'view';
  const entry = apiCall(method, path, read ? 'readConfig(c, deps,' : 'writeConfig(c, deps,');
  const call = read
    ? inFn('call', ROUTES, 'readConfig', "await requireConfigPermission(tx, deps, ctx, kind, 'view')")
    : inFn('call', ROUTES, 'writeConfig', 'await requireConfigPermission(tx, deps, ctx, kind, operation)');
  const scoped = scope && scopes[scope];
  return [
    {
      perm: 'admin:other_settings',
      facts: ['admin:tenant.employment.configuration'],
      need: { scope: 'none' },
      at: [
        entry,
        call,
        inFn('impl', ROUTES, 'requireConfigPermission', "action: 'tenant.employment.configuration.write'"),
      ],
    },
    {
      perm: `obj:${OBJECT}:${operation}`,
      facts: ['object:object.* 动作'],
      need: scoped ? scoped.need : { scope: 'none' },
      at: [
        entry,
        call,
        inFn(
          'impl',
          ROUTES,
          'requireConfigPermission',
          'action: `object.${operation}`, resource: SETTINGS, fields: [kind]',
        ),
        inFn('const', SCOPE, 'SETTINGS', 'MODULE_OBJECTS.employmentSettings.code'),
        ...(scoped ? [scoped.at] : []),
      ],
    },
  ];
}

export const ONBOARDING: RequiredTable = {
  [`GET ${BASE}/collection-templates`]: obligations('GET', '/collection-templates', 'view'),
  [`GET ${BASE}/collection-templates/:id`]: obligations('GET', '/collection-templates/:id', 'view'),
  [`POST ${BASE}/collection-templates`]: obligations('POST', '/collection-templates', 'create'),
  [`PATCH ${BASE}/collection-templates/:id`]: obligations(
    'PATCH',
    '/collection-templates/:id',
    'update',
    'scopedTarget',
  ),
  [`DELETE ${BASE}/collection-templates/:id`]: obligations(
    'DELETE',
    '/collection-templates/:id',
    'update',
    'scopedTarget',
  ),
  [`GET ${BASE}/collection-rules`]: obligations('GET', '/collection-rules', 'view', 'ruleList'),
  [`GET ${BASE}/collection-rules/:id`]: obligations('GET', '/collection-rules/:id', 'view', 'ruleDetail'),
  [`POST ${BASE}/collection-rules`]: obligations('POST', '/collection-rules', 'create', 'createRule'),
  [`PATCH ${BASE}/collection-rules/:id`]: obligations('PATCH', '/collection-rules/:id', 'update', 'scopedTarget'),
  [`DELETE ${BASE}/collection-rules/:id`]: obligations('DELETE', '/collection-rules/:id', 'update', 'scopedTarget'),
  [`GET ${BASE}/collection-settings`]: obligations('GET', '/collection-settings', 'view'),
  [`PUT ${BASE}/collection-settings`]: obligations('PUT', '/collection-settings', 'update'),
};
