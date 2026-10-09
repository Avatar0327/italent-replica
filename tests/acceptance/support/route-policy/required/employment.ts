/**
 * 必需项表：任职 / 调动（modules/employment/routes.ts、transfer/routes.ts、transfer/manager-routes.ts、
 * transfer/linkage/routes.ts；子应用挂在 /api/tenant/employment，注册路径为本地路径）。
 * 对象操作经 readContext / readPageContext（requirePermission object.<op>，配置写走 tenant.employment.configuration.write
 * → other_settings 别名）；按钮经 requireEmploymentWrite / requireTransferButton / 显式 requirePermission；调动来源经
 * requireTransferSource / transferBusinessContext → requireManagerBusinessSource；直接调动 requireDirectTransfer；业务写范围
 * authorizeBusinessWrite；直接操作范围 requireScopedEmploymentObject（DEC-193）；联动 requireLinkedEmploymentRecord（DEC-178）。
 */
import { bound, list, NONE, SCOPE_AT, withNeeds } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const SRC = 'apps/api/src/modules';
const EMP = `${SRC}/employment/routes.ts`;
const CTX = `${SRC}/employment/context.ts`;
const TRF = `${SRC}/transfer/routes.ts`;
const MGR = `${SRC}/transfer/manager-routes.ts`;
const LNK = `${SRC}/transfer/linkage/routes.ts`;
const ACCESS = `${SRC}/transfer/access.ts`;
const SERVICE = `${SRC}/transfer/service.ts`;
const RECORD = 'TenantBase.EmploymentRecord';
const EMPLOYEE = 'TenantBase.Employee';

const READ: Evidence = {
  role: 'impl',
  unit: `${CTX}#readContext`,
  anchor: 'await requirePermission(deps.authorize, { ...tenant, action: operation, resource: objectCode,',
};
const PAGE: Evidence = {
  role: 'impl',
  unit: `${CTX}#readPageContext`,
  anchor: "return readContext(c, deps, 'tenant.employment.read', 0, resource, objectCode, `${objectCode}.${page}`)",
};
const RECORD_CONST: Evidence = {
  role: 'const',
  unit: `${CTX}#EMPLOYMENT_OBJECT`,
  anchor: "'TenantBase.EmploymentRecord'",
};
const EMPLOYEE_CONST: Evidence = { role: 'const', unit: `${CTX}#EMPLOYEE_OBJECT`, anchor: "'TenantBase.Employee'" };
const WRITE_OBJECT: Evidence = {
  role: 'impl',
  unit: `${CTX}#requireEmploymentWrite`,
  anchor: 'await requireObjectWrite(ctx.authorize, ctx, { objectCode, operation, payload: actual })',
};
const WRITE_DELETE: Evidence = {
  role: 'impl',
  unit: `${CTX}#requireEmploymentWrite`,
  anchor: "await requirePermission(ctx.authorize, { ...ctx, action: 'object.delete', resource: objectCode })",
};
const WRITE_BUTTON: Evidence = {
  role: 'impl',
  unit: `${CTX}#requireEmploymentWrite`,
  anchor: "action: 'object.button', resource: buttonResource( objectCode, button,",
};
const TRANSFER_BUTTON: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#requireTransferButton`,
    anchor: "buttonResource(EMPLOYMENT_OBJECT, ROLE_BUTTONS[initiator], 'detail')",
  },
  {
    role: 'const',
    unit: `${ACCESS}#ROLE_BUTTONS`,
    anchor: "hr: 'Transfer.Hr', manager: 'Transfer.Manager', employee: 'Transfer.Self'",
  },
];
const SOURCE: Evidence[] = [
  { role: 'impl', unit: `${ACCESS}#requireTransferSource`, anchor: "throw new AppError('NOT_FOUND', '员工不存在')" },
  { role: 'impl', unit: `${ACCESS}#requireTransferSource`, anchor: 'await requireTransferButton(ctx, initiator)' },
];
const BUSINESS_SOURCE: Evidence[] = [
  {
    role: 'impl',
    unit: `${SERVICE}#transferBusinessContext`,
    anchor: "const manager = await requireManagerBusinessSource(tx, ctx, request.employeeId, phase !== 'read')",
  },
  {
    role: 'impl',
    unit: `${ACCESS}#requireManagerBusinessSource`,
    anchor: "await requireTransferSource(tx, ctx, employeeId, 'manager')",
  },
  ...SOURCE,
];
const DIRECT: Evidence[] = [
  {
    role: 'impl',
    unit: `${SERVICE}#requireDirectTransfer`,
    anchor: "throw new AppError('FORBIDDEN', '无权发起直接调动')",
  },
  { role: 'impl', unit: `${ACCESS}#transferDirectActions`, anchor: "action: 'object.button'" },
];
const LINKED: Evidence = {
  role: 'impl',
  unit: `${CTX}#requireLinkedEmploymentRecord`,
  anchor: "throw new AppError('LINKED_RECORD_OUT_OF_SCOPE'",
};
const BUSINESS_WRITE: Evidence = {
  role: 'impl',
  unit: `${EMP}#authorizeBusinessWrite`,
  anchor:
    "if (!value || (employeeId && value.employeeId !== employeeId)) throw new AppError('NOT_FOUND', '任职业务不存在')",
};
const DIRECT_OPERATION: Evidence = {
  role: 'impl',
  unit: `${CTX}#requireScopedEmploymentObject`,
  anchor: "throw new AppError('NOT_FOUND', '任职数据不存在')",
};
const EMPLOYMENT_SCOPE: Evidence = {
  role: 'impl',
  unit: `${CTX}#requireEmploymentScope`,
  anchor: "throw new AppError('NOT_FOUND', '任职数据不存在')",
};
const EMPLOYEE_TRANSFER: Evidence = {
  role: 'impl',
  unit: `${SRC}/transfer/employee-policy.ts#requireEmployeeTransferBusiness`,
  anchor: 'await requireEmployeeTransferFields(',
};
const MANAGER: Evidence = {
  role: 'impl',
  unit: `${MGR}#managerContext`,
  anchor: "if (!identity.active) throw new AppError('FORBIDDEN', '需要经理自助身份')",
};

const at = (file: string, method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${file}#route:${method} ${path}`,
  anchor,
});
const fn = (file: string, name: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${file}#${name}`,
  anchor,
});
const ob = (perm: string, facts: readonly string[], evidence: readonly Evidence[], note?: string): Obligation => ({
  perm,
  facts,
  at: evidence,
  ...(note ? { note } : {}),
});
const recordView = (call: Evidence, facts = ['object:readPageContext']) =>
  ob(`obj:${RECORD}:view`, facts, [call, PAGE, READ, RECORD_CONST]);
