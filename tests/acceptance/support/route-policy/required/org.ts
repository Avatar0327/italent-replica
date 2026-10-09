/**
 * 必需项表：组织（modules/org/routes.ts）。对象操作经 context → objectContext（requirePermission object.<op>）；
 * 按钮经 module-route-access.button；配置两条经 context('configuration') → admin.other_settings；上级可见经
 * visibleParents（范围外 404）；人员候选是 DEC-135 例外（三个人员字段之一可编辑）；“同步任职”联动（addEmployment）
 * 经 write 内 authorizeOrgEmploymentReplay → requireLinkedEmploymentRecord（DEC-178）。
 */
import type { Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/org/routes.ts';
const ACCESS = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJ = 'TenantBase.Organization';
const OBJECT_CONST = [
  { role: 'const', unit: `${ROUTES}#OBJECT`, anchor: 'MODULE_OBJECTS.organization.code' },
  {
    role: 'const',
    unit: 'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS>organization',
    anchor: "object( 'Organization'",
  },
] as const;
const CONTEXT = [
  {
    role: 'impl',
    unit: `${ROUTES}#context`,
    anchor: "else await objectContext(c, deps, OBJECT, action === 'read' ? 'view' : action, expectedRevision)",
  },
  {
    role: 'impl',
    unit: `${ACCESS}#objectContext`,
    anchor:
      'await requirePermission(deps.authorize, { ...ctx, action: ' +
      '`object.${operation}`, resource: objectCode, fields: [] })',
  },
  ...OBJECT_CONST,
] as const;
const BUTTON = {
  role: 'impl',
  unit: `${ACCESS}#button`,
  anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
} as const;
const call = (method: string, path: string, anchor: string) =>
  ({ role: 'call', unit: `${ROUTES}#route:${method} /api/tenant/org${path}`, anchor }) as const;
const CONTEXT_FACT = 'object:org context(read|create|update|delete)';

function op(
  method: string,
  path: string,
  operation: 'view' | 'create' | 'update' | 'delete',
  anchor: string,
): Obligation {
  return {
    perm: `obj:${OBJ}:${operation}`,
    facts: [CONTEXT_FACT, `objectOp:${OBJ}:${operation}`],
    at: [call(method, path, anchor), ...CONTEXT],
  };
}
function btn(method: string, path: string, code: string, level: 'list' | 'detail', unit?: string): Obligation {
  const anchor = `await button(deps, ctx, OBJECT, '${code}', '${level}')`;
  return {
    perm: `btn:${OBJ}#${code}@${level}`,
    facts: ['button:button()'],
    at: [unit ? ({ role: 'call', unit, anchor } as const) : call(method, path, anchor), BUTTON, ...OBJECT_CONST],
  };
}
function parents(method: string, path: string, anchor: string): Obligation {
  return {
    perm: 'guard:org.visibleParents',
    facts: ['guard:org.visibleParents'],
    at: [
      call(method, path, anchor),
      { role: 'impl', unit: `${ROUTES}#visibleParents`, anchor: "visible( scope, parent.parentId, '组织不存在'" },
    ],
  };
}
const LINKAGE: Obligation = {
  perm: 'guard:employment.linkage',
  facts: ['guard:employment.linkage'],
  note: '只在 addEmployment = true（同步任职）时：命令内与返回前按 DEC-178 复核联动足迹',
  at: [
    { role: 'call', unit: `${ROUTES}#write`, anchor: 'await authorizeOrgEmploymentReplay(tx, {' },
    {
      role: 'impl',
      unit: 'apps/api/src/modules/org/employment-linkage.ts#authorizeOrgEmploymentReplay',
      anchor: 'await requireLinkedEmploymentRecord(tx, ctx, record.employeeId, record.fields.departmentId, record.id)',
    },
    {
      role: 'impl',
      unit: 'apps/api/src/modules/employment/context.ts#requireLinkedEmploymentRecord',
      anchor: "throw new AppError('LINKED_RECORD_OUT_OF_SCOPE'",
    },
  ],
};
const settings = (method: string): Obligation => ({
  perm: 'admin:other_settings',
  facts: ['admin:org context(configuration)'],
  at: [
    call(method, '/settings', "context(c, deps, 'configuration'"),
    {
      role: 'impl',
      unit: `${ROUTES}#context`,
      anchor:
        "if (action === 'configuration') await requirePermission(deps.authorize, " +
        "{ ...ctx, action: 'admin.other_settings' })",
    },
  ],
});
const READ = "const ctx = await context(c, deps, 'read')";

export const ORG: RequiredTable = {
  'GET /api/tenant/org/organizations': [op('GET', '/organizations', 'view', READ)],
  'GET /api/tenant/org/organizations/:id': [op('GET', '/organizations/:id', 'view', READ)],
  'GET /api/tenant/org/settings': [settings('GET')],
  'GET /api/tenant/org/views': [op('GET', '/views', 'view', READ)],
  'GET /api/tenant/org/person-candidates': [
    {
      perm: 'exception:org.anyPersonFieldEditable',
      note: 'DEC-135：组织新增或编辑权 + 负责人 / HRBP / 店长任一字段可编辑；候选全租户在职员工，不按范围过滤',
      at: [
        call(
          'GET',
          '/person-candidates',
          "const allowed = await anyPersonFieldEditable(deps, ctx); if (!allowed) throw new AppError('FORBIDDEN'",
        ),
        {
          role: 'impl',
          unit: `${ROUTES}#anyPersonFieldEditable`,
          anchor: 'const request = { ...ctx, action: `object.${operation}`, resource: OBJECT, fields: [field] }',
        },
        ...OBJECT_CONST,
      ],
    },
  ],
  'POST /api/tenant/org/code-reservations': [
    op('POST', '/code-reservations', 'create', "const ctx = await context(c, deps, 'create', revision(c))"),
    btn('POST', '/code-reservations', 'reserve', 'list'),
  ],
  'DELETE /api/tenant/org/code-reservations/:id': [
    op('DELETE', '/code-reservations/:id', 'delete', "const ctx = await context(c, deps, 'delete', revision(c))"),
    btn('DELETE', '/code-reservations/:id', 'release', 'detail'),
  ],
  'POST /api/tenant/org/validate': [
    op('POST', '/validate', 'create', "const ctx = await context(c, deps, 'create')"),
    btn('POST', '/validate', 'validate', 'detail'),
    parents('POST', '/validate', 'await visibleParents(deps, ctx, input.parents, scope)'),
  ],
  'POST /api/tenant/org/organizations': [
    op('POST', '/organizations', 'create', "const ctx = await context(c, deps, 'create', revision(c))"),
    parents('POST', '/organizations', 'await visibleParents(deps, ctx, input.parents, scope)'),
  ],
  'PATCH /api/tenant/org/organizations/:id': [
    op('PATCH', '/organizations/:id', 'update', "const ctx = await context(c, deps, 'update', revision(c))"),
    btn('PATCH', '/organizations/:id', 'update', 'detail'),
    parents('PATCH', '/organizations/:id', 'if (input.parents) await visibleParents(deps, ctx, input.parents, scope)'),
    LINKAGE,
  ],
  'PUT /api/tenant/org/settings': [settings('PUT')],
  'POST /api/tenant/org/organizations/:id/employment-preview': [
    op('POST', '/organizations/:id/employment-preview', 'update', "const ctx = await context(c, deps, 'update')"),
    btn('POST', '/organizations/:id/employment-preview', 'update', 'detail'),
  ],
  'PATCH /api/tenant/org/organizations/:id/correction': [
    op('PATCH', '/organizations/:id/correction', 'update', "const ctx = await context(c, deps, 'update', revision(c))"),
  ],
  'POST /api/tenant/org/import': [
    op('POST', '/import', 'view', "const ctx = await context(c, deps, 'read', revision(c))"),
    btn('POST', '/import', 'import', 'list', `${ROUTES}#importOrgRows`),
    {
      perm: `obj:${OBJ}:{mapper:org.importRowOperation}`,
      note: '逐行：已有目标组织（且不是本命令新建的重放）判 update，否则判 create（writeFields → requireObjectWrite）',
      at: [
        { role: 'call', unit: `${ROUTES}#importOrgRows`, anchor: "targetId && !replayCreated ? 'update' : 'create'" },
        {
          role: 'impl',
          unit: `${ACCESS}#writeFields`,
          anchor: 'await requireObjectWrite(deps.authorize, ctx, {',
        },
        ...OBJECT_CONST,
      ],
    },
    LINKAGE,
  ],
};
