/**
 * 必需项表：个人发展计划（modules/idp/routes.ts、plan-routes.ts、key-info-routes.ts 与各服务）。对象操作经
 * access.idpContext → module-route-access.objectContext；写入口 idpWriteContext 叠加按钮；命令事务内的嵌套写权
 * （requireNestedWrite：级联删除、子流程增删改、复制继承）与源对象查看门禁（objectFields / requireViewable）逐个绑判定处。
 * 计划：HR（计划查看权 + 员工在范围内）或参与人（requireViewer）；执行写入要求当前阶段在办待办人 + 节点按钮
 * （requireExecutor，HR 范围在其内部用作“看得到计划”的一支）。
 * 展示器里按对象查看权省略的嵌套内容（子流程、模板模块 / 通用目标、计划内目标 / 任务 / 回顾等，projectionOf）现状由
 * 投影器 idp.* 统一登记，本表不逐个列为披露义务（转 PR-B，见 PR 描述第 5 轮止损转入项）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/idp';
const I = 'apps/api/src/modules/idp';
const ROUTES = `${I}/routes.ts`;
const PLANS = `${I}/plan-routes.ts`;
const KEY_INFO = `${I}/key-info-routes.ts`;
const ACCESS = `${I}/access.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const CATALOG = 'packages/domain/src/idp/catalog.ts';

type Key =
  | 'process'
  | 'subProcess'
  | 'template'
  | 'templateModule'
  | 'commonGoal'
  | 'plan'
  | 'goal'
  | 'task'
  | 'goalReview'
  | 'analysis'
  | 'review'
  | 'tutorship'
  | 'career'
  | 'workShift';
type Operation = 'view' | 'create' | 'update' | 'delete';
const NAMES: Readonly<Record<Key, string>> = {
  process: 'IDPProcess',
  subProcess: 'SubProcess',
  template: 'IDPTemplate',
  templateModule: 'IDPTemplateModule',
  commonGoal: 'IDPTemplateCommonGoal',
  plan: 'Idp',
  goal: 'IdpGoal',
  task: 'Task',
  goalReview: 'GoalReview',
  analysis: 'Analysis',
  review: 'Review',
  tutorship: 'TutorShip',
  career: 'Career',
  workShift: 'WorkShift',
};
const code = (key: Key) => `IDP.${NAMES[key]}`;
const call = (unit: string, anchor: string): Evidence => ({ role: 'call', unit, anchor });
const objectConst = (key: Key): Evidence => ({
  role: 'const',
  unit: `${CATALOG}#IDP_OBJECTS>${key}`,
  anchor: `object( '${NAMES[key]}'`,
});
const CONTEXT: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#idpContext`,
    anchor: 'return objectContext(c, deps, codeOf(object), operation, expectedRevision)',
  },
  {
    role: 'impl',
    unit: `${MRA}#objectContext`,
    anchor:
      'await requirePermission(deps.authorize, { ...ctx, action: ' +
      '`object.${operation}`, resource: objectCode, fields: [] })',
  },
];
const BUTTON: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#idpWriteContext`,
    anchor: 'await button(deps, ctx, codeOf(object), buttonCode, level)',
  },
  {
    role: 'impl',
    unit: `${MRA}#button`,
    anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
  },
];
/** routes.ts 的 writeContext：按钮层级按按钮名（create → list，其余 detail）。 */
const WRITE_CONTEXT: Evidence = {
  role: 'impl',
  unit: `${ROUTES}#writeContext`,
  anchor:
    "idpWriteContext(c, deps, object, operation, buttonCode, buttonCode === 'create' ? 'list' : 'detail', revision(c))",
};
const NESTED_WRITE: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#requireNestedWrite`,
    anchor: 'await requireWrite(authorizeInTransaction(deps.authorize, tx), ctx, check)',
  },
  {
    role: 'impl',
    unit: `${ACCESS}#requireWrite`,
    anchor:
      'await requirePermission(authorize, { ...ctx, action: `object.${operation}`, resource: codeOf(object), fields })',
  },
];
const OBJECT_FIELDS: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#objectFields`,
  anchor:
    "if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: objectCode, fields: [] }))) return null",
};

function op(
  key: Key,
  operation: Operation,
  entry: Evidence,
  facts: readonly string[],
  more: Evidence[] = [],
): Obligation {
  return { perm: `obj:${code(key)}:${operation}`, facts, at: [entry, ...more, ...CONTEXT, objectConst(key)] };
}
function btn(key: Key, button: string, level: 'list' | 'detail', entry: Evidence, more: Evidence[] = []): Obligation {
  return { perm: `btn:${code(key)}#${button}@${level}`, facts: ['button:button()'], at: [entry, ...more, ...BUTTON] };
}
const guard = (name: string, at: readonly Evidence[], extra: Partial<Obligation> = {}): Obligation => ({
  perm: `guard:${name}`,
  at,
  ...extra,
});

