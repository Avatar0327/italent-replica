import type { Evidence, Need, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/onboarding';
const OBJECT = 'TenantBase.EmploymentSettings';

const inFn = (role: Evidence['role'], file: string, name: string, anchor: string): Evidence => ({
  role,
  unit: `${file}#${name}`,
  anchor,
});

const MATERIAL_ROUTES = 'apps/api/src/modules/onboarding/material-config-routes.ts';
const MATERIAL_CONFIG = 'apps/api/src/modules/onboarding/material-config.ts';
const MATERIAL_LIST = 'apps/api/src/modules/onboarding/material-list.ts';
const MATERIAL_LIST_ROUTES = 'apps/api/src/modules/onboarding/material-list-routes.ts';
const materialCall = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${MATERIAL_ROUTES}#route:${method} ${path}`,
  anchor,
});

function materialConfigObligations(
  method: string,
  path: string,
  operation: 'view' | 'create' | 'update',
): Obligation[] {
  const read = operation === 'view';
  const entry = materialCall(method, path, read ? 'readConfig(c, deps' : 'writeConfig(c, deps,');
  const admin = inFn(
    'impl',
    MATERIAL_ROUTES,
    read ? 'requireMaterialConfigView' : 'requireMaterialConfigWrite',
    read ? "action: 'admin.other_settings'" : "action: 'tenant.employment.configuration.write'",
  );
  const object = read
    ? inFn('impl', MATERIAL_ROUTES, 'requireMaterialConfigView', "action: 'object.view', resource: SETTINGS")
    : inFn('impl', MATERIAL_ROUTES, 'requireMaterialConfigWrite', 'await requireObjectWrite(authorize, ctx,');
  const scope = read
    ? [inFn('scope', MATERIAL_CONFIG, 'readMaterialRules', 'materialRuleScope(ctx, scope)')]
    : operation === 'create'
      ? [
          inFn(
            'scope',
            MATERIAL_CONFIG,
            'saveMaterialRule',
            'await requireMaterialOrgScope(tx, ctx, scope, input.orgIds)',
          ),
        ]
      : [
          inFn(
            'scope',
            MATERIAL_ROUTES,
            'writeConfig',
            'if (id) target = await materialWriteTarget(tx, ctx, scope, id)',
          ),
        ];
  const need: Need = read
    ? path.endsWith('/:id')
      ? { scope: 'guard', guard: 'onboarding.materialRuleScope' }
      : { scope: 'list', predicate: 'onboarding.materialRuleScope' }
    : { scope: 'guard', guard: 'onboarding.materialConfigScope' };
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
      need,
      at: [
        entry,
        object,
        inFn('const', MATERIAL_ROUTES, 'SETTINGS', 'MODULE_OBJECTS.employmentSettings.code'),
        ...scope,
      ],
    },
  ];
  if ('guard' in need) entries.push({ perm: `guard:${need.guard}`, at: [entry, ...scope] });
  return entries;
}

function materialListObligations(): Obligation[] {
  const entry = materialCall('GET', '/entries/:businessId/materials', 'readEntryMaterials(c, deps)');
  const guard = 'onboarding.materialEntryScope';
  const scope = inFn('scope', MATERIAL_LIST, 'readMaterialList', 'materialEntryScope(ctx.tenantId,');
  return [
    ...['TenantBase.EmploymentRecord', 'TenantBase.OnboardingMaterial'].map((object, index): Obligation => ({
      perm: `obj:${object}:view`,
      facts: ['object:object.* 动作', `objectOp:${object}:view`],
      need: { scope: 'guard', guard },
      at: [
        entry,
        scope,
        inFn(
          'impl',
          MATERIAL_LIST_ROUTES,
          'readEntryMaterials',
          `action: 'object.view', resource: ${index === 0 ? 'EMPLOYMENT_OBJECT' : 'MATERIAL'}`,
        ),
      ],
    })),
    { perm: `guard:${guard}`, at: [entry, scope] },
  ];
}

export const ONBOARDING_MATERIAL: RequiredTable = {
  [`GET ${BASE}/material-rules`]: materialConfigObligations('GET', '/material-rules', 'view'),
  [`GET ${BASE}/material-rules/:id`]: materialConfigObligations('GET', '/material-rules/:id', 'view'),
  [`POST ${BASE}/material-rules`]: materialConfigObligations('POST', '/material-rules', 'create'),
  [`PATCH ${BASE}/material-rules/:id`]: materialConfigObligations('PATCH', '/material-rules/:id', 'update'),
  [`DELETE ${BASE}/material-rules/:id`]: materialConfigObligations('DELETE', '/material-rules/:id', 'update'),
  [`GET ${BASE}/entries/:businessId/materials`]: materialListObligations(),
};
