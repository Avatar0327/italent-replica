import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/onboarding';
const ROUTES = 'apps/api/src/modules/onboarding/preparation-config-routes.ts';
const CONFIG = 'apps/api/src/modules/onboarding/preparation-config.ts';
const SCOPE = 'apps/api/src/modules/onboarding/preparation-config-scope.ts';
const OBJECT = 'TenantBase.EmploymentSettings';
const objectWriteFact = 'object:requireObjectWrite（对象写操作权）';

const at = (role: Evidence['role'], file: string, name: string, anchor: string): Evidence => ({
  role,
  unit: `${file}#${name}`,
  anchor,
});
const rulePredicate = at(
  'scope',
  ROUTES,
  'readRule',
  'preparationRuleScope(ctx, await preparationConfigScope(deps, tx, ctx),',
);
const target = at('scope', ROUTES, 'writeConfig', 'if (id) target = await scope!.target(id)');
const createScope = at('scope', CONFIG, 'writePreparationConfig', 'await scope.orgs(orgIds)');

function preparation(method: string, path: string, operation: 'view' | 'create' | 'update'): Obligation[] {
  const read = operation === 'view';
  const rule = path.startsWith('/preparation-rules');
  const entry = at(
    'call',
    ROUTES,
    `route:${method} ${path}`,
    read ? (rule ? 'readRule(c, deps' : 'readConfig(c, deps,') : 'writeConfig(',
  );
  const scope =
    read && rule
      ? path.endsWith(':id')
        ? 'ruleDetail'
        : 'ruleList'
      : operation === 'update'
        ? 'target'
        : operation === 'create' && rule
          ? 'create'
          : 'none';
  const guard = scope === 'ruleDetail' ? 'onboarding.preparationRuleScope' : 'onboarding.preparationConfigScope';
  const evidence =
    scope === 'ruleDetail' || scope === 'ruleList'
      ? [rulePredicate]
      : scope === 'target'
        ? [target]
        : scope === 'create'
          ? [createScope]
          : [];
  const admin = read
    ? at('impl', ROUTES, 'requirePreparationView', "action: 'admin.other_settings'")
    : at('impl', ROUTES, 'requirePreparationWrite', "action: 'tenant.employment.configuration.write'");
  const object = read
    ? at('impl', ROUTES, 'requirePreparationView', "action: 'object.view', resource: PREPARATION_SETTINGS")
    : at('impl', ROUTES, 'requirePreparationWrite', 'requireObjectWrite(authorize, ctx,');
  if (scope === 'target')
    evidence.push(at('impl', ROUTES, 'bindPreparationScope', 'requirePreparationTarget(tx, ctx, kind, scope, id)'));
  if (scope === 'create')
    evidence.push(at('impl', ROUTES, 'bindPreparationScope', 'requirePreparationRoots(tx, ctx, scope, orgIds)'));
  const obligations: Obligation[] = [
    {
      perm: 'admin:other_settings',
      facts: read ? ['admin:admin.*'] : ['admin:tenant.employment.configuration'],
      need: { scope: 'none' },
      at: [entry, admin],
    },
    {
      perm: `obj:${OBJECT}:${operation}`,
      facts: read ? ['object:object.* 动作', `objectOp:${OBJECT}:view`] : [objectWriteFact],
      need:
        scope === 'none'
          ? { scope: 'none' }
          : scope === 'ruleList'
            ? { scope: 'list', predicate: 'onboarding.preparationRuleScope' }
            : { scope: 'guard', guard },
      at: [
        entry,
        object,
        at('const', SCOPE, 'PREPARATION_SETTINGS', 'MODULE_OBJECTS.employmentSettings.code'),
        ...evidence,
      ],
    },
  ];
  if (scope !== 'none' && scope !== 'ruleList') obligations.push({ perm: `guard:${guard}`, at: [entry, ...evidence] });
  return obligations;
}

export const PREPARATION_REQUIRED: RequiredTable = Object.fromEntries(
  ['/preparation-items', '/preparation-rules'].flatMap((path) => {
    const target = `${path}/:id`;
    return [
      [`GET ${BASE}${path}`, preparation('GET', path, 'view')],
      [`GET ${BASE}${target}`, preparation('GET', target, 'view')],
      [`POST ${BASE}${path}`, preparation('POST', path, 'create')],
      [`PATCH ${BASE}${target}`, preparation('PATCH', target, 'update')],
      [`DELETE ${BASE}${target}`, preparation('DELETE', target, 'update')],
    ];
  }),
);