// ---- 配置：流程 / 模板 -------------------------------------------------------------------------------------------
const route = (method: string, path: string, anchor: string, file = ROUTES) =>
  call(`${file}#route:${method} ${BASE}${path}`, anchor);
const PUBLIC_DOWN_IMPL: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#requireEditable`,
  anchor: "reason: 'IDP_PUBLIC_DOWN_READONLY'",
};
const publicDown = (key: 'process' | 'template'): Obligation =>
  guard('idp.publicDownReadonly', [
    call(
      `${I}/${key}-service.ts#lock${key === 'process' ? 'Process' : 'Template'}`,
      `await requireEditable(tx, ctx, ctx.scope, '${key}', row)`,
    ),
    PUBLIC_DOWN_IMPL,
  ]);
const creatable = (key: 'process' | 'template', fn: string): Obligation =>
  guard(`idp.currentEditable(${key})`, [
    call(`${I}/${key}-service.ts#${fn}`, `requireCreatable(ctx.scope, '${key}', input.orgId)`),
    {
      role: 'impl',
      unit: `${ACCESS}#requireCreatable`,
      anchor: 'visible(scope, orgId, `${IDP_LABELS[object]}不存在`)',
    },
  ]);
const PROCESS_SCOPE_FOR: Evidence = {
  role: 'impl',
  unit: `${ROUTES}#processScopeFor`,
  anchor: "if (!canView) throw new AppError('FORBIDDEN', '无权查看发展计划流程')",
};
/** 模板引用的流程：流程查看权（守卫内部）+ 流程范围。 */
function processReference(entry: Evidence): Obligation[] {
  return [
    guard('idp.processReference', [entry, PROCESS_SCOPE_FOR], { facts: ['guard:idp.processReference'] }),
    {
      perm: `obj:${code('process')}:view`,
      purpose: 'guard:idp.processReference',
      facts: [`objectOp:${code('process')}:view`],
      at: [entry, PROCESS_SCOPE_FOR, objectConst('process')],
    },
  ];
}
const SUB_WRITES = 'idp.subProcessWrites';
const PROCESS_SERVICE = `${I}/process-service.ts`;
const nestedWhen = (
  key: Key,
  operation: Operation,
  carrier: string,
  calls: readonly Evidence[],
  note: string,
): Obligation => ({
  perm: `obj:${code(key)}:${operation}`,
  purpose: `when:${carrier}`,
  note,
  at: [...calls, ...(operation === 'view' ? [OBJECT_FIELDS] : NESTED_WRITE), objectConst(key)],
});
const CREATE_SUB = call(
  `${PROCESS_SERVICE}#createProcess`,
  "await requireNestedWrite(tx, deps, ctx, 'subProcess', 'create', fieldsOf(sub))",
);
const CHANGES = `${PROCESS_SERVICE}#checkSubProcessChanges`;
const INPUT_VISIBLE = `${ROUTES}#requireSubProcessInputVisible`;

const read = (key: 'process' | 'template', path: string, anchor: string): Obligation[] => [
  op(key, 'view', route('GET', path, anchor), [
    'object:object.* 动作',
    'object:objectContext',
    `objectOp:${code(key)}:view`,
  ]),
];
/** 写入口的数据操作 + 按钮（writeContext / idpWriteContext）。 */
function write(
  key: Key,
  operation: Exclude<Operation, 'view'>,
  button: string,
  level: 'list' | 'detail',
  entry: Evidence,
  facts: readonly string[],
): Obligation[] {
  return [op(key, operation, entry, facts, [WRITE_CONTEXT]), btn(key, button, level, entry, [WRITE_CONTEXT])];
}
const WRITE_FACTS = ['object:object.* 动作', 'object:objectContext'];

