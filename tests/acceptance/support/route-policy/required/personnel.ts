/**
 * 必需项表：人员信息（modules/personnel/routes.ts、subset-routes.ts、request-routes.ts、order-code-routes.ts）。
 * 对象操作与按钮经 access → authorize（requirePermission / requireObjectWrite；按钮 create / submit 为 list，其余 detail）；
 * 子集对象按 :kind 取 SUBSETS[kind].objectCode；目标人员范围经 preflight → requirePerson（404）；列表筛选 / 排序字段
 * 须可查看（listOptions → 403）；子集记录须属于该员工（loadSubset → 404）；本人申请经 requireSelf（绑定本人）。
 */
import { bound, list, SCOPE_AT, withNeeds } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/personnel/routes.ts';
const SUBSET_ROUTES = 'apps/api/src/modules/personnel/subset-routes.ts';
const ACCESS = 'apps/api/src/modules/personnel/access.ts';
const PERSON = 'TenantBase.EmployeeInformation';
const SUBSET =
  '{TenantBase.Awards,TenantBase.Certificate,TenantBase.Education,TenantBase.EstimationResult,TenantBase.Family,' +
  'TenantBase.Languageability,TenantBase.ProfessionalTechnicalPostInfo,TenantBase.ProjectExperience,' +
  'TenantBase.Punish,TenantBase.Skill,TenantBase.Training,' +
  'TenantBase.VocationalQualificationInfo,TenantBase.jobhistory}';
const ACCESS_IMPL: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#access`,
  anchor: 'await authorize(deps.authorize, ctx, operation, payload, button)',
};
const AUTHORIZE: Evidence[] = [
  ACCESS_IMPL,
  {
    role: 'impl',
    unit: `${ACCESS}#authorize`,
    anchor: 'await requireObjectWrite(authorizer, ctx, { objectCode: ctx.objectCode, operation, payload })',
  },
  {
    role: 'impl',
    unit: `${ACCESS}#authorize`,
    anchor:
      'else await requirePermission(authorizer, { ...ctx, action: `object.${operation}`, resource: ctx.objectCode })',
  },
];
const BUTTON: Evidence[] = [
  ACCESS_IMPL,
  {
    role: 'impl',
    unit: `${ACCESS}#authorize`,
    anchor:
      "resource: buttonResource(ctx.objectCode, button, ['create', 'submit'].includes(button) ? 'list' : 'detail')",
  },
];
const PERSON_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECT',
  anchor: "'TenantBase.EmployeeInformation'",
};
const SUBSET_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/personnel/fields.ts#SUBSETS',
  anchor: "objectCode: 'TenantBase.Education'",
};
const call = (file: string, method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${file}#route:${method} /api/tenant/personnel${path}`,
  anchor,
});
const person = (method: string, path: string) => (anchor: string) => call(ROUTES, method, `/employees${path}`, anchor);
const subset = (method: string, path: string) => (anchor: string) =>
  call(SUBSET_ROUTES, method, `/employees/:employeeId/subsets/:kind${path}`, anchor);

function op(
  at: (anchor: string) => Evidence,
  perm: string,
  anchor: string,
  facts: readonly string[],
  constant: Evidence,
): Obligation {
  return { perm, facts, at: [at(anchor), ...AUTHORIZE, constant] };
}
function btn(at: (anchor: string) => Evidence, perm: string, anchor: string, constant: Evidence): Obligation {
  return { perm, facts: ['button:personnel access(button)'], at: [at(anchor), ...BUTTON, constant] };
}
const viewableFilters = (at: Evidence): Obligation => ({
  perm: 'guard:personnel.viewableFilters',
  facts: ['guard:personnel.viewableFilters'],
  at: [
    at,
    {
      role: 'impl',
      unit: 'apps/api/src/modules/personnel/lists.ts#listOptions',
      anchor: "throw new AppError('FORBIDDEN', '员工排序或筛选字段不可查看')",
    },
  ],
});
const byId = (at: (anchor: string) => Evidence, anchor: string): Obligation => ({
  perm: 'guard:personnel.subset.byId',
  at: [
    at(anchor),
    {
      role: 'impl',
      unit: 'apps/api/src/modules/personnel/subsets.ts#loadSubset',
      anchor: 'WHERE tenant_id=',
    },
  ],
});
const PERSON_FACTS = ['object:personnel access', `objectOp:${PERSON}:view`];
const SUBSET_OP = (op: string) => `objectOp:${SUBSET.slice(1, -1).split(',').join('|')}:${op}`;
const orderCode = (method: 'GET' | 'PUT' | 'POST'): Obligation => ({
  perm: 'admin:other_settings',
  facts: ['admin:tenant.settings.*'],
  at: [
    method === 'GET'
      ? call(
          'apps/api/src/modules/personnel/order-code-routes.ts',
          'GET',
          '/order-code/settings',
          "await requirePermission(deps.authorize, { ...ctx, action: 'tenant.settings.read', resource })",
        )
      : {
          role: 'call',
          unit: 'apps/api/src/modules/personnel/order-code-routes.ts#registerOrderCodeRoutes',
          anchor:
            "const permission = { ...ctx, action: 'tenant.settings.write', " +
            'resource }; await requirePermission(deps.authorize, permission)',
        },
    {
      role: 'const',
      unit: 'packages/domain/src/permission/module-actions.ts#actions',
      anchor: "'tenant.settings.read': tenantConfiguration, 'tenant.settings.write': tenantConfiguration",
    },
  ],
});
const VIEW_LIST = "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view', {}, undefined, 0, 'list')";