const managerIdentity = (call: Evidence) =>
  ob('guard:transfer.managerIdentity', ['guard:transfer.managerIdentity'], [call, MANAGER]);
const managerView = (call: Evidence) =>
  ob(
    `obj:${RECORD}:view`,
    ['object:managerContext（readPageContext）'],
    [
      call,
      { role: 'impl', unit: `${MGR}#managerContext`, anchor: "const ctx = await readPageContext(c, deps, 'detail')" },
      PAGE,
      READ,
    ],
  );
const linkage = (call: Evidence, note?: string) =>
  ob('guard:employment.linkage', ['guard:employment.linkage'], [call, LINKED], note);
const businessWrite = (call: Evidence) =>
  ob('guard:employment.businessWrite', ['guard:employment.businessWrite'], [call, BUSINESS_WRITE]);
const directOperation = (call: Evidence) => ob('guard:employment.directOperation', [], [call, DIRECT_OPERATION]);
const TRANSITIONS = fn(
  EMP,
  'registerBusinessTransitions',
  "let ctx = await readContext(c, deps, action === 'delete' ? 'object.delete' : 'object.update', revision(c))",
);

function transition(action: 'submit' | 'withdraw' | 'revoke' | 'delete'): Obligation[] {
  const button = `Employment.${action[0]!.toUpperCase()}${action.slice(1)}`;
  const op = action === 'delete' ? 'delete' : 'update';
  const write = fn(EMP, 'registerBusinessTransitions', 'await requireEmploymentWrite( ctx,');
  const out: Obligation[] = [
    ob(
      `obj:${RECORD}:${op}`,
      ['object:readContext(object.*)', 'object:object.* 动作'],
      [TRANSITIONS, READ, write, op === 'delete' ? WRITE_DELETE : WRITE_OBJECT, RECORD_CONST],
    ),
    ob(`btn:${RECORD}#${button}@detail`, [], [write, WRITE_BUTTON, RECORD_CONST]),
    businessWrite(fn(EMP, 'registerBusinessTransitions', 'await authorizeBusinessWrite(deps, ctx, id)')),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source', 'button:requireTransferButton'],
      [fn(EMP, 'registerBusinessTransitions', 'transferBusinessContext(tx, ctx, id,'), ...BUSINESS_SOURCE],
    ),
    linkage(
      fn(
        EMP,
        'registerBusinessTransitions',
        'const business = await transitionEmployment(tx, checked, { id, action })',
      ),
      '状态迁移（撤回 / 撤销 / 删除）改写后续记录前按 DEC-178 复核',
    ),
  ];
  if (action === 'submit') {
    out.push(
      ob(
        'guard:employment.employeeTransferBusiness',
        [],
        [fn(EMP, 'registerBusinessTransitions', 'requireEmployeeTransferBusiness(tx, ctx, id)'), EMPLOYEE_TRANSFER],
      ),
    );
  }
  return out;
}

const INITIATOR_BUTTON = (call: Evidence, facts: readonly string[] = ['button:requireTransferButton']) =>
  ob(
    `btn:${RECORD}#{mapper:transfer.initiatorButton}`,
    facts,
    [call, ...TRANSFER_BUTTON],
    '按钮 = 发起人（hr / manager / employee）对应的 Transfer.*',
  );
const configWrite = (call: Evidence, object: string, operation: 'create' | 'update', write: Evidence): Obligation[] =>
  withNeeds(configWriteBase(call, object, operation, write), {
    'admin:other_settings': bound(NONE),
    [`obj:${object}:${operation}`]: bound(NONE),
  });
const configWriteBase = (
  call: Evidence,
  object: string,
  operation: 'create' | 'update',
  write: Evidence,
): Obligation[] => [
  ob(
    'admin:other_settings',
    ['admin:tenant.employment.configuration'],
    [
      call,
      READ,
      {
        role: 'const',
        unit: 'packages/domain/src/permission/module-actions.ts#actions',
        anchor: "'tenant.employment.configuration.write': tenantConfiguration",
      },
    ],
  ),
  ob(`obj:${object}:${operation}`, [`objectOp:${object}:${operation}`], [write, WRITE_OBJECT]),
];