const PROCESSES: RequiredTable = {
  [`GET ${BASE}/processes`]: read('process', '/processes', "const ctx = await idpContext(c, deps, 'process')"),
  [`GET ${BASE}/processes/:id`]: read('process', '/processes/:id', "const ctx = await idpContext(c, deps, 'process')"),
  [`POST ${BASE}/processes`]: [
    ...write(
      'process',
      'create',
      'create',
      'list',
      route('POST', '/processes', "const ctx = await writeContext(c, deps, 'process', 'create', 'create')"),
      WRITE_FACTS,
    ),
    creatable('process', 'createProcess'),
    guard(SUB_WRITES, [CREATE_SUB], { note: '提交了子流程才判（逐个子流程的新建权与字段）' }),
    nestedWhen('subProcess', 'create', SUB_WRITES, [CREATE_SUB], '新建流程时逐个子流程判新建权'),
  ],
  [`PATCH ${BASE}/processes/:id`]: (() => {
    const entry = route(
      'PATCH',
      '/processes/:id',
      "const ctx = await writeContext(c, deps, 'process', 'update', 'update')",
    );
    const visible = call(
      INPUT_VISIBLE,
      "throw new AppError('FORBIDDEN', '看不到提交的子流程字段', { reason: 'IDP_SUB_PROCESS_FIELDS_HIDDEN' })",
    );
    const submitted = {
      ...entry,
      anchor: 'if (body.subProcesses) await requireSubProcessInputVisible(deps, ctx, body.subProcesses)',
    };
    return [
      ...write('process', 'update', 'update', 'detail', entry, WRITE_FACTS),
      publicDown('process'),
      guard(
        SUB_WRITES,
        [
          submitted,
          visible,
          call(CHANGES, "await requireNestedWrite(tx, deps, ctx, 'process', 'update', { subProcesses: next })"),
        ],
        {
          note: '提交了子流程才判：子流程字段可见 + 按实际变化逐段的子流程增删改权（DEC-309④-2）',
        },
      ),
      nestedWhen(
        'subProcess',
        'view',
        SUB_WRITES,
        [submitted, call(INPUT_VISIBLE, "!viewable(await projectionOf(deps, ctx, 'subProcess'), fields)")],
        '提交的子流程字段须可见',
      ),
      nestedWhen(
        'subProcess',
        'create',
        SUB_WRITES,
        [call(CHANGES, "await requireNestedWrite(tx, deps, ctx, 'subProcess', 'create', fieldsOf(item.input))")],
        '新加子流程',
      ),
      nestedWhen(
        'subProcess',
        'update',
        SUB_WRITES,
        [call(CHANGES, "await requireNestedWrite(tx, deps, ctx, 'subProcess', 'update', change.changed)")],
        '改子流程或重排',
      ),
      nestedWhen(
        'subProcess',
        'delete',
        SUB_WRITES,
        [call(CHANGES, "if (plan.removed.length) await requireNestedWrite(tx, deps, ctx, 'subProcess', 'delete')")],
        '移除子流程',
      ),
    ];
  })(),
  [`DELETE ${BASE}/processes/:id`]: (() => {
    const entry = route(
      'DELETE',
      '/processes/:id',
      "const ctx = await writeContext(c, deps, 'process', 'delete', 'delete')",
    );
    return [
      ...write('process', 'delete', 'delete', 'detail', entry, ['object:objectContext', 'object:object.* 动作']),
      publicDown('process'),
      {
        perm: `obj:${code('subProcess')}:delete`,
        note: '级联删除子流程：不论子流程是否存在都要求（DEC-309④-2，缺权整次 403）',
        at: [
          call(`${PROCESS_SERVICE}#deleteProcess`, "await requireNestedWrite(tx, deps, ctx, 'subProcess', 'delete')"),
          ...NESTED_WRITE,
          objectConst('subProcess'),
        ],
      },
    ];
  })(),
  [`GET ${BASE}/approval-processes`]: (() => {
    const entry = route('GET', '/approval-processes', "const ctx = await idpContext(c, deps, 'process')");
    const can = { ...entry, anchor: "if (!(await can('object.create')) && !(await can('object.update'))) {" };
    return [
      op('process', 'view', entry, ['object:objectContext', `objectOp:${code('process')}:view`]),
      {
        perm: `obj:${code('process')}:create`,
        or: 'configure:create',
        facts: ['object:object.* 动作'],
        at: [can, objectConst('process')],
      },
      { perm: `obj:${code('process')}:update`, or: 'configure:update', at: [can, objectConst('process')] },
    ];
  })(),
};

const TEMPLATE_SERVICE = `${I}/template-service.ts`;
const COPY_WRITES = 'idp.copyNestedWrites';
const TEMPLATE_ACTIONS = `${ROUTES}#registerTemplateActions`;
const templateWrite = (method: string, path: string, operation: Exclude<Operation, 'view'>) =>
  route(method, path, `const ctx = await writeContext(c, deps, 'template', '${operation}', '${operation}')`);
