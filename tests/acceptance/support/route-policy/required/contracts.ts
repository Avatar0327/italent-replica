/**
 * 必需项表：劳动合同（modules/contracts/，子应用挂在 /api/tenant/contracts）。读经 routeContext（write = false 时
 * requirePermission object.view）；写不判 view，经 checkFields / requireObjectWrite 判 create / update + 字段编辑权；
 * 命令与批量按 contractAction 映射按钮；导入共用 authorizeImport（逐行字段权、checkImportScope、initialize 另要删除权）；
 * 合并待办逐条：业务类型须是合同、当前审批人（approve / decline / reject）或重提权（resubmit）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/contracts/routes.ts';
const CONTEXT = 'apps/api/src/modules/contracts/context.ts';
const CONTRACT = 'TenantBase.EmploymentContract';
const OBJECT_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/contracts/rules.ts#CONTRACT_OBJECT',
  anchor: "'TenantBase.EmploymentContract'",
};
const VIEW: Evidence = {
  role: 'impl',
  unit: `${ROUTES}#routeContext`,
  anchor:
    'if (!write) await requirePermission(deps.authorize, { tenantId: ' +
    "ctx.tenantId, userId: ctx.userId, action: 'object.view', resource: object, })",
};
const CHECK_FIELDS: Evidence = {
  role: 'impl',
  unit: `${CONTEXT}#checkFields`,
  anchor: 'await requireObjectWrite(ctx.authorize, ctx, { objectCode: CONTRACT_OBJECT, operation,',
};
const call = (method: string, path: string, anchor: string, unit?: string): Evidence => ({
  role: 'call',
  unit: unit ?? `${ROUTES}#route:${method} ${path}`,
  anchor,
});
function view(path: string, object = CONTRACT, anchor = 'const ctx = await routeContext(c, deps)'): Obligation {
  return {
    perm: `obj:${object}:view`,
    facts: ['object:routeContext'],
    at: [call('GET', path, anchor), VIEW, ...(object === CONTRACT ? [OBJECT_CONST] : [])],
  };
}
function write(
  method: string,
  path: string,
  object: string,
  operation: 'create' | 'update',
  anchor: string,
): Obligation {
  return {
    perm: `obj:${object}:${operation}`,
    facts: ['object:requireObjectWrite（对象写操作权）'],
    at: [
      call(method, path, anchor),
      {
        role: 'impl',
        unit: 'apps/api/src/modules/permission/object-write.ts#requireObjectWrite',
        anchor: 'action: `object.${write.operation}`',
      },
    ],
  };
}
const COMMAND_BUTTON = (unit: string): Evidence => ({
  role: 'call',
  unit,
  anchor: 'resource: buttonResource( CONTRACT_OBJECT, contractAction(',
});
const command = (path: '/commands' | '/batch'): Obligation[] => {
  const unit = `${ROUTES}#route:POST ${path}`;
  return [
    {
      perm: `obj:${CONTRACT}:{create,update}`,
      facts: ['object:contracts checkFields（对象写操作权）'],
      note: 'create → create，其余操作 → update（checkFields）',
      at: [{ role: 'call', unit, anchor: "=== 'create' ? 'create' : 'update'" }, CHECK_FIELDS, OBJECT_CONST],
    },
    {
      perm: `btn:${CONTRACT}#{mapper:contracts.commandButton}`,
      facts: ['button:buttonResource', 'button:object.button'],
      note: '按钮 = contractAction(operation, mode)，create 为 list、其余 detail',
      at: [
        COMMAND_BUTTON(unit),
        {
          role: 'const',
          unit: 'packages/domain/src/contracts/rules.ts#contractAction',
          anchor: "return mode === 'application' ? `${operation}Application` : operation",
        },
        OBJECT_CONST,
      ],
    },
  ];
};
const IMPORT = `${ROUTES}#registerImports`;
const AUTHORIZE_IMPORT = `${ROUTES}#authorizeImport`;
const imports: Obligation[] = [
  {
    perm: `btn:${CONTRACT}#import@list`,
    facts: ['button:buttonResource', 'button:object.button'],
    at: [
      { role: 'call', unit: IMPORT, anchor: "resource: buttonResource(CONTRACT_OBJECT, 'import', 'list')" },
      OBJECT_CONST,
    ],
  },
  {
    perm: `obj:${CONTRACT}:{create,update}`,
    facts: ['object:contracts checkFields（对象写操作权）'],
    note: '逐行：edit / change 判 update，add / initialize 判 create',
    at: [
      {
        role: 'call',
        unit: AUTHORIZE_IMPORT,
        anchor: "await checkFields(ctx, ['edit', 'change'].includes(input.mode) ? 'update' : 'create', row.fields)",
      },
      CHECK_FIELDS,
      OBJECT_CONST,
    ],
  },
  {
    perm: 'guard:contracts.importScope',
    facts: ['guard:contracts.importScope'],
    at: [
      { role: 'call', unit: AUTHORIZE_IMPORT, anchor: 'checkImportScope(tx, ctx, input)' },
      {
        role: 'impl',
        unit: 'apps/api/src/modules/contracts/imports.ts#checkImportScope',
        anchor: 'await checkScope(tx, ctx, row.employeeId)',
      },
      { role: 'impl', unit: `${CONTEXT}#checkScope`, anchor: "throw new AppError('NOT_FOUND', '合同数据不存在')" },
    ],
  },
  {
    perm: 'guard:contracts.importInitializeDelete',
    facts: ['guard:contracts.importInitializeDelete'],
    note: '条件守卫：mode = initialize 时另要合同删除权',
    at: [
      {
        role: 'call',
        unit: AUTHORIZE_IMPORT,
        anchor: "if (input.mode === 'initialize') await requirePermission(deps.authorize, {",
      },
    ],
  },
  {
    perm: `obj:${CONTRACT}:delete`,
    purpose: 'when:contracts.importInitializeDelete',
    facts: ['object:object.* 动作'],
    at: [
      { role: 'call', unit: AUTHORIZE_IMPORT, anchor: "action: 'object.delete', resource: CONTRACT_OBJECT" },
      OBJECT_CONST,
    ],
  },
];

export const CONTRACTS: RequiredTable = {
  'GET /api/tenant/contracts': [view('/')],
  'GET /api/tenant/contracts/employees/:id/revision': [view('/employees/:id/revision')],
  'GET /api/tenant/contracts/records/:id': [view('/records/:id')],
  'POST /api/tenant/contracts/commands': command('/commands'),
  'POST /api/tenant/contracts/batch': command('/batch'),
  'GET /api/tenant/contracts/settings': [
    view(
      '/settings',
      'TenantBase.ContractSettings',
      "const ctx = await routeContext(c, deps, 'TenantBase.ContractSettings')",
    ),
  ],
  'PUT /api/tenant/contracts/settings': [
    write(
      'PUT',
      '/settings',
      'TenantBase.ContractSettings',
      'update',
      "await requireObjectWrite(deps.authorize, ctx, { objectCode: object, operation: 'update', payload: input })",
    ),
  ],
  'GET /api/tenant/contracts/rules': [
    view('/rules', 'TenantBase.ContractRenewalRule', 'const ctx = await routeContext(c, deps, object)'),
  ],
  'POST /api/tenant/contracts/rules': [
    {
      ...write('POST', '/rules', 'TenantBase.ContractRenewalRule', 'create', ''),
      at: [
        { role: 'call', unit: `${ROUTES}#registerConfiguration`, anchor: "operation: id ? 'update' : 'create'" },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/permission/object-write.ts#requireObjectWrite',
          anchor: 'action: `object.${write.operation}`',
        },
      ],
    },
  ],
  'PUT /api/tenant/contracts/rules/:id': [
    {
      ...write('PUT', '/rules/:id', 'TenantBase.ContractRenewalRule', 'update', ''),
      at: [
        { role: 'call', unit: `${ROUTES}#registerConfiguration`, anchor: "operation: id ? 'update' : 'create'" },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/permission/object-write.ts#requireObjectWrite',
          anchor: 'action: `object.${write.operation}`',
        },
      ],
    },
  ],
  ...Object.fromEntries(
    (
      [
        ['types', 'TenantBase.ContractType'],
        ['companies', 'TenantBase.ContractCompany'],
      ] as const
    ).flatMap(([kind, object]) => {
      const masterWrite = (operation: 'create' | 'update'): Obligation => ({
        perm: `obj:${object}:${operation}`,
        facts: ['object:requireObjectWrite（对象写操作权）'],
        at: [
          { role: 'call', unit: `${ROUTES}#registerMasters`, anchor: "operation: suffix ? 'update' : 'create'" },
          {
            role: 'impl',
            unit: 'apps/api/src/modules/permission/object-write.ts#requireObjectWrite',
            anchor: 'action: `object.${write.operation}`',
          },
          {
            role: 'const',
            unit: `${ROUTES}#registerMasters`,
            anchor: `kind === 'types' ? 'TenantBase.ContractType' : 'TenantBase.ContractCompany'`,
          },
        ],
      });
      return [
        [
          `GET /api/tenant/contracts/master-data/${kind}`,
          [
            {
              perm: `obj:${object}:view`,
              facts: ['object:routeContext'],
              at: [
                {
                  role: 'call',
                  unit: `${ROUTES}#registerMasters`,
                  anchor: 'const ctx = await routeContext(c, deps, object)',
                },
                VIEW,
              ],
            },
          ],
        ],
        [`POST /api/tenant/contracts/master-data/${kind}`, [masterWrite('create')]],
        [`PUT /api/tenant/contracts/master-data/${kind}/:id`, [masterWrite('update')]],
      ];
    }),
  ),
  'POST /api/tenant/contracts/imports': imports,
  'POST /api/tenant/contracts/imports/preview': imports,
  'POST /api/tenant/contracts/imports/errors': imports,
  'POST /api/tenant/contracts/requests/:id/cancel': [
    write(
      'POST',
      '/requests/:id/cancel',
      CONTRACT,
      'update',
      'await requireObjectWrite(deps.authorize, ctx, { objectCode: ' +
        "CONTRACT_OBJECT, operation: 'update', payload: {} })",
    ),
    {
      perm: `btn:${CONTRACT}#withdraw@detail`,
      facts: ['button:buttonResource', 'button:object.button'],
      at: [
        call('POST', '/requests/:id/cancel', "resource: buttonResource(CONTRACT_OBJECT, 'withdraw', 'detail')"),
        OBJECT_CONST,
      ],
    },
  ],
  'GET /api/tenant/contracts/failures': [view('/failures')],
  'GET /api/tenant/contracts/requests/:id': [view('/requests/:id')],
  'POST /api/tenant/contracts/todos/batch': [
    {
      perm: 'rel:{approval.currentAssignee,approval.initiator}',
      facts: [
        'relation:currentAssignee（assertOpen / openTask）',
        'relation:initiator（withdraw / resubmit right）',
        'relation:instanceOfTask',
      ],
      note: '逐条：resubmit 按发起人重提权，其余按当前审批人（assignee_user_id = 本人，否则 403）',
      at: [
        {
          role: 'call',
          unit: 'apps/api/src/modules/contracts/todos.ts#registerMergedTodos',
          anchor: "if (!task) throw new AppError('FORBIDDEN', '只有当前审批人可以处理该任务')",
        },
        {
          role: 'call',
          unit: 'apps/api/src/modules/contracts/todos.ts#registerMergedTodos',
          anchor: "if (input.action === 'resubmit') await requireResubmitRight(deps, ctx, instanceId)",
        },
      ],
    },
    {
      perm: 'guard:contracts.todoIsContract',
      at: [
        {
          role: 'call',
          unit: 'apps/api/src/modules/contracts/todos.ts#registerMergedTodos',
          anchor: "if (instance.businessType !== 'contract') throw new AppError('NOT_FOUND', '合同待办不存在')",
        },
      ],
    },
    {
      perm: 'guard:approval.resubmitRight',
      facts: ['guard:approval.resubmitRight'],
      at: [
        {
          role: 'call',
          unit: 'apps/api/src/modules/contracts/todos.ts#registerMergedTodos',
          anchor: 'requireResubmitRight(deps, ctx, id, corrections, tx)',
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/approval/access.ts#requireResubmitRight',
          anchor: 'if (!mayResubmit(instance.initiatorUserId, ctx.userId))',
        },
      ],
    },
  ],
};