export const EMPLOYMENT: RequiredTable = {
  // ---- transfer/routes.ts：本人入口、目录、部门、预览、发起 ----------------------------------------------------------
  'GET /api/tenant/employment/transfers/self': [
    recordView(at(TRF, 'GET', '/transfers/self', "const ctx = await readPageContext(c, deps, 'detail')")),
    ob(
      `btn:${RECORD}#Transfer.Self@detail`,
      ['button:requireTransferButton'],
      [at(TRF, 'GET', '/transfers/self', "await requireTransferButton(ctx, 'employee')"), ...TRANSFER_BUTTON],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [at(TRF, 'GET', '/transfers/self', "await requireTransferSource(tx, ctx, employee.id, 'employee')"), ...SOURCE],
    ),
  ],
  'GET /api/tenant/employment/transfers/catalog': [
    recordView(at(TRF, 'GET', '/transfers/catalog', "const ctx = await readPageContext(c, deps, 'detail')")),
    ob(
      `btn:${RECORD}#{mapper:transfer.catalogButton}`,
      ['button:requireTransferButton'],
      [
        at(
          TRF,
          'GET',
          '/transfers/catalog',
          "if (c.req.query('initiator') === 'employee') { await requireTransferButton(ctx, 'employee')",
        ),
        ...TRANSFER_BUTTON,
      ],
      '只有 initiator=employee 时判 Transfer.Self；hr / manager / 缺省不判按钮',
    ),
  ],
  'GET /api/tenant/employment/transfers/manager': [
    managerView(at(MGR, 'GET', '/transfers/manager', 'const ctx = await managerContext(c, deps)')),
    managerIdentity(at(MGR, 'GET', '/transfers/manager', 'const ctx = await managerContext(c, deps)')),
    {
      perm: `btn:${RECORD}#Transfer.Manager@detail`,
      purpose: 'disclosure:canApply',
      need: NONE,
      facts: ['button:buttonResource', 'button:object.button'],
      note: '只决定响应 canApply，不拒绝请求',
      at: [
        at(
          MGR,
          'GET',
          '/transfers/manager',
          "const canApply = await deps.authorize({ ...ctx, action: 'object.button', " +
            "resource: buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Manager', 'detail'), })",
        ),
        RECORD_CONST,
      ],
    },
    {
      perm: `btn:${RECORD}#Transfer.Hr@detail`,
      purpose: 'disclosure:canViewReporting',
      need: NONE,
      facts: ['button:buttonResource', 'button:object.button'],
      note: '只决定响应 canViewReporting（managerHasHr 的布尔值直接写进响应），不拒绝请求',
      at: [
        at(MGR, 'GET', '/transfers/manager', 'canViewReporting: await managerHasHr(ctx, deps)'),
        {
          role: 'impl',
          unit: `${MGR}#managerHasHr`,
          anchor: "resource: buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Hr', 'detail')",
        },
        RECORD_CONST,
      ],
    },
  ],
  'GET /api/tenant/employment/transfers/manager/employees': [
    managerView(at(MGR, 'GET', '/transfers/manager/employees', 'const ctx = await managerContext(c, deps)')),
    managerIdentity(at(MGR, 'GET', '/transfers/manager/employees', 'const ctx = await managerContext(c, deps)')),
    ob(
      `btn:${RECORD}#Transfer.Manager@detail`,
      ['button:requireTransferButton'],
      [
        at(
          MGR,
          'GET',
          '/transfers/manager/employees',
          "if (kind === 'employees') await requireTransferButton(ctx, 'manager')",
        ),
        ...TRANSFER_BUTTON,
      ],
    ),
  ],
  'GET /api/tenant/employment/transfers/manager/team': [
    managerView(at(MGR, 'GET', '/transfers/manager/team', 'const ctx = await managerContext(c, deps)')),
    managerIdentity(at(MGR, 'GET', '/transfers/manager/team', 'const ctx = await managerContext(c, deps)')),
  ],
  'GET /api/tenant/employment/transfers/manager/search': [
    managerView(at(MGR, 'GET', '/transfers/manager/search', 'const ctx = await managerContext(c, deps)')),
    managerIdentity(at(MGR, 'GET', '/transfers/manager/search', 'const ctx = await managerContext(c, deps)')),
  ],
  'GET /api/tenant/employment/transfers/manager/references/:field': [
    managerView(at(MGR, 'GET', '/transfers/manager/references/:field', 'const ctx = await managerContext(c, deps)')),
    managerIdentity(
      at(MGR, 'GET', '/transfers/manager/references/:field', 'const ctx = await managerContext(c, deps)'),
    ),
    ob(
      `btn:${RECORD}#Transfer.Manager@detail`,
      ['button:requireTransferButton'],
      [
        at(
          MGR,
          'GET',
          '/transfers/manager/references/:field',
          "await requireTransferSource(tx, ctx, parsed.data.employeeId, 'manager')",
        ),
        ...SOURCE,
        ...TRANSFER_BUTTON,
      ],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [
        at(
          MGR,
          'GET',
          '/transfers/manager/references/:field',
          "await requireTransferSource(tx, ctx, parsed.data.employeeId, 'manager')",
        ),
        ...SOURCE,
      ],
    ),
    ob(
      'guard:transfer.referenceField',
      [],
      [
        at(
          MGR,
          'GET',
          '/transfers/manager/references/:field',
          "if (fields && !fields.has(field)) throw new AppError('FORBIDDEN', '无权查看调动参照')",
        ),
      ],
    ),
  ],
  'GET /api/tenant/employment/transfers/manager/todos': [
    managerView(at(MGR, 'GET', '/transfers/manager/todos', 'const ctx = await managerContext(c, deps)')),
    managerIdentity(at(MGR, 'GET', '/transfers/manager/todos', 'const ctx = await managerContext(c, deps)')),
    ob(
      'own:approval.recipient',
      ['own:listTodos / listNotifications / listInstances'],
      [
        at(
          MGR,
          'GET',
          '/transfers/manager/todos',
          "if (tab.data === 'pending') return listTodos(tx, ctx.tenantId, ctx.userId, page)",
        ),
      ],
    ),
    {
      perm: 'own:approval.initiatedOrParticipated',
      purpose: 'disclosure:initiated',
      need: NONE,
      note: 'tab=initiated 时改按本人发起的实例取数',
      at: [
        at(
          MGR,
          'GET',
          '/transfers/manager/todos',
          "listInstances(tx, ctx.tenantId, ctx.userId, { role: 'initiated' }, page)",
        ),
      ],
    },
    {
      perm: 'own:approval.processedByMe',
      purpose: 'disclosure:processed',
      need: NONE,
      note: 'tab=processed 时改按本人处理过的日志取数',
      at: [at(MGR, 'GET', '/transfers/manager/todos', 'l.actor_user_id=')],
    },
  ],
  'GET /api/tenant/employment/transfers/manager/reporting': [
    managerView(at(MGR, 'GET', '/transfers/manager/reporting', 'const ctx = await managerContext(c, deps)')),
    managerIdentity(at(MGR, 'GET', '/transfers/manager/reporting', 'const ctx = await managerContext(c, deps)')),
    ob(
      `btn:${RECORD}#Transfer.Hr@detail`,
      ['button:buttonResource', 'button:object.button'],
      [
        at(
          MGR,
          'GET',
          '/transfers/manager/reporting',
          "if (!(await managerHasHr(ctx, deps))) throw new AppError('FORBIDDEN', '需要人事身份')",
        ),
        {
          role: 'impl',
          unit: `${MGR}#managerHasHr`,
          anchor: "resource: buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Hr', 'detail')",
        },
        RECORD_CONST,
      ],
    ),
  ],
  'GET /api/tenant/employment/transfers/departments': [
    recordView(at(TRF, 'GET', '/transfers/departments', "const ctx = await readPageContext(c, deps, 'detail')")),
    ...(
      [
        ['hr', 'Transfer.Hr'],
        ['manager', 'Transfer.Manager'],
        ['self', 'Transfer.Self'],
      ] as const
    ).map(([alt, code]) => ({
      perm: `btn:${RECORD}#${code}@detail`,
      or: `initiator:${alt}`,
      facts: ['button:buttonResource', 'button:object.button'],
      at: [
        at(
          TRF,
          'GET',
          '/transfers/departments',
          "if (!ctx.scope?.hasDataPermission || !permitted.some(Boolean)) throw new AppError('FORBIDDEN', '无权选择调动部门')",
        ),
        at(TRF, 'GET', '/transfers/departments', `['Transfer.Hr', 'Transfer.Manager', 'Transfer.Self']`),
      ],
    })),
    ob(
      'guard:transfer.departmentField',
      [],
      [
        at(
          TRF,
          'GET',
          '/transfers/departments',
          "if (viewable && !viewable.has('departmentId')) throw new AppError('FORBIDDEN', '无权查看调动部门')",
        ),
      ],
    ),
  ],
  'POST /api/tenant/employment/transfers/employees/:id/preview': [
    recordView(
      at(TRF, 'POST', '/transfers/employees/:id/preview', "const ctx = await readPageContext(c, deps, 'detail')"),
    ),
    INITIATOR_BUTTON(at(TRF, 'POST', '/transfers/employees/:id/preview', 'return previewTransfer(tx, ctx, id, input)')),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [
        at(TRF, 'POST', '/transfers/employees/:id/preview', 'return previewTransfer(tx, ctx, id, input)'),
        {
          role: 'impl',
          unit: `${SRC}/transfer/preview.ts#previewTransfer`,
          anchor: 'await requireTransferSource(tx, ctx, employeeId, input.initiator)',
        },
        ...SOURCE,
      ],
    ),
    ob(
      'guard:transfer.direct',
      ['guard:transfer.direct'],
      [
        at(TRF, 'POST', '/transfers/employees/:id/preview', 'return previewTransfer(tx, ctx, id, input)'),
        {
          role: 'impl',
          unit: `${SRC}/transfer/preview.ts#previewTransfer`,
          anchor: "transferDirectActions(accessContext, input.initiator === 'hr' && settings.allowDirectTransfer)",
        },
        DIRECT[1]!,
      ],
      '预览只计算 allowedActions（不拒绝）；按代码路径上的具名守卫登记',
    ),
    ob(
      'guard:transfer.previewInput',
      [],
      [
        at(TRF, 'POST', '/transfers/employees/:id/preview', 'const input = await normalizeTransferInput(tx, ctx, raw)'),
        {
          role: 'impl',
          unit: `${SERVICE}#normalizeTransferInput`,
          anchor: "throw new AppError('VALIDATION_FAILED', '调动表单字段不合法', parsed.error.issues)",
        },
      ],
    ),
    ob(
      'guard:transfer.previewScope',
      [],
      [
        at(TRF, 'POST', '/transfers/employees/:id/preview', 'return previewTransfer(tx, ctx, id, input)'),
        {
          role: 'impl',
          unit: `${SRC}/transfer/preview.ts#previewTransfer`,
          anchor: 'await requireScopedEmploymentObject(tx, context, employeeId, prepared.fields.departmentId)',
        },
        DIRECT_OPERATION,
      ],
    ),
    {
      perm: `obj:${RECORD}:create`,
      purpose: 'disclosure:fieldModes',
      need: NONE,
      facts: ['object:object.* 动作'],
      note: '可编辑字段再按 object.create 字段编辑权降为 readonly，只影响响应',
      at: [
        at(
          TRF,
          'POST',
          '/transfers/employees/:id/preview',
          'const visibleForm = await visibleTransferForm(form, viewable, ctx, deps)',
        ),
        {
          role: 'impl',
          unit: `${TRF}#visibleTransferForm`,
          anchor:
            "action: 'object.create', resource: 'TenantBase.EmploymentRecord', fields: [code.replace(/^preset:/, '')]",
        },
      ],
    },
  ],
  'POST /api/tenant/employment/transfers/employees/:id': [
    ob(
      `obj:${RECORD}:create`,
      [
        'object:readContext(object.*)',
        'objectOp:TenantBase.EmploymentRecord:create',
        'object:object.* 动作',
        'object:requireObjectWrite（对象写操作权）',
      ],
      [
        at(
          TRF,
          'POST',
          '/transfers/employees/:id',
          "const ctx = await readContext(c, deps, 'object.create', revision(c))",
        ),
        READ,
        at(TRF, 'POST', '/transfers/employees/:id', 'await requireTransferWrite(prepared.context, prepared.input)'),
        {
          role: 'impl',
          unit: `${SERVICE}#requireTransferWrite`,
          anchor: "await requireEmploymentWrite(ctx, 'create', input.writable)",
        },
        WRITE_OBJECT,
      ],
    ),
    INITIATOR_BUTTON(
      at(TRF, 'POST', '/transfers/employees/:id', 'await requireTransferSource(tx, ctx, id, input.initiator)'),
      ['button:requireTransferButton', 'button:buttonResource', 'button:object.button'],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [
        at(TRF, 'POST', '/transfers/employees/:id', 'await requireTransferSource(tx, ctx, id, input.initiator)'),
        ...SOURCE,
      ],
    ),
    ob(
      'guard:transfer.direct',
      ['guard:transfer.direct'],
      [
        at(
          TRF,
          'POST',
          '/transfers/employees/:id',
          "if (input.employment.mode === 'direct') await requireDirectTransfer(tx, preview.context)",
        ),
        ...DIRECT,
      ],
      '条件守卫：mode = direct',
    ),
    ob(
      'guard:linkage.preauthorize',
      ['guard:linkage.preauthorize'],
      [
        at(
          TRF,
          'POST',
          '/transfers/employees/:id',
          'const linkageAccess = await preauthorizeLinkage(c, deps, prepared.context, {',
        ),
        {
          role: 'impl',
          unit: `${LNK}#preauthorizeLinkage`,
          anchor:
            'authorizeLinkageWrite(tx, { ...ctx, authorize: authorizeInTransaction(deps.authorize, tx) }, access, {',
        },
      ],
    ),
    linkage(
      at(
        TRF,
        'POST',
        '/transfers/employees/:id',
        'body: await createTransfer(tx, context, id, { ...prepared.input, linkageAccess })',
      ),
    ),
  ],
  // ---- transfer/linkage/routes.ts --------------------------------------------------------------------------------
  'GET /api/tenant/employment/transfers/:id/linkage': [
    ob(
      `obj:${RECORD}:view`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:view'],
      [at(LNK, 'GET', '/transfers/:id/linkage', "const ctx = await readContext(c, deps, 'object.view')"), READ],
    ),
    {
      perm: 'obj:TenantBase.EmploymentContract:view',
      purpose: 'disclosure:contractItems',
      need: list('contracts.scope'),
      facts: ['object:object.* 动作'],
      note: '合同变更子项按合同查看权 / 范围 / 字段披露，不拒绝请求',
      at: [
        at(
          LNK,
          'GET',
          '/transfers/:id/linkage',
          "visible: await deps.authorize({ ...tenant, action: 'object.view', resource: CONTRACT_OBJECT })",
        ),
        ...SCOPE_AT['contracts.scope'],
      ],
    },
  ],
  'PUT /api/tenant/employment/transfers/:id/linkage': [
    ob(
      `obj:${RECORD}:update`,
      [
        'object:readContext(object.*)',
        'objectOp:TenantBase.EmploymentRecord:update',
        'object:object.* 动作',
        'object:requireObjectWrite（对象写操作权）',
      ],
      [
        at(
          LNK,
          'PUT',
          '/transfers/:id/linkage',
          "const ctx = await readContext(c, deps, 'object.update', revision(c))",
        ),
        READ,
      ],
    ),
    INITIATOR_BUTTON(
      at(LNK, 'PUT', '/transfers/:id/linkage', 'requireLinkageSource(tx, ctx, id, business.employeeId)'),
      ['button:requireTransferButton', 'button:buttonResource', 'button:object.button'],
    ),
    ob(
      'guard:linkage.source',
      ['guard:linkage.source'],
      [
        at(LNK, 'PUT', '/transfers/:id/linkage', 'requireLinkageSource(tx, ctx, id, business.employeeId)'),
        {
          role: 'impl',
          unit: `${SRC}/transfer/linkage/service.ts#requireLinkageSource`,
          anchor: "if (ctx.authorize) await requireTransferSource(tx, ctx, employeeId, request?.initiator ?? 'hr')",
        },
      ],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [at(LNK, 'PUT', '/transfers/:id/linkage', 'requireLinkageSource(tx, ctx, id, business.employeeId)'), ...SOURCE],
    ),
    ob(
      'guard:linkage.preauthorize',
      ['guard:linkage.preauthorize'],
      [
        at(LNK, 'PUT', '/transfers/:id/linkage', 'const access = await preauthorizeLinkage(c, deps, ctx, input)'),
        {
          role: 'impl',
          unit: `${LNK}#preauthorizeLinkage`,
          anchor:
            'authorizeLinkageWrite(tx, { ...ctx, authorize: authorizeInTransaction(deps.authorize, tx) }, access, {',
        },
      ],
    ),
    linkage(
      at(LNK, 'PUT', '/transfers/:id/linkage', 'body: await updateTransferLinkage(tx, context, id, options, access)'),
    ),
  ],
  'POST /api/tenant/employment/transfers/linkage-items/:id/retry': [
    ob(
      `obj:${RECORD}:update`,
      [
        'object:readContext(object.*)',
        'objectOp:TenantBase.EmploymentRecord:update',
        'object:object.* 动作',
        'object:requireObjectWrite（对象写操作权）',
      ],
      [
        at(
          LNK,
          'POST',
          '/transfers/linkage-items/:id/retry',
          "const ctx = await readContext(c, deps, 'object.update', revision(c))",
        ),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.RetryActivation@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          LNK,
          'POST',
          '/transfers/linkage-items/:id/retry',
          "await requireEmploymentWrite(ctx, 'update', {}, 'Employment.RetryActivation')",
        ),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:linkage.retry',
      ['guard:linkage.retry'],
      [
        at(LNK, 'POST', '/transfers/linkage-items/:id/retry', 'authorizeRetry(tx, deps, ctx, id, access)'),
        { role: 'impl', unit: `${LNK}#authorizeRetry`, anchor: "throw new AppError('NOT_FOUND', '联动子项不存在')" },
      ],
    ),
    linkage(
      at(LNK, 'POST', '/transfers/linkage-items/:id/retry', 'body: await retryLinkageItem(tx, context, id, access)'),
    ),
  ],
  'GET /api/tenant/employment/transfers/employees/:id/contracts': withNeeds(
    [
      ob(
        `obj:${RECORD}:view`,
        ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:view'],
        [
          at(LNK, 'GET', '/transfers/employees/:id/contracts', "const ctx = await readContext(c, deps, 'object.view')"),
          READ,
        ],
      ),
      ob(
        'obj:TenantBase.EmploymentContract:view',
        ['object:object.* 动作', 'objectOp:TenantBase.EmploymentContract:view'],
        [
          at(
            LNK,
            'GET',
            '/transfers/employees/:id/contracts',
            "await requirePermission(deps.authorize, { ...tenant, action: 'object.view', resource: CONTRACT_OBJECT })",
          ),
        ],
      ),
      ob(
        'guard:contracts.employeeContractChoices',
        [],
        [
          at(
            LNK,
            'GET',
            '/transfers/employees/:id/contracts',
            'await checkScope(tx, { ...ctx, scope }, employeeId, row.createdBy ?? undefined)',
          ),
          {
            role: 'impl',
            unit: `${SRC}/contracts/context.ts#checkScope`,
            anchor: "throw new AppError('NOT_FOUND', '合同数据不存在')",
          },
        ],
      ),
    ],
    {
      [`obj:${RECORD}:view`]: bound(NONE),
      'obj:TenantBase.EmploymentContract:view': bound(
        list('contracts.employeeVisibility'),
        SCOPE_AT['contracts.employeeVisibility'],
      ),
    },
  ),
  // ---- 调动配置 --------------------------------------------------------------------------------------------------
  'GET /api/tenant/employment/transfers/settings': [
    ob(
      'obj:TenantBase.EmploymentSettings:view',
      ['object:configurationContext(view)'],
      [
        at(TRF, 'GET', '/transfers/settings', 'const ctx = await configurationContext(c, deps, false)'),
        {
          role: 'impl',
          unit: `${TRF}#configurationContext`,
          anchor: "write ? 'tenant.employment.configuration.write' : 'object.view'",
        },
        READ,
      ],
    ),
  ],
  'PUT /api/tenant/employment/transfers/settings': configWrite(
    at(TRF, 'PUT', '/transfers/settings', 'const ctx = await configurationContext(c, deps, true)'),
    'TenantBase.EmploymentSettings',
    'update',
    at(
      TRF,
      'PUT',
      '/transfers/settings',
      "await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings')",
    ),
  ),
  'PUT /api/tenant/employment/transfers/forms/:formId': [
    configWrite(
      at(TRF, 'PUT', '/transfers/forms/:formId', 'const ctx = await configurationContext(c, deps, true)'),
      'TenantBase.EmploymentSettings',
      'update',
      at(TRF, 'PUT', '/transfers/forms/:formId', 'const ctx = await configurationContext(c, deps, true)'),
    )[0]!,
  ],
  // ---- employment/routes.ts：员工、业务、记录 ---------------------------------------------------------------------
  'POST /api/tenant/employment/employees': [
    ob(
      `obj:${EMPLOYEE}:create`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.Employee:create', 'object:object.* 动作'],
      [
        at(
          EMP,
          'POST',
          '/employees',
          "const ctx = await readContext(c, deps, 'object.create', revision(c), undefined, EMPLOYEE_OBJECT)",
        ),
        READ,
        WRITE_OBJECT,
        EMPLOYEE_CONST,
      ],
    ),
    ob(
      `btn:${EMPLOYEE}#Employee.Create@list`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          EMP,
          'POST',
          '/employees',
          "await requireEmploymentWrite(ctx, 'create', profile, 'Employee.Create', EMPLOYEE_OBJECT)",
        ),
        WRITE_BUTTON,
      ],
    ),
  ],
  'GET /api/tenant/employment/employees': [
    ob(
      `obj:${EMPLOYEE}:view`,
      ['object:readPageContext'],
      [
        at(EMP, 'GET', '/employees', "const ctx = await readPageContext(c, deps, 'list', undefined, EMPLOYEE_OBJECT)"),
        PAGE,
        READ,
      ],
    ),
    ob(
      'guard:employment.viewableFilters',
      [],
      [
        at(
          EMP,
          'GET',
          '/employees',
          "await requireViewableFilters(deps, ctx, ['employeeStatus', 'entryStatus'], (key) => c.req.query(key))",
        ),
        {
          role: 'impl',
          unit: `${EMP}#requireViewableFilters`,
          anchor: "throw new AppError('FORBIDDEN', '筛选字段不可查看')",
        },
      ],
    ),
  ],
  'GET /api/tenant/employment/employees/:id': [
    ob(
      `obj:${EMPLOYEE}:view`,
      ['object:readPageContext'],
      [
        at(EMP, 'GET', '/employees/:id', "const ctx = await readPageContext(c, deps, 'detail', id, EMPLOYEE_OBJECT)"),
        PAGE,
        READ,
      ],
    ),
  ],
  'POST /api/tenant/employment/employees/:id/businesses': [
    ob(
      `obj:${RECORD}:create`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:create', 'object:object.* 动作'],
      [
        at(
          EMP,
          'POST',
          '/employees/:id/businesses',
          "const ctx = await readContext(c, deps, 'object.create', revision(c), id)",
        ),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Create@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          EMP,
          'POST',
          '/employees/:id/businesses',
          "await requireEmploymentWrite(ctx, 'create', rawInput as object, 'Employment.Create')",
        ),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source', 'button:requireTransferButton'],
      [at(EMP, 'POST', '/employees/:id/businesses', "await requireTransferSource(tx, ctx, id, 'hr')"), ...SOURCE],
      '条件：kind = transfer',
    ),
    ob(
      'guard:transfer.direct',
      ['guard:transfer.direct'],
      [
        at(
          EMP,
          'POST',
          '/employees/:id/businesses',
          "if (input.mode === 'direct') await requireDirectTransfer(tx, ctx)",
        ),
        ...DIRECT,
      ],
      '条件：kind = transfer 且 mode = direct',
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        at(
          EMP,
          'POST',
          '/employees/:id/businesses',
          'if (input.fields.departmentId !== undefined) requireEmploymentScope(ctx, id, input.fields.departmentId)',
        ),
        EMPLOYMENT_SCOPE,
      ],
    ),
    linkage(
      at(
        EMP,
        'POST',
        '/employees/:id/businesses',
        'const business = await createEmploymentBusiness(tx, context, id, input)',
      ),
    ),
  ],
  'GET /api/tenant/employment/employees/:id/records': [
    recordView(at(EMP, 'GET', '/employees/:id/records', "const ctx = await readPageContext(c, deps, 'list')")),
    ob(
      'guard:employment.noVisibleRecords',
      [],
      [at(EMP, 'GET', '/employees/:id/records', "if (!visible.length) throw new AppError('NOT_FOUND', '员工不存在')")],
    ),
  ],
  'POST /api/tenant/employment/employees/:id/preview': [
    recordView(at(EMP, 'POST', '/employees/:id/preview', "const ctx = await readPageContext(c, deps, 'detail', id)"), [
      'object:readPageContext',
      'object:object.* 动作',
    ]),
    ob(
      `btn:${RECORD}#Employment.Preview@detail`,
      ['button:object.button'],
      [at(EMP, 'POST', '/employees/:id/preview', "resource: 'TenantBase.EmploymentRecord#Employment.Preview@detail'")],
    ),
    ob(
      'guard:employment.inheritanceDepartment',
      [],
      [
        at(EMP, 'POST', '/employees/:id/preview', 'requireEmploymentScope(ctx, id, prepared.fields.departmentId)'),
        EMPLOYMENT_SCOPE,
      ],
    ),
  ],
  'GET /api/tenant/employment/businesses/:id': [
    recordView(at(EMP, 'GET', '/businesses/:id', "let ctx = await readPageContext(c, deps, 'detail')")),
    INITIATOR_BUTTON(at(EMP, 'GET', '/businesses/:id', 'transferBusinessContext(tx, ctx, id)')),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [at(EMP, 'GET', '/businesses/:id', 'transferBusinessContext(tx, ctx, id)'), ...BUSINESS_SOURCE],
    ),
  ],
  'GET /api/tenant/employment/records/:id': [
    recordView(at(EMP, 'GET', '/records/:id', "const ctx = await readPageContext(c, deps, 'detail')")),
  ],
  'PATCH /api/tenant/employment/businesses/:id': [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        at(EMP, 'PATCH', '/businesses/:id', "let ctx = await readContext(c, deps, 'object.update', revision(c))"),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Edit@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(EMP, 'PATCH', '/businesses/:id', "await requireEmploymentWrite(ctx, 'update', input, 'Employment.Edit')"),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source', 'button:requireTransferButton'],
      [at(EMP, 'PATCH', '/businesses/:id', 'transferBusinessContext(tx, ctx, id,'), ...BUSINESS_SOURCE],
    ),
    ob(
      'guard:employment.employeeTransferBusiness',
      [],
      [at(EMP, 'PATCH', '/businesses/:id', 'requireEmployeeTransferBusiness(tx, ctx, id, input)'), EMPLOYEE_TRANSFER],
    ),
    directOperation(
      at(
        EMP,
        'PATCH',
        '/businesses/:id',
        'requireScopedEmploymentObject(tx, ctx, current.employeeId, departmentId, id)',
      ),
    ),
    businessWrite(at(EMP, 'PATCH', '/businesses/:id', 'const current = await authorizeBusinessWrite(deps, ctx, id)')),
  ],
  'POST /api/tenant/employment/businesses/:id/submit': transition('submit'),
  'POST /api/tenant/employment/businesses/:id/withdraw': transition('withdraw'),
  'POST /api/tenant/employment/businesses/:id/revoke': transition('revoke'),
  'DELETE /api/tenant/employment/businesses/:id': transition('delete'),
  'GET /api/tenant/employment/completion-todos': [
    recordView(at(EMP, 'GET', '/completion-todos', "const ctx = await readPageContext(c, deps, 'list')")),
    ob(
      `btn:${RECORD}#Transfer.Hr@detail`,
      ['button:requireTransferButton'],
      [at(EMP, 'GET', '/completion-todos', "await requireTransferButton(ctx, 'hr')"), ...TRANSFER_BUTTON],
    ),
  ],
  'GET /api/tenant/employment/activation-todos': [
    recordView(at(EMP, 'GET', '/activation-todos', "const ctx = await readPageContext(c, deps, 'list')")),
  ],
  'POST /api/tenant/employment/businesses/:id/activation/retry': [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        at(
          EMP,
          'POST',
          '/businesses/:id/activation/retry',
          "const ctx = await readContext(c, deps, 'object.update', revision(c))",
        ),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.RetryActivation@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          EMP,
          'POST',
          '/businesses/:id/activation/retry',
          "await requireEmploymentWrite(ctx, 'update', {}, 'Employment.RetryActivation')",
        ),
        WRITE_BUTTON,
      ],
    ),
    businessWrite(
      at(
        EMP,
        'POST',
        '/businesses/:id/activation/retry',
        'const current = await authorizeBusinessWrite(deps, ctx, id)',
      ),
    ),
    linkage(
      at(EMP, 'POST', '/businesses/:id/activation/retry', 'await retryActivation(tx, context, id, current.employeeId)'),
    ),
  ],
  'POST /api/tenant/employment/employees/:id/forward-update-preview': [
    recordView(
      at(
        EMP,
        'POST',
        '/employees/:id/forward-update-preview',
        "const ctx = await readPageContext(c, deps, 'detail', id)",
      ),
      ['object:readPageContext', 'object:object.* 动作'],
    ),
    ob(
      `btn:${RECORD}#Employment.Preview@detail`,
      ['button:object.button'],
      [
        at(EMP, 'POST', '/employees/:id/forward-update-preview', 'await requirePreviewButton(deps, ctx)'),
        {
          role: 'impl',
          unit: `${EMP}#requirePreviewButton`,
          anchor: "resource: 'TenantBase.EmploymentRecord#Employment.Preview@detail'",
        },
      ],
    ),
    ob(
      'guard:employment.forwardPreview',
      [],
      [
        at(EMP, 'POST', '/employees/:id/forward-update-preview', 'previewEmploymentForwardUpdate(tx, ctx, id, input)'),
        {
          role: 'impl',
          unit: `${SRC}/employment/forward-preview.ts#previewEmploymentForwardUpdate`,
          anchor: 'requireEmploymentScope(ctx, employeeId, normalized.fields.departmentId)',
        },
        EMPLOYMENT_SCOPE,
      ],
    ),
    linkage(
      at(EMP, 'POST', '/employees/:id/forward-update-preview', 'previewEmploymentForwardUpdate(tx, ctx, id, input)'),
      '预演（dryRun）对后续记录同样按 DEC-178 可见判定',
    ),
  ],
  'POST /api/tenant/employment/records/:id/forward-update-preview': [
    recordView(
      at(EMP, 'POST', '/records/:id/forward-update-preview', "const ctx = await readPageContext(c, deps, 'detail')"),
    ),
    ob(
      `btn:${RECORD}#Employment.Preview@detail`,
      ['button:object.button'],
      [
        at(EMP, 'POST', '/records/:id/forward-update-preview', 'await requirePreviewButton(deps, ctx)'),
        {
          role: 'impl',
          unit: `${EMP}#requirePreviewButton`,
          anchor: "resource: 'TenantBase.EmploymentRecord#Employment.Preview@detail'",
        },
      ],
    ),
    directOperation(
      at(EMP, 'POST', '/records/:id/forward-update-preview', 'previewEmploymentEditForwardUpdate(tx, ctx, id, input)'),
    ),
    linkage(
      at(EMP, 'POST', '/records/:id/forward-update-preview', 'previewEmploymentEditForwardUpdate(tx, ctx, id, input)'),
    ),
  ],
  'POST /api/tenant/employment/employees/:id/import/forward-update-preview': [
    recordView(
      at(
        EMP,
        'POST',
        '/employees/:id/import/forward-update-preview',
        "const ctx = await readPageContext(c, deps, 'list', id)",
      ),
      ['object:readPageContext', 'object:object.* 动作'],
    ),
    ob(
      `btn:${RECORD}#Employment.Preview@detail`,
      ['button:object.button', 'button:requireEmploymentWrite(按钮)', 'button:requireTransferButton'],
      [
        at(EMP, 'POST', '/employees/:id/import/forward-update-preview', 'await requirePreviewButton(deps, ctx)'),
        {
          role: 'impl',
          unit: `${EMP}#requirePreviewButton`,
          anchor: "resource: 'TenantBase.EmploymentRecord#Employment.Preview@detail'",
        },
      ],
    ),
    ...importGuards(
      at(
        EMP,
        'POST',
        '/employees/:id/import/forward-update-preview',
        'await authorizeImport(deps, ctx, id, input, true)',
      ),
    ),
  ],
  'PATCH /api/tenant/employment/records/:id': [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        at(EMP, 'PATCH', '/records/:id', "const ctx = await readContext(c, deps, 'object.update', revision(c))"),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Edit@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(EMP, 'PATCH', '/records/:id', "await requireEmploymentWrite(ctx, 'update', input, 'Employment.Edit')"),
        WRITE_BUTTON,
      ],
    ),
    businessWrite(at(EMP, 'PATCH', '/records/:id', 'const current = await authorizeBusinessWrite(deps, ctx, id)')),
    directOperation(
      at(EMP, 'PATCH', '/records/:id', 'requireScopedEmploymentObject(tx, ctx, current.employeeId, departmentId, id)'),
    ),
    linkage(at(EMP, 'PATCH', '/records/:id', 'body: await editEmploymentRecord(tx, context, id, input)')),
  ],
  'POST /api/tenant/employment/employees/:id/import': [
    ob(
      `obj:${RECORD}:view`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:view', 'object:object.* 动作'],
      [fn(EMP, 'importEmployment', "const ctx = await readContext(c, deps, 'object.view', revision(c), id)"), READ],
    ),
    ob(
      `btn:${RECORD}#Employment.Import@list`,
      ['button:object.button'],
      [fn(EMP, 'authorizeImport', "resource: 'TenantBase.EmploymentRecord#Employment.Import@list'")],
    ),
    ob(
      `obj:${RECORD}:{create,update}`,
      [],
      [
        fn(
          EMP,
          'authorizeImport',
          "if (!preview) await requireEmploymentWrite(ctx, 'create', item.business as object, 'Employment.Create')",
        ),
        fn(
          EMP,
          'authorizeImport',
          "if (!preview) await requireEmploymentWrite(ctx, 'update', patch, 'Employment.Edit')",
        ),
        WRITE_OBJECT,
      ],
      '逐行：operation = create 判 create，其余判 update',
    ),
    ob(
      `btn:${RECORD}#{Employment.Create@detail,Employment.Edit@detail}`,
      ['button:requireEmploymentWrite(按钮)', 'button:requireTransferButton'],
      [
        fn(
          EMP,
          'authorizeImport',
          "if (!preview) await requireEmploymentWrite(ctx, 'create', item.business as object, 'Employment.Create')",
        ),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:employment.importTransferAccess',
      ['guard:employment.importTransferAccess'],
      [
        fn(EMP, 'importEmployment', 'body: await importWithTransferAuthorization(tx, context, id, input)'),
        {
          role: 'impl',
          unit: `${EMP}#importWithTransferAuthorization`,
          anchor: 'await requireImportTransferAccess(tx, ctx, employeeId, input)',
        },
      ],
    ),
    ...importGuards(fn(EMP, 'importEmployment', 'await authorizeImport(deps, ctx, id, input)')),
  ],
  'POST /api/tenant/employment/records/batch-edit': [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        at(EMP, 'POST', '/records/batch-edit', "const ctx = await readContext(c, deps, 'object.update')"),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Edit@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          EMP,
          'POST',
          '/records/batch-edit',
          "await requireEmploymentWrite(ctx, 'update', input.patch, 'Employment.Edit')",
        ),
        WRITE_BUTTON,
      ],
    ),
    businessWrite(
      at(EMP, 'POST', '/records/batch-edit', 'const current = await authorizeBusinessWrite(deps, ctx, item.id)'),
    ),
    directOperation(
      at(
        EMP,
        'POST',
        '/records/batch-edit',
        'requireScopedEmploymentObject(tx, ctx, current.employeeId, departmentId, item.id)',
      ),
    ),
    linkage(at(EMP, 'POST', '/records/batch-edit', 'body: await batchEditEmploymentRecords(tx, context, input)')),
  ],
  'GET /api/tenant/employment/settings': [
    ob(
      'obj:TenantBase.EmploymentSettings:view',
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentSettings:view', 'object:object.* 动作'],
      [
        at(
          EMP,
          'GET',
          '/settings',
          "const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings')",
        ),
        READ,
      ],
    ),
  ],
  'PUT /api/tenant/employment/settings': configWrite(
    at(EMP, 'PUT', '/settings', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentSettings',
    'update',
    at(
      EMP,
      'PUT',
      '/settings',
      "await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings')",
    ),
  ),
  'POST /api/tenant/employment/custom-fields': configWrite(
    at(EMP, 'POST', '/custom-fields', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentCustomField',
    'create',
    at(
      EMP,
      'POST',
      '/custom-fields',
      "await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentCustomField')",
    ),
  ),
  'GET /api/tenant/employment/custom-fields': [
    ob(
      'obj:TenantBase.EmploymentCustomField:view',
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentCustomField:view', 'object:object.* 动作'],
      [
        at(
          EMP,
          'GET',
          '/custom-fields',
          "const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentCustomField')",
        ),
        READ,
      ],
    ),
  ],
  'PUT /api/tenant/employment/custom-fields/:id/inheritance': configWrite(
    at(EMP, 'PUT', '/custom-fields/:id/inheritance', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentCustomField',
    'update',
    at(
      EMP,
      'PUT',
      '/custom-fields/:id/inheritance',
      "await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentCustomField')",
    ),
  ),
};

/** 导入 / 导入预演共用 authorizeImport 的逐行守卫。 */
function importGuards(call: Evidence): Obligation[] {
  return [
    ob(
      'guard:employment.businessWrite',
      ['guard:employment.businessWrite'],
      [
        call,
        {
          role: 'impl',
          unit: `${EMP}#authorizeImport`,
          anchor: 'await authorizeBusinessWrite(deps, ctx, item.id, employeeId)',
        },
        BUSINESS_WRITE,
      ],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [
        call,
        {
          role: 'impl',
          unit: `${EMP}#requireImportTransferAccess`,
          anchor: "await requireTransferSource(tx, ctx, employeeId, 'hr')",
        },
        ...SOURCE,
      ],
      '条件：导入行里有调动',
    ),
    ob(
      'guard:transfer.direct',
      ['guard:transfer.direct'],
      [
        call,
        {
          role: 'impl',
          unit: `${EMP}#requireImportTransferAccess`,
          anchor:
            'if (!preview && transfers.some((business) => business.mode ' +
            "=== 'direct')) await requireDirectTransfer(tx, ctx)",
        },
        ...DIRECT,
      ],
      '条件：导入行里有直接调动（预演不判）',
    ),
    ob(
      'guard:employment.directOperation',
      [],
      [
        call,
        {
          role: 'impl',
          unit: `${EMP}#authorizeImport`,
          anchor: 'requireScopedEmploymentObject(tx, ctx, employeeId, departmentId, item.id)',
        },
        DIRECT_OPERATION,
      ],
    ),
    ob(
      'guard:employment.employeeTransferBusiness',
      [],
      [
        call,
        {
          role: 'impl',
          unit: `${EMP}#authorizeImport`,
          anchor: 'requireEmployeeTransferBusiness(tx, ctx, item.id, patch)',
        },
        EMPLOYEE_TRANSFER,
      ],
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        call,
        {
          role: 'impl',
          unit: `${EMP}#authorizeImport`,
          anchor: 'requireEmploymentScope(ctx, employeeId, business.fields.departmentId)',
        },
        EMPLOYMENT_SCOPE,
      ],
    ),
    ob('guard:employment.linkage', ['guard:employment.linkage'], [call, LINKED]),
  ];
}