const TEMPLATES: RequiredTable = {
  [`GET ${BASE}/templates`]: read('template', '/templates', "const ctx = await idpContext(c, deps, 'template')"),
  [`GET ${BASE}/templates/:id`]: read(
    'template',
    '/templates/:id',
    "const ctx = await idpContext(c, deps, 'template')",
  ),
  [`POST ${BASE}/templates`]: (() => {
    const entry = templateWrite('POST', '/templates', 'create');
    return [
      ...write('template', 'create', 'create', 'list', entry, WRITE_FACTS),
      creatable('template', 'createTemplate'),
      ...processReference({ ...entry, anchor: 'const process = await processScopeFor(c, deps, ctx)' }),
    ];
  })(),
  [`PATCH ${BASE}/templates/:id`]: (() => {
    const entry = templateWrite('PATCH', '/templates/:id', 'update');
    return [
      ...write('template', 'update', 'update', 'detail', entry, WRITE_FACTS),
      publicDown('template'),
      ...processReference({
        ...entry,
        anchor: 'const process = body.processId ? await processScopeFor(c, deps, ctx) : undefined',
      }),
    ];
  })(),
  [`DELETE ${BASE}/templates/:id`]: (() => {
    const entry = templateWrite('DELETE', '/templates/:id', 'delete');
    const cascade = (key: 'templateModule' | 'commonGoal'): Obligation => ({
      perm: `obj:${code(key)}:delete`,
      note: '级联删除：不论是否存在都要求（DEC-309④-2，避免以存在性泄露隐藏内容）',
      at: [
        call(`${TEMPLATE_SERVICE}#deleteTemplate`, `await requireNestedWrite(tx, deps, ctx, '${key}', 'delete')`),
        ...NESTED_WRITE,
        objectConst(key),
      ],
    });
    return [
      ...write('template', 'delete', 'delete', 'detail', entry, ['object:objectContext']),
      publicDown('template'),
      cascade('templateModule'),
      cascade('commonGoal'),
    ];
  })(),
  [`POST ${BASE}/templates/:id/copy`]: (() => {
    const entry = route(
      'POST',
      '/templates/:id/copy',
      "const ctx = await writeContext(c, deps, 'template', 'create', 'copy')",
    );
    const viewable: Evidence = {
      role: 'impl',
      unit: `${ACCESS}#requireViewable`,
      anchor: "throw new AppError('FORBIDDEN', `看不到${IDP_LABELS[object]}的部分内容，不能复制`, {",
    };
    const copyView = (key: 'template' | 'templateModule' | 'commonGoal', anchor: string): Obligation => ({
      perm: `obj:${code(key)}:view`,
      note: '继承内容的查看门禁（requireCopyViewable，看不到整次 403，P2-3）',
      at: [
        { ...entry, anchor: `${key}: await projectionOf(deps, ctx, '${key}')` },
        call(`${TEMPLATE_SERVICE}#requireCopyViewable`, anchor),
        viewable,
        OBJECT_FIELDS,
        objectConst(key),
      ],
    });
    const writable = `${TEMPLATE_SERVICE}#checkCopyWritable`;
    return [
      ...write('template', 'create', 'copy', 'detail', entry, WRITE_FACTS),
      ...processReference({ ...entry, anchor: 'const process = await processScopeFor(c, deps, ctx)' }),
      copyView('template', "requireViewable(ctx, views.template, 'template', templateFields)"),
      copyView(
        'templateModule',
        "requireViewable(ctx, views.templateModule, 'templateModule', [...TEMPLATE_MODULE_FIELDS])",
      ),
      copyView('commonGoal', "requireViewable(ctx, views.commonGoal, 'commonGoal', COMMON_GOAL_COPY_FIELDS)"),
      guard(
        COPY_WRITES,
        [
          call(writable, 'for (const module of copy.modules) {'),
          call(
            `${TEMPLATE_SERVICE}#copyTemplate`,
            'await checkCopyWritable(tx, deps, ctx, { source, modules, nodes, goals })',
          ),
        ],
        {
          note: '只对实际继承的模块 / 通用目标判新建权',
        },
      ),
      nestedWhen(
        'templateModule',
        'create',
        COPY_WRITES,
        [
          call(
            writable,
            "await requireNestedWrite(tx, deps, ctx, 'templateModule', " +
              "'create', Object.fromEntries(fields.map((f) => [f, 1])))",
          ),
        ],
        '源模板有模块时',
      ),
      nestedWhen(
        'commonGoal',
        'create',
        COPY_WRITES,
        [call(writable, "await requireNestedWrite(tx, deps, ctx, 'commonGoal', 'create', fields)")],
        '源模板有通用目标时',
      ),
    ];
  })(),
  ...Object.fromEntries(
    (['publish', 'unpublish'] as const).map((action) => {
      const entry = call(TEMPLATE_ACTIONS, "const ctx = await writeContext(c, deps, 'template', 'update', action)");
      const actions: Evidence = { ...entry, anchor: "['publish', 'published'], ['unpublish', 'draft']" };
      return [
        `POST ${BASE}/templates/:id/${action}`,
        [
          ...write('template', 'update', action, 'detail', entry, ['object:objectContext']).map((o) => ({
            ...o,
            at: [...o.at, actions],
          })),
          publicDown('template'),
        ],
      ];
    }),
  ),
};

