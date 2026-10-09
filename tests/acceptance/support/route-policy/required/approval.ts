/**
 * 必需项表：审批中心（modules/approval/，子应用挂在 /api/tenant/approval）。流程查看 = 流程管理员（admin.process_matrix）
 * 或流程对象 object.view（requireProcessView，“或”组 processView）；流程写入 requireProcessButton → process_matrix；
 * 任务动作 = 当前审批人（openTask，命令内）；撤回审批 = 本人的审批（retrieveTask）；实例动作 = 发起人（openOwn /
 * requireResubmitRight）；详情 / 历史 = assertCanOpen（参与人或范围内管理员）；管理员动作 = 实例按钮 + 业务范围（adminScope）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const DIR = 'apps/api/src/modules/approval';
const ROUTES = `${DIR}/routes.ts`;
const ACCESS = `${DIR}/access.ts`;
const ACTIONS = `${DIR}/actions.ts`;
const INSTANCE = 'TenantBase.ApprovalInstance';
const route = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:${method} ${path}`,
  anchor,
});
const fn = (name: string, anchor: string, file = ROUTES): Evidence => ({
  role: 'call',
  unit: `${file}#${name}`,
  anchor,
});
const PROCESS_ADMIN: Evidence = { role: 'const', unit: `${ACCESS}#PROCESS_ADMIN`, anchor: "'admin.process_matrix'" };
const IS_ADMIN: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#isProcessAdmin`,
  anchor: 'return deps.authorize({ ...ctx, action: PROCESS_ADMIN })',
};
const VIEW_IMPL: Evidence[] = [
  { role: 'impl', unit: `${ACCESS}#requireProcessView`, anchor: 'if (await isProcessAdmin(deps, ctx)) return' },
  IS_ADMIN,
  {
    role: 'impl',
    unit: `${ACCESS}#requireProcessView`,
    anchor:
      "await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: APPROVAL_PROCESS_OBJECT })",
  },
  PROCESS_ADMIN,
];

function processView(call: Evidence, facts: readonly string[] = ['or:approval.requireProcessView']): Obligation[] {
  return [
    { perm: 'admin:process_matrix', or: 'processView:admin', facts, at: [call, ...VIEW_IMPL] },
    {
      perm: 'obj:TenantBase.ApprovalProcess:view',
      or: 'processView:object',
      facts: ['or:approval.requireProcessView'],
      at: [call, ...VIEW_IMPL],
    },
  ];
}
function processWrite(call: Evidence): Obligation {
  return {
    perm: 'admin:process_matrix',
    facts: ['admin:requireProcessButton'],
    at: [
      call,
      {
        role: 'impl',
        unit: `${ACCESS}#requireProcessButton`,
        anchor: 'await requirePermission(deps.authorize, { ...ctx, action: PROCESS_ADMIN })',
      },
      PROCESS_ADMIN,
    ],
  };
}
const ADMIN_SCOPE: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#adminScope`,
    anchor: "allowed ||= await hasButton(deps, ctx, button, button === 'adminLogs' ? 'list' : 'detail')",
  },
  {
    role: 'impl',
    unit: `${ACCESS}#hasButton`,
    anchor: "action: 'object.button', resource: buttonResource(APPROVAL_INSTANCE_OBJECT, button, level)",
  },
];
const ASSIGNEE: Obligation = {
  perm: 'rel:approval.currentAssignee',
  facts: ['relation:currentAssignee（assertOpen / openTask）', 'relation:instanceOfTask'],
  at: [
    fn(
      'openTask',
      "if (task.assigneeUserId !== ctx.userId) throw approvalError('FORBIDDEN', 'APPROVAL_NOT_ASSIGNEE'",
      ACTIONS,
    ),
  ],
};
const assignee = (call: Evidence): Obligation => ({ ...ASSIGNEE, at: [call, ...ASSIGNEE.at] });
const TASK_OBJECT = 'obj:{record:approval.taskObject.fieldObjectCode}';
const blindReview = (call: Evidence): Obligation => ({
  perm: `${TASK_OBJECT}:view`,
  purpose: 'disclosure:taskObject',
  note: '审批人对快照对象的字段查看权只决定盲审（不足时 Outcome 403 已提交入台账）与详情披露，不在入口拒绝',
  at: [
    call,
    {
      role: 'impl',
      unit: `${ROUTES}#fieldRights`,
      anchor: 'const base = await getModuleViewableFields(deps, ctx, objectCode)',
    },
  ],
});
const fieldRights = (call: Evidence): Obligation[] => [
  {
    perm: 'guard:approval.fieldRights',
    note: '条件守卫：body.fields 非空时另要快照对象的 update + 字段编辑权',
    at: [call, { role: 'impl', unit: `${ROUTES}#fieldRights`, anchor: 'if (edits && Object.keys(edits).length)' }],
  },
  {
    perm: `${TASK_OBJECT}:update`,
    purpose: 'when:approval.fieldRights',
    at: [
      call,
      {
        role: 'impl',
        unit: `${ROUTES}#fieldRights`,
        anchor: "await requireObjectWrite(deps.authorize, ctx, { objectCode, operation: 'update', payload: edits })",
      },
    ],
  },
];
const CAN_OPEN: Evidence = {
  role: 'impl',
  unit: `${DIR}/disclosure.ts#assertCanOpen`,
  anchor: "throw new AppError('NOT_FOUND', '审批实例不存在')",
};
function canOpen(call: Evidence): Obligation[] {
  return [
    {
      perm: 'rel:approval.canOpen',
      at: [
        call,
        {
          role: 'impl',
          unit: `${DIR}/disclosure.ts#readDetail`,
          anchor: 'await assertCanOpen(tx, ctx, instance, viewer)',
        },
        CAN_OPEN,
      ],
    },
    ...(['adminTransfer', 'adminIntervene'] as const).map((code): Obligation => ({
      perm: `btn:${INSTANCE}#${code}@detail`,
      purpose: 'guard:approval.canOpen',
      note: '范围内的实例管理员也能打开详情（assertCanOpen 的管理员分支）；同时决定详情里公布的管理员动作',
      at: [
        call,
        { role: 'impl', unit: `${ROUTES}#viewerOf`, anchor: `adminScope(deps, ctx, ['${code}'])` },
        ...ADMIN_SCOPE,
      ],
    })),
  ];
}
const decision = (path: string): Obligation[] => {
  const call = fn('registerTaskRoutes', 'const viewable = await fieldRights(c, deps, taskId, input.fields)');
  return [
    assignee(fn('registerTaskRoutes', 'act(tx, context, request, viewable)')),
    blindReview(call),
    ...fieldRights(call),
  ].map((o) => ({ ...o, note: o.note ?? `POST ${path}` }));
};
const initiator = (call: Evidence, facts: readonly string[] = []): Obligation => ({
  perm: 'rel:approval.initiator',
  facts,
  at: [
    call,
    fn('openOwn', "throw approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有发起人可以执行该操作')", ACTIONS),
  ],
});
const adminAction = (code: 'adminTransfer' | 'adminIntervene'): Obligation => ({
  perm: `btn:${INSTANCE}#${code}@detail`,
  facts: ['button:adminScope(buttons)'],
  at: [
    fn(
      'registerInstanceRoutes',
      "if (!scopeSql) throw approvalError('FORBIDDEN', 'APPROVAL_ADMIN_REQUIRED', '无权转交或干预流程')",
    ),
    ...ADMIN_SCOPE,
  ],
});

export const APPROVAL: RequiredTable = {
  'GET /api/tenant/approval/types': processView(route('GET', '/types', 'await requireProcessView(deps, tenantCtx(c))')),
  'GET /api/tenant/approval/processes': processView(route('GET', '/processes', 'await requireProcessView(deps, ctx)'), [
    'or:approval.requireProcessView',
    'admin:isProcessAdmin',
  ]),
  'GET /api/tenant/approval/processes/:id': processView(
    route('GET', '/processes/:id', 'await requireProcessView(deps, ctx)'),
    ['or:approval.requireProcessView', 'admin:isProcessAdmin'],
  ),
  'POST /api/tenant/approval/processes': [
    processWrite(route('POST', '/processes', "await requireProcessButton(deps, ctx, 'create')")),
  ],
  'PUT /api/tenant/approval/processes/:id/draft': [
    processWrite(route('PUT', '/processes/:id/draft', "await requireProcessButton(deps, ctx, 'update')")),
  ],
  ...Object.fromEntries(
    ['versions', 'publish', 'discard'].map((path) => [
      `POST /api/tenant/approval/processes/:id/${path}`,
      [processWrite(fn('registerProcessRoutes', 'await requireProcessButton(deps, ctx, button)'))],
    ]),
  ),
  'POST /api/tenant/approval/exception-admins/handover': [
    processWrite(route('POST', '/exception-admins/handover', "await requireProcessButton(deps, ctx, 'publish')")),
    {
      perm: `btn:${INSTANCE}#adminTransfer@detail`,
      purpose: 'disclosure:instanceTransfer',
      facts: ['button:adminScope(buttons)', 'scope:adminScope'],
      note: '在途实例改派只限转交按钮 + 业务范围内的实例（scopeSql 为 null 则不改派），不拒绝交接本身',
      at: [
        route('POST', '/exception-admins/handover', "const scopeSql = await adminScope(deps, ctx, ['adminTransfer'])"),
        ...ADMIN_SCOPE,
      ],
    },
  ],
  'POST /api/tenant/approval/presets/install': [
    processWrite(route('POST', '/presets/install', "await requireProcessButton(deps, ctx, 'installPresets')")),
  ],
  'POST /api/tenant/approval/processes/:id/simulate': processView(
    route('POST', '/processes/:id/simulate', "await requireProcessButton(deps, ctx, 'simulate')"),
  ),
  'POST /api/tenant/approval/simulate': processView(
    route('POST', '/simulate', "await requireProcessButton(deps, ctx, 'simulateByObject')"),
  ),
  'GET /api/tenant/approval/todos': [
    {
      perm: 'own:approval.recipient',
      facts: ['own:listTodos / listNotifications / listInstances'],
      at: [
        route('GET', '/todos', 'listTodos(tx, ctx.tenantId, ctx.userId, page)'),
        fn('listTodos', 't.assignee_user_id=', `${DIR}/queries.ts`),
      ],
    },
  ],
  'GET /api/tenant/approval/notifications': [
    {
      perm: 'own:approval.recipient',
      facts: ['own:listTodos / listNotifications / listInstances'],
      at: [
        route('GET', '/notifications', 'listNotifications(tx, ctx.tenantId, ctx.userId, page)'),
        fn('listNotifications', 'recipient_user_id=', `${DIR}/queries.ts`),
      ],
    },
  ],
  'GET /api/tenant/approval/instances': [
    {
      perm: 'own:approval.initiatedOrParticipated',
      facts: ['own:listTodos / listNotifications / listInstances'],
      at: [route('GET', '/instances', 'listInstances(tx, ctx.tenantId, ctx.userId, { role,')],
    },
  ],
  'GET /api/tenant/approval/instances/:id': canOpen(fn('respondDetail', 'const viewer = await viewerOf(deps, ctx)')),
  'GET /api/tenant/approval/instances/:id/tasks': canOpen(
    fn('respondHistory', 'const detail = await readDetail(tx, ctx, instanceId, viewer)'),
  ),
  'GET /api/tenant/approval/instances/:id/logs': canOpen(
    fn('respondHistory', 'const detail = await readDetail(tx, ctx, instanceId, viewer)'),
  ),
  'GET /api/tenant/approval/admin-logs': [
    {
      perm: `btn:${INSTANCE}#adminLogs@list`,
      facts: ['button:adminScope(buttons)'],
      at: [
        route(
          'GET',
          '/admin-logs',
          "if (!scopeSql) throw approvalError('FORBIDDEN', 'APPROVAL_ADMIN_REQUIRED', '无权查看流程管理日志')",
        ),
        ...ADMIN_SCOPE,
      ],
    },
  ],
  'POST /api/tenant/approval/tasks/:id/approve': decision('/tasks/:id/approve'),
  'POST /api/tenant/approval/tasks/:id/disagree': decision('/tasks/:id/disagree'),
  'POST /api/tenant/approval/tasks/:id/reject': decision('/tasks/:id/reject'),
  'POST /api/tenant/approval/tasks/:id/reject-previous': decision('/tasks/:id/reject-previous'),
  'POST /api/tenant/approval/tasks/:id/jump': [
    assignee(route('POST', '/tasks/:id/jump', 'jumpTask(tx, context, request)')),
  ],
  'POST /api/tenant/approval/tasks/:id/transfer': [
    assignee(route('POST', '/tasks/:id/transfer', 'transferTask(tx, context, request)')),
  ],
  'POST /api/tenant/approval/tasks/:id/add-sign': [
    assignee(route('POST', '/tasks/:id/add-sign', 'addSign(tx, context, request, viewable)')),
    blindReview(route('POST', '/tasks/:id/add-sign', 'const viewable = await fieldRights(c, deps, taskId, undefined)')),
  ],
  'POST /api/tenant/approval/tasks/:id/cc': [
    assignee(route('POST', '/tasks/:id/cc', 'copySend(tx, context, request)')),
  ],
  'POST /api/tenant/approval/tasks/:id/retrieve': [
    {
      perm: 'rel:approval.retrievable',
      facts: ['relation:instanceOfTask', 'relation:retrievable（retrievableTask）'],
      at: [
        route('POST', '/tasks/:id/retrieve', 'retrieveTask(tx, context, taskId)'),
        fn(
          'retrieveTask',
          "throw approvalError('FORBIDDEN', 'APPROVAL_NOT_ASSIGNEE', '只能撤回本人的审批')",
          `${DIR}/node-actions.ts`,
        ),
        fn('retrieveTask', "throw approvalError('CONFLICT', 'APPROVAL_NOT_RETRIEVABLE'", `${DIR}/node-actions.ts`),
      ],
    },
  ],
  'POST /api/tenant/approval/tasks/:id/edit': [
    assignee(route('POST', '/tasks/:id/edit', 'editTask(tx, context, request, viewable)')),
    blindReview(route('POST', '/tasks/:id/edit', 'const viewable = await fieldRights(c, deps, taskId, input.fields)')),
    ...fieldRights(
      route('POST', '/tasks/:id/edit', 'const viewable = await fieldRights(c, deps, taskId, input.fields)'),
    ),
  ],
  'POST /api/tenant/approval/instances/:id/resubmit': [
    {
      perm: 'rel:approval.initiator',
      facts: ['relation:initiator（withdraw / resubmit right）'],
      at: [
        route('POST', '/instances/:id/resubmit', 'await requireResubmitRight(deps, ctx, id, input.fields)'),
        {
          role: 'impl',
          unit: `${ACCESS}#requireResubmitRight`,
          anchor: "throw approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有原发起人可以重新提交')",
        },
      ],
    },
    {
      perm: 'guard:approval.resubmitRight',
      facts: ['guard:approval.resubmitRight'],
      at: [
        route('POST', '/instances/:id/resubmit', 'await requireResubmitRight(deps, ctx, id, input.fields)'),
        { role: 'impl', unit: `${ACCESS}#requireResubmitRight`, anchor: "if (instance.businessType === 'idp') {" },
      ],
    },
  ],
  'POST /api/tenant/approval/instances/:id/urge': [
    initiator(
      fn(
        'registerInstanceRoutes',
        'const result = await command(c, deps, ctx, { id }, (tx, context) => act(tx, context, id))',
      ),
    ),
  ],
  'POST /api/tenant/approval/instances/:id/withdraw': [
    initiator(
      fn(
        'registerInstanceRoutes',
        'const result = await command(c, deps, ctx, { id }, (tx, context) => act(tx, context, id))',
      ),
      ['relation:initiator（withdraw / resubmit right）'],
    ),
    {
      perm: 'guard:approval.withdrawRight',
      facts: ['guard:approval.withdrawRight'],
      at: [
        fn('registerInstanceRoutes', "if (path === 'withdraw') await requireWithdrawRight(deps, ctx, id)"),
        {
          role: 'impl',
          unit: `${ACCESS}#requireWithdrawRight`,
          anchor: "throw approvalError('FORBIDDEN', 'APPROVAL_SCOPE_DENIED', '该申请已不在您的数据范围内')",
        },
      ],
    },
  ],
  'POST /api/tenant/approval/instances/:id/admin-transfer': [adminAction('adminTransfer')],
  'POST /api/tenant/approval/instances/:id/admin-intervene': [adminAction('adminIntervene')],
};
