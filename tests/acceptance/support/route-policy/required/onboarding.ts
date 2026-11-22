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

const ruleRead = inFn('scope', ROUTES, 'readRule', 'ruleScopeSql(ctx, await collectionScope(deps, tx, ctx),');
const bindOrg = inFn('impl', ROUTES, 'bindCollectionWriteScope', 'requireCollectionOrgScope(tx, ctx, scope, orgIds)');
const bindTarget = inFn(
  'impl',
  ROUTES,
  'bindCollectionWriteScope',
  'requireCollectionTarget(tx, { ctx, scope }, kind, id)',
);
const scopes = {
  ruleList: { need: { scope: 'list', predicate: 'onboarding.ruleScopeSql' }, at: [ruleRead] },
  ruleDetail: { need: { scope: 'guard', guard: 'onboarding.ruleScopeSql' }, at: [ruleRead] },
  createRule: {
    need: { scope: 'guard', guard: 'onboarding.collectionConfigScope' },
    at: [inFn('scope', CONFIG, 'writeCollectionResource', 'await scope!.orgs(input.orgIds)'), bindOrg],
  },
  scopedTarget: {
    need: { scope: 'guard', guard: 'onboarding.collectionConfigScope' },
    at: [inFn('scope', ROUTES, 'writeConfig', 'if (id) await scope!.target(id)'), bindTarget],
  },
} satisfies Record<string, { need: Need; at: Evidence[] }>;

function obligations(
  method: string,
  path: string,
  operation: 'view' | 'create' | 'update',
  scope?: keyof typeof scopes,
): Obligation[] {
  const read = operation === 'view';
  const entry = apiCall(method, path, read ? (scope ? 'readRule(c, deps' : 'readConfig(c, deps,') : 'writeConfig(');
  const scoped = scope ? scopes[scope] : undefined;
  const admin = inFn(
    'impl',
    ROUTES,
    read ? 'requireConfigView' : 'requireConfigWrite',
    read ? "action: 'admin.other_settings'" : "action: 'tenant.employment.configuration.write'",
  );
  const object = read
    ? inFn('impl', ROUTES, 'requireConfigView', "action: 'object.view', resource: SETTINGS, fields: [kind]")
    : inFn(
        'impl',
        ROUTES,
        'requireConfigWrite',
        'await requireObjectWrite(authorize, ctx, { objectCode: SETTINGS, operation, payload: { [kind]: true } })',
      );
  const entries: Obligation[] = [
    {
      perm: 'admin:other_settings',
      facts: read ? ['admin:admin.*'] : ['admin:tenant.employment.configuration'],
      need: { scope: 'none' },
      at: [entry, admin],
    },
    {
      perm: `obj:${OBJECT}:${operation}`,
      facts: read ? ['object:object.* 动作', `objectOp:${OBJECT}:view`] : ['object:requireObjectWrite（对象写操作权）'],
      need: scoped?.need ?? { scope: 'none' },
      at: [
        entry,
        object,
        inFn('const', SCOPE, 'SETTINGS', 'MODULE_OBJECTS.employmentSettings.code'),
        ...(scoped?.at ?? []),
      ],
    },
  ];
  if (scoped && 'guard' in scoped.need) entries.push({ perm: `guard:${scoped.need.guard}`, at: [entry, ...scoped.at] });
  return entries;
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