// ---- 模板模块 / 通用目标 ----------------------------------------------------------------------------------------
const PART_WRITE: Evidence = {
  role: 'call',
  unit: `${ROUTES}#registerTemplatePartRoutes>write`,
  anchor:
    'const ctx = await idpWriteContext( c, deps, object, operation, ' +
    "operation, operation === 'create' ? 'list' : 'detail', revision(c), )",
};
const PART_FACTS = ['object:idp part write'];
function part(
  key: 'templateModule' | 'commonGoal',
  operation: Exclude<Operation, 'view'>,
  register: string,
): Obligation[] {
  const entry = call(`${ROUTES}#registerTemplatePartRoutes`, register);
  const level = operation === 'create' ? 'list' : 'detail';
  return [
    { perm: `obj:${code(key)}:${operation}`, facts: PART_FACTS, at: [entry, PART_WRITE, ...CONTEXT, objectConst(key)] },
    {
      perm: `btn:${code(key)}#${operation}@${level}`,
      facts: ['button:idp part write'],
      at: [entry, PART_WRITE, ...BUTTON],
    },
    guard('idp.publicDownReadonly', [
      call(`${TEMPLATE_SERVICE}#lockTemplate`, "await requireEditable(tx, ctx, ctx.scope, 'template', row)"),
      PUBLIC_DOWN_IMPL,
    ]),
  ];
}
const GOAL_MODULE = 'idp.goalModuleCascade';
const goalCascade = call(
  `${TEMPLATE_SERVICE}#deleteModule`,
  "if (row.moduleType === 'goal') await requireNestedWrite(tx, deps, ctx, 'commonGoal', 'delete')",
);
const PARTS: RequiredTable = {
  [`POST ${BASE}/templates/:id/modules`]: part(
    'templateModule',
    'create',
    "write('templateModule', 'create', input.moduleCreate",
  ),
  [`PATCH ${BASE}/templates/:id/modules/:partId`]: part(
    'templateModule',
    'update',
    "write('templateModule', 'update', input.modulePatch",
  ),
  [`DELETE ${BASE}/templates/:id/modules/:partId`]: [
    ...part('templateModule', 'delete', "write('templateModule', 'delete', null"),
    guard(GOAL_MODULE, [goalCascade], { note: '删除发展目标模块才连带通用目标' }),
    nestedWhen(
      'commonGoal',
      'delete',
      GOAL_MODULE,
      [goalCascade],
      '模块类型为 goal 时，不论模块下是否有通用目标都要求',
    ),
  ],
  [`POST ${BASE}/templates/:id/common-goals`]: part(
    'commonGoal',
    'create',
    "write('commonGoal', 'create', input.commonGoalCreate",
  ),
  [`PATCH ${BASE}/templates/:id/common-goals/:partId`]: part(
    'commonGoal',
    'update',
    "write('commonGoal', 'update', input.commonGoalPatch",
  ),
  [`DELETE ${BASE}/templates/:id/common-goals/:partId`]: part(
    'commonGoal',
    'delete',
    "write('commonGoal', 'delete', null",
  ),
};

// ---- 计划 ---------------------------------------------------------------------------------------------------------
const planRoute = (method: string, path: string, anchor: string) => route(method, path, anchor, PLANS);
const PLAN = code('plan');
const REQUIRE_VIEWER: Evidence = {
  role: 'impl',
  unit: `${I}/plan-access.ts#requireViewer`,
  anchor: "if (!at.participant) throw new AppError('NOT_FOUND', '发展计划不存在')",
};
const HR_SCOPE: Evidence = {
  role: 'impl',
  unit: `${PLANS}#hrScopeOf`,
  anchor: "const can = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf('plan'), fields: [] })",
};
const PLAN_WRITE = (operation: Exclude<Operation, 'view'>, button: string, level: 'list' | 'detail') =>
  `const ctx = await idpWriteContext(c, deps, 'plan', '${operation}', '${button}', '${level}', revision(c))`;
/** HR 写入口：计划数据操作 + 按钮；返回前按查看人呈现（showPlan → requireViewer）。 */
function planWrite(
  method: string,
  path: string,
  operation: Exclude<Operation, 'view'>,
  button: string,
  level: 'list' | 'detail',
  facts: readonly string[],
): Obligation[] {
  const entry = planRoute(method, path, PLAN_WRITE(operation, button, level));
  // 返回前 showPlan → requireViewer 按 HR 范围复核“看得到计划”（与 stillVisible 同一判定，范围元数据）；响应按计划字段投影
  const viewer = facts.includes(VIEWER_FACT) ? [SHOW_PLAN, REQUIRE_VIEWER] : [];
  return [
    { perm: `obj:${PLAN}:${operation}`, facts, at: [entry, ...viewer, ...CONTEXT, objectConst('plan')] },
    btn('plan', button, level, entry),
  ];
}
const VIEWER_FACT = 'or:idp.requireViewer';
const SHOW_PLAN = call(
  `${PLANS}#showPlan`,
  'const viewer = await requireViewer(tx, ctx, hr, plan, await loadStages(tx, ctx.tenantId, [planId]))',
);
const notOwnPlan: Obligation = guard(
  'idp.notOwnPlan',
  [
    call(`${I}/intervention-service.ts#eachPlan`, 'await notOwnPlan(sp, ctx, plan)'),
    {
      role: 'impl',
      unit: `${I}/intervention-service.ts#notOwnPlan`,
      anchor:
        "throw new AppError('FORBIDDEN', '不能干预本人的发展计划，请由其他管理员处理', { reason: 'IDP_INTERVENE_SELF' })",
    },
  ],
  { note: '逐条回执 403（DEC-092）' },
);