export const PERSONNEL: RequiredTable = {
  'GET /api/tenant/personnel/order-code/settings': [orderCode('GET')],
  'PUT /api/tenant/personnel/order-code/settings': [orderCode('PUT')],
  'POST /api/tenant/personnel/order-code/recompute': [orderCode('POST')],
  'GET /api/tenant/personnel/employees': [
    op(
      person('GET', ''),
      `obj:${PERSON}:view`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, undefined, 0, 'list')",
      PERSON_FACTS,
      PERSON_CONST,
    ),
    viewableFilters(person('GET', '')('const options = await listOptions(c, deps, ctx)')),
  ],
  'GET /api/tenant/personnel/employees/:id': [
    op(
      person('GET', '/:id'),
      `obj:${PERSON}:view`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view')",
      PERSON_FACTS,
      PERSON_CONST,
    ),
    {
      perm: 'obj:{mapper:personnel.nestedSubsets}:view',
      purpose: 'disclosure:nestedSubsets',
      need: list('personnel.personScope'),
      facts: ['object:object.* 动作'],
      note: 'includeSubsets=true 时逐子集 object.view，无权的子集跳过（不拒绝请求）',
      at: [
        person(
          'GET',
          '/:id',
        )("if (c.req.query('includeSubsets') === 'true') result.subsets = await nestedSubsets(deps, ctx, id)"),
        {
          role: 'impl',
          unit: `${ROUTES}#nestedSubsets`,
          anchor: "if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: objectCode }))) continue",
        },
        SUBSET_CONST,
        ...SCOPE_AT['personnel.personScope(nested)'],
      ],
    },
  ],
  'PATCH /api/tenant/personnel/employees/:id': [
    op(
      person('PATCH', '/:id'),
      `obj:${PERSON}:update`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'update', input, 'update', revision(c))",
      ['object:personnel access', `objectOp:${PERSON}:update`],
      PERSON_CONST,
    ),
    btn(
      person('PATCH', '/:id'),
      `btn:${PERSON}#update@detail`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'update', input, 'update', revision(c))",
      PERSON_CONST,
    ),
  ],
  'POST /api/tenant/personnel/employees/:id/attachments': [
    op(
      person('POST', '/:id/attachments'),
      `obj:${PERSON}:update`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'update', {}, 'update', revision(c))",
      ['object:personnel access', `objectOp:${PERSON}:update`],
      PERSON_CONST,
    ),
    btn(
      person('POST', '/:id/attachments'),
      `btn:${PERSON}#update@detail`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'update', {}, 'update', revision(c))",
      PERSON_CONST,
    ),
  ],
  'GET /api/tenant/personnel/employees/:id/tenure': [
    op(
      person('GET', '/:id/tenure'),
      `obj:${PERSON}:view`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view')",
      PERSON_FACTS,
      PERSON_CONST,
    ),
  ],
  'GET /api/tenant/personnel/employees/:id/history': [
    op(
      person('GET', '/:id/history'),
      `obj:${PERSON}:view`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, 'history')",
      PERSON_FACTS,
      PERSON_CONST,
    ),
    btn(
      person('GET', '/:id/history'),
      `btn:${PERSON}#history@detail`,
      "const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, 'history')",
      PERSON_CONST,
    ),
  ],
  // 同一查看权由两个承载节点提供：列表按 personScope 过滤（need），preflight 另做 employeeId 点校验（requirePerson）
  'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind': withNeeds(
    [
      op(
        subset('GET', ''),
        `obj:${SUBSET}:view`,
        VIEW_LIST,
        ['object:personnel access', SUBSET_OP('view')],
        SUBSET_CONST,
      ),
      viewableFilters(subset('GET', '')('const options = await listOptions(c, deps, ctx)')),
    ],
    { [`obj:${SUBSET}:view`]: bound(list('personnel.personScope'), SCOPE_AT['personnel.personScope(subsets)']) },
  ),
  'GET /api/tenant/personnel/subsets/:kind': [
    op(
      (anchor) => call(SUBSET_ROUTES, 'GET', '/subsets/:kind', anchor),
      `obj:${SUBSET}:view`,
      VIEW_LIST,
      ['object:personnel access', SUBSET_OP('view')],
      SUBSET_CONST,
    ),
    viewableFilters(call(SUBSET_ROUTES, 'GET', '/subsets/:kind', 'const options = await listOptions(c, deps, ctx)')),
  ],
  'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id': [
    op(
      subset('GET', '/:id'),
      `obj:${SUBSET}:view`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view')",
      ['object:personnel access', SUBSET_OP('view')],
      SUBSET_CONST,
    ),
    byId(subset('GET', '/:id'), 'loadSubset(tx, ctx, employeeId, kind, uuidParam(c))'),
  ],
  'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id/history': [
    op(
      subset('GET', '/:id/history'),
      `obj:${SUBSET}:view`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view', {}, 'history')",
      ['object:personnel access', SUBSET_OP('view')],
      SUBSET_CONST,
    ),
    btn(
      subset('GET', '/:id/history'),
      `btn:${SUBSET}#history@detail`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view', {}, 'history')",
      SUBSET_CONST,
    ),
    byId(subset('GET', '/:id/history'), 'await loadSubset(tx, ctx, employeeId, kind, id, true)'),
  ],
  'POST /api/tenant/personnel/employees/:employeeId/subsets/:kind': [
    op(
      subset('POST', ''),
      `obj:${SUBSET}:create`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'create', input, 'create', revision(c))",
      ['object:personnel access', SUBSET_OP('create')],
      SUBSET_CONST,
    ),
    btn(
      subset('POST', ''),
      `btn:${SUBSET}#create@list`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'create', input, 'create', revision(c))",
      SUBSET_CONST,
    ),
  ],
  'PATCH /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id': [
    op(
      subset('PATCH', '/:id'),
      `obj:${SUBSET}:update`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'update', input, 'update', revision(c))",
      ['object:personnel access', SUBSET_OP('update')],
      SUBSET_CONST,
    ),
    btn(
      subset('PATCH', '/:id'),
      `btn:${SUBSET}#update@detail`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'update', input, 'update', revision(c))",
      SUBSET_CONST,
    ),
  ],
  'DELETE /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id': [
    op(
      subset('DELETE', '/:id'),
      `obj:${SUBSET}:delete`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'delete', {}, 'delete', revision(c))",
      ['object:personnel access', SUBSET_OP('delete')],
      SUBSET_CONST,
    ),
    btn(
      subset('DELETE', '/:id'),
      `btn:${SUBSET}#delete@detail`,
      "const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'delete', {}, 'delete', revision(c))",
      SUBSET_CONST,
    ),
  ],
  'POST /api/tenant/personnel/change-requests': [
    {
      perm: 'self',
      facts: ['self:requireSelf'],
      at: [
        call('apps/api/src/modules/personnel/request-routes.ts', 'POST', '/change-requests', 'await requireSelf(tx, {'),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/personnel/change-requests.ts#requireSelf',
          anchor: "if (!link) throw new AppError('NOT_FOUND', '个人信息不存在')",
        },
      ],
    },
    {
      perm: 'btn:self#self-service-submit@list',
      facts: ['button:buttonResource', 'button:object.button'],
      note: '按钮对象是 TenantBase.PersonalInformationChange（声明的本人节点不带对象）',
      at: [
        call(
          'apps/api/src/modules/personnel/request-routes.ts',
          'POST',
          '/change-requests',
          "resource: buttonResource(PERSONNEL_REQUEST_OBJECT, 'self-service-submit', 'list')",
        ),
      ],
    },
    {
      perm: 'guard:personnel.selfServiceFields',
      facts: ['guard:personnel.selfServiceFields'],
      at: [
        call(
          'apps/api/src/modules/personnel/request-routes.ts',
          'POST',
          '/change-requests',
          'await assertSelfServiceFields(tx, tenant.tenantId, kind, Object.keys(input.values))',
        ),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/personnel/change-requests.ts#assertSelfServiceFields',
          anchor: "throw new AppError('FORBIDDEN', '字段不在员工自助修改清单内')",
        },
      ],
    },
  ],
  'GET /api/tenant/personnel/change-requests/:id': [
    {
      perm: 'obj:TenantBase.PersonalInformationChange:view',
      facts: ['object:personnel access', 'objectOp:TenantBase.PersonalInformationChange:view'],
      at: [
        call(
          'apps/api/src/modules/personnel/request-routes.ts',
          'GET',
          '/change-requests/:id',
          "const ctx = await access(c, deps, PERSONNEL_REQUEST_OBJECT, 'view')",
        ),
        ...AUTHORIZE,
      ],
    },
    {
      perm: 'self',
      facts: ['self:requireSelf'],
      at: [
        call(
          'apps/api/src/modules/personnel/request-routes.ts',
          'GET',
          '/change-requests/:id',
          'await requireSelf(tx, ctx, String(row.employeeId))',
        ),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/personnel/change-requests.ts#requireSelf',
          anchor: "if (!link) throw new AppError('NOT_FOUND', '个人信息不存在')",
        },
      ],
    },
  ],
};
