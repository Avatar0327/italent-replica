import type { Evidence, Need, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/onboarding/integration/schemes';
const FILE = 'apps/api/src/modules/onboarding/integration-schemes';
const SETTINGS = 'TenantBase.EmploymentSettings';
const adminScope: Need = { scope: 'none' };
const list: Need = { scope: 'list', predicate: 'onboarding.schemeScopeSql' };
const point: Need = { scope: 'point', locator: 'onboarding.readScheme' };
const input: Need = { scope: 'guard', guard: 'onboarding.requireSchemeOrgs' };
const scope: Evidence = {
  role: 'scope',
  unit: `${FILE}-access.ts#schemeScope`,
  anchor: 'resolveModuleScopeInTransaction(deps, ctx, tx, SCHEME_SCOPE)',
};
const listScope: Evidence = {
  role: 'scope',
  unit: `${FILE}-read.ts#listSchemes`,
  anchor: 'visible(scope)',
};
const pointScope: Evidence = {
  role: 'scope',
  unit: `${FILE}-read.ts#readScheme`,
  anchor: 'visible(scope)',
};
const incoming: Evidence = {
  role: 'scope',
  unit: `${FILE}-access.ts#requireSchemeOrgs`,
  anchor: 'ids.some((orgId) => !scopeAllows(scope, { orgId }))',
};
const route = (key: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${FILE}-routes.ts#route:${key}`,
  anchor,
});
const objectConst: Evidence = {
  role: 'const',
  unit: `${FILE}-access.ts#SCHEME_SETTINGS`,
  anchor: 'MODULE_OBJECTS.employmentSettings.code',
};
const fieldConst: Evidence = {
  role: 'const',
  unit: `${FILE}-access.ts#SCHEME_FIELDS`,
  anchor: "['integrationSchemes']",
};
const declar = (role: Evidence['role'], unit: string, anchor: string): Evidence => ({
  role,
  unit: `${FILE}${unit}`,
  anchor,
});

function read(key: string, need: Need, scopeEvidence: Evidence, disclosed: 'create' | 'update'): Obligation[] {
  const endpoint = route(key, 'await requireSchemeView(authorize, tenant)');
  return [
    {
      perm: 'admin:other_settings',
      need: adminScope,
      facts: ['admin:admin.*'],
      at: [
        endpoint,
        declar(
          'impl',
          '-access.ts#requireSchemeView',
          "await requirePermission(authorize, { ...ctx, action: 'admin.other_settings' })",
        ),
      ],
    },
    {
      perm: `obj:${SETTINGS}:view`,
      need,
      facts: ['object:object.* 动作', `objectOp:${SETTINGS}:view`],
      at: [
        endpoint,
        declar(
          'impl',
          '-access.ts#requireSchemeView',
          "action: 'object.view', resource: SCHEME_SETTINGS, fields: SCHEME_FIELDS",
        ),
        objectConst,
        fieldConst,
        scope,
        scopeEvidence,
      ],
    },
    {
      perm: `obj:${SETTINGS}:${disclosed}`,
      purpose: 'disclosure:availableActions',
      need,
      at: [
        route(key, `await schemeActions(authorize, tenant, '${disclosed}')`),
        declar('impl', '-access.ts#schemeActions', 'resource: SCHEME_SETTINGS, fields: SCHEME_FIELDS'),
        objectConst,
        fieldConst,
        scope,
        scopeEvidence,
      ],
    },
  ];
}

function write(key: string, operation: 'create' | 'update', need: Need, scopeEvidence: Evidence): Obligation[] {
  const endpoint = route(key, `schemeWrite(c, deps, '${operation}'`);
  const guard = declar('call', '-routes.ts#schemeWrite', 'await requireSchemeWriteScope(tx, deps, tenant, operation)');
  const recheck = declar(
    'call',
    '-access.ts#requireSchemeWriteScope',
    'await requireSchemeWrite(authorizeInTransaction(deps.authorize, tx), ctx, operation)',
  );
  return [
    {
      perm: 'admin:other_settings',
      need: adminScope,
      facts: ['admin:tenant.employment.configuration'],
      at: [
        endpoint,
        guard,
        recheck,
        declar(
          'impl',
          '-access.ts#requireSchemeWrite',
          'await requirePermission(authorize, { ...ctx, action: SCHEME_WRITE_ALIAS, resource: SCHEME_SETTINGS })',
        ),
        declar('const', '-access.ts#SCHEME_WRITE_ALIAS', "'tenant.employment.configuration.write'"),
      ],
    },
    {
      perm: `obj:${SETTINGS}:${operation}`,
      need,
      facts: ['object:requireObjectWrite（对象写操作权）'],
      at: [
        endpoint,
        guard,
        recheck,
        declar(
          'impl',
          '-access.ts#requireSchemeWrite',
          'objectCode: SCHEME_SETTINGS, operation, payload: { integrationSchemes: true }',
        ),
        objectConst,
        scope,
        scopeEvidence,
        declar('call', '-routes.ts#schemeWrite', 'requireSchemeResultScope(tx, tenant.tenantId, scope, body, deleted)'),
      ],
    },
  ];
}

export const ONBOARDING_SCHEMES: RequiredTable = {
  [`GET ${BASE}`]: read('GET /schemes', list, listScope, 'create'),
  [`GET ${BASE}/:id`]: read('GET /schemes/:id', point, pointScope, 'update'),
  [`POST ${BASE}`]: [
    ...write('POST /schemes', 'create', input, incoming),
    {
      perm: 'guard:onboarding.requireSchemeOrgs',
      at: [
        route('POST /schemes', "schemeWrite(c, deps, 'create'"),
        declar('call', '-routes.ts#schemeWrite', 'requireSchemeOrgs(scope, input.orgIds)'),
        incoming,
      ],
    },
  ],
  [`PATCH ${BASE}/:id`]: write('PATCH /schemes/:id', 'update', point, pointScope),
  [`DELETE ${BASE}/:id`]: write('DELETE /schemes/:id', 'update', point, pointScope),
};