/** 执行写入：执行人关系；HR 范围在 requireExecutor 内部只用作“看得到计划”的一支；响应按查看人呈现。 */
const EXECUTOR_IMPL: Evidence[] = [
  {
    role: 'impl',
    unit: `${I}/plan-access.ts#requireExecutor`,
    anchor: 'if (!at.stage || !at.nodeKey) throw denied()',
  },
  {
    role: 'impl',
    unit: `${I}/plan-access.ts#requireExecutor`,
    anchor: 'if (!buttons.includes(button)) throw denied()',
  },
];
const RUN_EXECUTOR = `${PLANS}#runExecutorWrite`;
function executor(method: string, path: string, anchor: string, viewer = true): Obligation[] {
  const entry = planRoute(method, path, anchor);
  const executorCall = call(
    `${I}/execution-service.ts#executorFor`,
    'const executor = await requireExecutor(tx, ctx, ctx.hr, plan, stages, moduleId, button)',
  );
  const out: Obligation[] = [
    {
      perm: 'rel:idp.executor',
      facts: ['or:idp.requireExecutor', 'relation:idp executor（requireExecutor）'],
      at: [entry, executorCall, ...EXECUTOR_IMPL],
    },
    {
      perm: `obj:${PLAN}:view`,
      purpose: 'guard:idp.executor',
      facts: ['object:object.* 动作'],
      note: 'HR（计划查看权 + 员工在范围内）与参与人同为“看得到计划”；看不到 404',
      at: [
        entry,
        HR_SCOPE,
        executorCall,
        {
          role: 'impl',
          unit: `${I}/plan-access.ts#requireExecutor`,
          anchor:
            "if (!at.participant && !(await hrSees(tx, hr, plan))) throw new AppError('NOT_FOUND', '发展计划不存在')",
        },
      ],
    },
  ];
  if (viewer) {
    out.push({
      perm: `obj:${PLAN}:view`,
      purpose: 'disclosure:responseView',
      facts: [VIEWER_FACT],
      note: '响应按查看人呈现（HR 字段裁剪 / 参与人固定字段）',
      at: [
        call(RUN_EXECUTOR, 'return respondPlan(c, deps, ctx, hr, view.planId, status)'),
        SHOW_PLAN,
        REQUIRE_VIEWER,
        HR_SCOPE,
      ],
    });
  }
  return out;
}
const GOALS = `${PLANS}#registerGoalRoutes`;
const CONTENT = `${PLANS}#registerContentRoutes`;
const EXEC_ENTRY = 'return runExecutorWrite(c, deps,';

const PLAN_ROUTES: RequiredTable = {
  [`GET ${BASE}/plans`]: [
    op('plan', 'view', planRoute('GET', '/plans', "const ctx = await idpContext(c, deps, 'plan')"), [
      'object:object.* 动作',
      'object:objectContext',
      `objectOp:${PLAN}:view`,
    ]),
  ],
  [`GET ${BASE}/my-plans`]: [
    {
      perm: 'own:idp.participant',
      note: '本人 / 指导人的非未开始计划 + 当前有待办的计划（SQL 谓词按当前用户）',
      at: [planRoute('GET', '/my-plans', 'const me = await personOfUser(tx, ctx.tenantId, ctx.userId)')],
    },
  ],
  [`GET ${BASE}/plans/:id`]: [
    {
      perm: `obj:${PLAN}:view`,
      or: 'viewer:hr',
      facts: ['object:object.* 动作', VIEWER_FACT],
      note: 'HR：计划查看权且员工在其 IDP 范围内（hrSees）',
      at: [
        planRoute('GET', '/plans/:id', 'return respondPlan(c, deps, ctx, await hrScopeOf(c, deps, ctx), id, 200)'),
        HR_SCOPE,
        SHOW_PLAN,
        REQUIRE_VIEWER,
      ],
    },
    {
      perm: 'rel:idp.participant',
      or: 'viewer:participant',
      note: '本人 / 指导人（计划非未开始）/ 当前阶段在办待办人',
      at: [
        SHOW_PLAN,
        REQUIRE_VIEWER,
        {
          role: 'impl',
          unit: `${I}/plan-access.ts#participation`,
          anchor: 'return { participant: related || nodeKey !== null, stage: nodeKey ? running! : null, nodeKey }',
        },
      ],
    },
  ],
  [`POST ${BASE}/plans`]: [
    ...planWrite('POST', '/plans', 'create', 'create', 'list', [
      'object:objectContext',
      `objectOp:${PLAN}:create`,
      'object:object.* 动作',
      VIEWER_FACT,
    ]),
    guard(
      'idp.templateVisible',
      [
        planRoute('POST', '/plans', 'const visibleTemplate = await templateCheck(c, deps, ctx)'),
        {
          role: 'impl',
          unit: `${PLANS}#templateCheck`,
          anchor: "if (!can) throw new AppError('FORBIDDEN', '无权查看发展计划模板')",
        },
      ],
      { facts: ['guard:idp.templateVisible'] },
    ),
    {
      perm: `obj:${code('template')}:view`,
      purpose: 'guard:idp.templateVisible',
      facts: [`objectOp:${code('template')}:view`],
      at: [
        call(
          `${PLANS}#templateCheck`,
          'const can = await deps.authorize({ ...ctx, action: ' +
            "'object.view', resource: codeOf('template'), fields: [] })",
        ),
        objectConst('template'),
      ],
    },
  ],
  [`PATCH ${BASE}/plans/:id`]: [
    ...planWrite('PATCH', '/plans/:id', 'update', 'update', 'detail', [
      'object:objectContext',
      `objectOp:${PLAN}:update`,
      'object:object.* 动作',
      VIEWER_FACT,
    ]),
  ],
  [`POST ${BASE}/plans/:id/start`]: [
    ...planWrite('POST', '/plans/:id/start', 'update', 'start', 'detail', [
      'object:objectContext',
      `objectOp:${PLAN}:update`,
      'object:object.* 动作',
      VIEWER_FACT,
    ]),
  ],
  [`DELETE ${BASE}/plans/:id`]: [
    ...planWrite('DELETE', '/plans/:id', 'delete', 'delete', 'detail', [
      'object:objectContext',
      `objectOp:${PLAN}:delete`,
      'object:object.* 动作',
    ]),
    ...(['goal', 'task', 'goalReview', 'analysis', 'review'] as const).map((key): Obligation => ({
      perm: `obj:${code(key)}:delete`,
      note: '级联删除计划的组成对象：各要删除权（DEC-309④-2）',
      at: [
        call(
          `${I}/plan-service.ts#deletePlan`,
          "for (const child of ['goal', 'task', 'goalReview', 'analysis', 'review'] as const) {",
        ),
        call(`${I}/plan-service.ts#deletePlan`, "await requireNestedWrite(tx, deps, ctx, child, 'delete')"),
        ...NESTED_WRITE,
        objectConst(key),
      ],
    })),
  ],
  [`GET ${BASE}/plans/:id/competency-candidates`]: executor(
    'GET',
    '/plans/:id/competency-candidates',
    'const hr = await hrScopeOf(c, deps, ctx)',
    false,
  ),
  ...Object.fromEntries(
    (
      [
        ['POST', '/plans/:id/goals', GOALS],
        ['PATCH', '/plans/:id/goals/:goalId', GOALS],
        ['DELETE', '/plans/:id/goals/:goalId', GOALS],
        ['POST', '/plans/:id/goals/:goalId/tasks', CONTENT],
        ['PATCH', '/plans/:id/goals/:goalId/tasks/:taskId', CONTENT],
        ['DELETE', '/plans/:id/goals/:goalId/tasks/:taskId', CONTENT],
        ['PUT', '/plans/:id/goals/:goalId/review', CONTENT],
        ['PUT', '/plans/:id/modules/:moduleId/content', CONTENT],
      ] as const
    ).map(([method, path, unit]) => [
      `${method} ${BASE}${path}`,
      executor(method, path, EXEC_ENTRY).map((o, i) =>
        i === 0 ? { ...o, at: [call(unit, EXEC_ENTRY), ...o.at.slice(1)] } : o,
      ),
    ]),
  ),
  ...Object.fromEntries(
    (['urge', 'startNext', 'terminate'] as const).map((button) => {
      const path = button === 'startNext' ? 'start-next' : button;
      const entry = call(
        `${PLANS}#registerInterventions`,
        "const ctx = await idpWriteContext(c, deps, 'plan', 'update', buttonCode, 'list', revision(c))",
      );
      const batches: Evidence = {
        role: 'const',
        unit: `${PLANS}#registerInterventions>batches`,
        anchor: `['${path}', '${button}'`,
      };
      return [
        `POST ${BASE}/plans/${path}`,
        [
          {
            perm: `obj:${PLAN}:update`,
            facts: ['object:objectContext', `objectOp:${PLAN}:update`],
            at: [entry, batches, ...CONTEXT, objectConst('plan')],
          },
          btn('plan', button, 'list', entry, [batches]),
          notOwnPlan,
        ],
      ];
    }),
  ),
  [`POST ${BASE}/plans/:id/jump`]: [
    ...planWrite('POST', '/plans/:id/jump', 'update', 'jump', 'detail', [
      'object:objectContext',
      `objectOp:${PLAN}:update`,
      'object:object.* 动作',
      VIEWER_FACT,
    ]),
  ],
  // 转交（F-066）：plan update + transfer@detail；转交目标须是已绑定员工且在操作人 IDP 范围内（不存在 / 未绑定 / 范围外同为 404）
  [`POST ${BASE}/plans/:id/transfer`]: [
    ...planWrite('POST', '/plans/:id/transfer', 'update', 'transfer', 'detail', [
      'object:objectContext',
      `objectOp:${PLAN}:update`,
      'object:object.* 动作',
      VIEWER_FACT,
    ]),
    guard(
      'idp.transferTarget',
      [
        call(
          `${I}/intervention-service.ts#transferPlan`,
          'await requireTargetInScope(tx, ctx, plan, input.toUserId, sources)',
        ),
        {
          role: 'impl',
          unit: `${I}/intervention-service.ts#requireTargetInScope`,
          anchor: "throw new AppError('NOT_FOUND', '转交目标不存在')",
        },
        {
          role: 'impl',
          unit: `${I}/plan-access.ts#employeeInScope`,
          anchor: 'scopeAllowsInTransaction(tx, hr, { personId: employeeId })',
        },
        // DEC-354 / F-068：该计划当前的指导人 / 带教人例外；来源字段看不到视同不是
        {
          role: 'impl',
          unit: `${I}/intervention-service.ts#isPlanMentor`,
          anchor: "viewable(sources.plan, ['tutorEmployeeId']) && plan.tutorEmployeeId === employeeId",
        },
        {
          role: 'impl',
          unit: `${I}/intervention-service.ts#isPlanMentor`,
          anchor: 'if (!viewable(sources.tutorship, TUTORSHIP_FIELDS)) return false',
        },
      ],
      { facts: ['guard:idp.transferTarget'] },
    ),
  ],
  [`POST ${BASE}/plans/tasks/issue`]: (() => {
    const entry = planRoute(
      'POST',
      '/plans/tasks/issue',
      "const ctx = await idpWriteContext(c, deps, 'task', 'create', 'issue', 'list', revision(c))",
    );
    const sources = `${I}/intervention-service.ts`;
    const source = (key: 'template' | 'templateModule' | 'commonGoal' | 'goal'): Obligation => ({
      perm: `obj:${code(key)}:view`,
      note: '统一下发用到的源对象（ISSUE_SOURCE_FIELDS）：看不到与“通用目标不存在”同一个 404',
      at: [
        { ...entry, anchor: `${key}: await projectionOf(deps, ctx, '${key}')` },
        call(`${sources}#issueTasks`, 'if (!viewable(sources[object], fields)) throw hiddenGoal()'),
        { role: 'const', unit: `${sources}#ISSUE_SOURCE_FIELDS`, anchor: `['${key}',` },
        OBJECT_FIELDS,
        objectConst(key),
      ],
    });
    return [
      {
        perm: `obj:${code('task')}:create`,
        facts: ['object:objectContext', `objectOp:${code('task')}:create`],
        at: [entry, ...CONTEXT, objectConst('task')],
      },
      btn('task', 'issue', 'list', entry),
      {
        perm: `obj:${PLAN}:view`,
        facts: [`objectOp:${PLAN}:view`, 'object:object.* 动作'],
        at: [
          { ...entry, anchor: "if (!canView) throw new AppError('FORBIDDEN', '无权查看发展计划')" },
          objectConst('plan'),
        ],
      },
      source('template'),
      source('templateModule'),
      source('commonGoal'),
      source('goal'),
    ];
  })(),
};

// ---- 关键信息：带教 / 职业发展 / 轮岗 -----------------------------------------------------------------------------
const KEY_INFO_ROUTES = `${KEY_INFO}#ROUTES`;
function keyInfo(key: 'tutorship' | 'career' | 'workShift', segment: string): RequiredTable {
  const path = `${BASE}/${segment}`;
  const routes: Evidence = { role: 'const', unit: KEY_INFO_ROUTES, anchor: `{ path: '${segment}', kind: '${key}'` };
  const reads = call(`${KEY_INFO}#registerReads`, 'const ctx = await idpContext(c, deps, kind)');
  const writes = (operation: Exclude<Operation, 'view'>) =>
    call(
      `${KEY_INFO}#registerWrites`,
      `const ctx = await idpWriteContext(c, deps, kind, '${operation}', ` +
        `'${operation}', '${operation === 'create' ? 'list' : 'detail'}', revision(c))`,
    );
  const view = (): Obligation[] => [
    {
      perm: `obj:${code(key)}:view`,
      facts: ['object:object.* 动作', 'object:objectContext'],
      at: [reads, routes, ...CONTEXT, objectConst(key)],
    },
  ];
  const change = (operation: Exclude<Operation, 'view'>): Obligation[] => {
    const level = operation === 'create' ? 'list' : 'detail';
    return [
      {
        perm: `obj:${code(key)}:${operation}`,
        facts: ['object:object.* 动作', 'object:objectContext'],
        at: [writes(operation), routes, ...CONTEXT, objectConst(key)],
      },
      btn(key, operation, level, writes(operation), [routes]),
    ];
  };
  return {
    [`GET ${path}`]: view(),
    [`GET ${path}/:id`]: view(),
    [`POST ${path}`]: change('create'),
    [`PATCH ${path}/:id`]: change('update'),
    [`DELETE ${path}/:id`]: change('delete'),
  };
}

export const IDP: RequiredTable = {
  ...PROCESSES,
  ...TEMPLATES,
  ...PARTS,
  ...PLAN_ROUTES,
  ...keyInfo('tutorship', 'tutorships'),
  ...keyInfo('career', 'careers'),
  ...keyInfo('workShift', 'work-shifts'),
};
