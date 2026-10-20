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
const REPLAY = `${SRC}/employment/replay-guard.ts`;
const TRF = `${SRC}/transfer/routes.ts`;
const MGR = `${SRC}/transfer/manager-routes.ts`;
const LNK = `${SRC}/transfer/linkage/routes.ts`;
const EXIT = `${SRC}/employment/exit-routes.ts`;
const RETIRE = `${SRC}/employment/retirement-routes.ts`;
const RETIRE_VIEWS = `${SRC}/employment/retirement-view-routes.ts`;
const ENTRY = `${SRC}/employment/entry-routes.ts`;
const EMAIL = `${SRC}/employment/entry-email-routes.ts`;
const INTERN = `${SRC}/employment/intern-routes.ts`;
const PART_TIME = `${SRC}/employment/part-time/routes.ts`;
const PART_TIME_GUARD = `${SRC}/employment/part-time/replay-guard.ts`;
const PART_TIME_REQUEST = `${SRC}/employment/part-time/request-routes.ts`;
const PART_TIME_REQUEST_SERVICE = `${SRC}/employment/part-time/request-service.ts`;
const PART_TIME_VALIDATION = `${SRC}/employment/part-time/validation.ts`;
const PROBATION = `${SRC}/employment/probation-routes.ts`;
const REGULARIZATION = `${SRC}/employment/regularization.ts`;
// readContext 带 resource 时先按人员范围判（转正逐人在保存点内同一函数判）
const EMPLOYEE_IN_SCOPE: Evidence = {
  role: 'impl',
  unit: `${CTX}#requireEmployeeInScope`,
  anchor: "throw new AppError('NOT_FOUND', '任职数据不存在')",
};
const BL = `${SRC}/employment/blacklist-routes.ts`;
const AUTO_REG = `${SRC}/employment/auto-regularization-routes.ts`;
const AUTO_ASSESS = `${SRC}/employment/auto-assessment-routes.ts`;
const RETIREMENT_RULE = `${SRC}/employment/retirement-rule-routes.ts`;
const STATUS = `${SRC}/employment/employee-status.ts`;
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
// 入口的 authorizeBusinessWrite 只把判定委托给 replay-guard.ts 的 requireBusinessWriteScope（F-195：命令事务内共用同一份）
const BUSINESS_WRITE_ENTRY: Evidence = {
  role: 'impl',
  unit: `${EMP}#authorizeBusinessWrite`,
  anchor: '(tx) => requireBusinessWriteScope(tx, deps.authorize, ctx, id, employeeId)',
};
const BUSINESS_WRITE: Evidence = {
  role: 'impl',
  unit: `${REPLAY}#requireBusinessWriteScope`,
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
/**
 * 立即执行回执的人员披露（BE-15a 第 4 轮审查 P2）：可选分支 receiptDisclosure，不参与准入（配置准入见 run 条目）。
 * 回执内容受任职记录查看权控制：visibleEmployees 先判 object.view（承接这一探测事实），再按数据范围逐人过滤；
 * 首次返回与同键重放都经 runWrite 的投影出口 visibleRunReceipt。
 */
const runReceiptDisclosure = (file: string, path: string): Obligation => ({
  perm: `obj:${RECORD}:view`,
  purpose: 'disclosure:receiptDisclosure',
  need: list('employment.runReceipt'),
  facts: ['object:object.* 动作'],
  at: [
    at(
      file,
      'POST',
      path,
      '{ guard: ruleGuard(deps, ctx, {}), project: (body) => visibleRunReceipt(deps, ctx, body) }',
    ),
    fn(
      AUTO_REG,
      'visibleEmployees',
      "if (!(await deps.authorize({ ...tenant, action: 'object.view', resource: EMPLOYMENT_OBJECT }))) " +
        'return visible;',
    ),
    RECORD_CONST,
    ...SCOPE_AT['employment.runReceipt'],
  ],
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
  ob(
    'guard:employment.businessWrite',
    ['guard:employment.businessWrite'],
    [call, BUSINESS_WRITE_ENTRY, BUSINESS_WRITE],
  );
const directOperation = (call: Evidence) => ob('guard:employment.directOperation', [], [call, DIRECT_OPERATION]);
const TRANSITIONS = fn(
  EMP,
  'registerBusinessTransitions',
  "let ctx = await readContext(c, deps, action === 'delete' ? 'object.delete' : 'object.update', revision(c))",
);

/** R2 BE-2a 待入职动作（entry-routes.ts）：办理入职 / 取消 / 改期共用 prepareEntryAction，只读上下文与按钮在那里。 */
const PENDING_LOCK = fn(
  STATUS,
  'lockPendingEntry',
  'await requireScopedEmploymentObject(tx, ctx, record.employeeId, record.fields.departmentId, record.id)',
);
function entryUpdate(path: string, linkageCall?: Evidence, method = 'POST'): Obligation[] {
  const prepare = (anchor: string) => fn(ENTRY, 'prepareEntryAction', anchor);
  return [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [prepare("const ctx = await readContext(c, deps, 'object.update', revision(c))"), READ, WRITE_OBJECT],
      `${method} ${path}`,
    ),
    ob(
      `btn:${RECORD}#Employment.Edit@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [prepare("await requireEmploymentWrite(ctx, 'update', payload, 'Employment.Edit', undefined, {"), WRITE_BUTTON],
    ),
    businessWrite(prepare('await authorizeBusinessWrite(deps, ctx, id)')),
    directOperation(PENDING_LOCK),
    ...(linkageCall ? [linkage(linkageCall)] : []),
  ];
}

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
      fn(EMP, 'registerBusinessTransitions', 'const business = await transitionEmployment(tx, checked, {'),
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

// ---- R2-T03 B2b 离职办理入口（exit-routes.ts）：按钮 / 范围 / 字段在入口与命令内（exitCommandGuard）各判一次 -------------
const EXIT_PERMISSION: Evidence = {
  role: 'impl',
  unit: `${SRC}/employment/exit-gate.ts#requireExitPermission`,
  anchor: 'await requireEmploymentWrite(ctx, spec.op, spec.payload, button, undefined, options)',
};
const EXIT_GUARD = fn(REPLAY, 'exitCommandGuard', 'await requireExitPermission(scoped, operation, target)');
const exitCall = (name: string, anchor: string) => fn(EXIT, name, anchor);
function exitPreview(button: string, file = EXIT, path = '/exits/employees/:id/preview', pass = ''): Obligation[] {
  const group = `exitPreview:${button}`;
  const call = at(file, 'POST', path, "const ctx = await readContext(c, deps, 'object.view', 0, id)");
  return [
    {
      ...ob(
        `obj:${RECORD}:view`,
        ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:view', 'object:object.* 动作'],
        [call, READ, RECORD_CONST],
      ),
      or: group,
    },
    {
      ...ob(
        `btn:${RECORD}#${button}@detail`,
        ['button:object.button', 'button:buttonResource'],
        [
          at(file, 'POST', path, `await requirePreviewButton(deps, ctx${pass})`),
          exitCall('requirePreviewButton', "resource: buttonResource(EMPLOYMENT_OBJECT, code, 'detail')"),
        ],
      ),
      or: group,
    },
  ];
}

// ---- R2 BE-7 PT-3b 兼职新增预览 / 直接新增 / 员工页签 / 详情（part-time/routes.ts）-------------------------------------------
const PT_PREVIEW = '/employees/:id/part-times/preview';
function partTimePreview(button: string): Obligation[] {
  const group = `partTimePreview:${button}`;
  return [
    {
      ...ob(
        `obj:${RECORD}:create`,
        ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:create', 'object:object.* 动作'],
        [
          at(PART_TIME, 'POST', PT_PREVIEW, "const ctx = await readContext(c, deps, 'object.create', 0, id)"),
          at(PART_TIME, 'POST', PT_PREVIEW, "await requireEmploymentWrite(ctx, 'create', writeBusiness(body))"),
          READ,
          WRITE_OBJECT,
        ],
      ),
      or: group,
    },
    {
      ...ob(
        `btn:${RECORD}#${button}@detail`,
        ['button:object.button', 'button:buttonResource'],
        [
          at(PART_TIME, 'POST', PT_PREVIEW, 'await requirePartTimePreviewButton(deps, ctx)'),
          fn(
            PART_TIME_GUARD,
            'requirePartTimePreviewButton',
            "resource: buttonResource(EMPLOYMENT_OBJECT, code, 'detail')",
          ),
        ],
      ),
      or: group,
    },
  ];
}
// ---- R2 BE-7 PT-3c 兼职编辑 / 批量结束（part-time/routes.ts）------------------------------------------------------------
// 入口与命令内共用 requirePartTimeWriteAccess（replay-guard.ts）：目标存在 → 兼职部门写入口径范围（requireScopedEmploymentObject）→
// requireEmploymentWrite（对象更新权 + 字段写权 + 按钮）
function partTimeWrite(method: string, path: string, readCall: string, button: string, level = 'detail'): Obligation[] {
  const route = (anchor: string) => at(PART_TIME, method, path, anchor);
  const access = route('await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeWriteAccess(tx, ctx, target))');
  return [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        route(readCall),
        READ,
        fn(
          PART_TIME_GUARD,
          'requirePartTimeWriteAccess',
          "await requireEmploymentWrite(scoped, 'update', target.business, target.button)",
        ),
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#${button}@${level}`,
      [],
      [
        access,
        fn(
          PART_TIME_GUARD,
          'requirePartTimeWriteAccess',
          "await requireEmploymentWrite(scoped, 'update', target.business, target.button)",
        ),
        WRITE_BUTTON,
      ],
    ),
    directOperation(access),
    // 两个入口都不带 resource（readContext 不判员工范围）；范围守卫落在真实执行链：
    // requirePartTimeWriteAccess → requirePartTimeRecordScope → requireScopedEmploymentObject（F-235①）
    ob(
      'guard:employment.scope',
      [],
      [
        access,
        fn(
          PART_TIME_GUARD,
          'requirePartTimeWriteAccess',
          'await requirePartTimeRecordScope(tx, scoped, row, row.departmentId)',
        ),
        fn(
          PART_TIME_VALIDATION,
          'requirePartTimeRecordScope',
          'await requireScopedEmploymentObject(tx, { ...ctx, userId }, record.employeeId, departmentId)',
        ),
        DIRECT_OPERATION,
      ],
    ),
  ];
}

// ---- R2 BE-7 PT-4b 兼职新增申请入口（part-time/request-routes.ts；判定与命令内复核在 replay-guard.ts，写入口径范围在 request-service.ts）----
// 入口与命令内共用 requirePartTimeCreateAccess（新建）/ requirePartTimeRequestAccess（改 / 动作 / 删除）：范围（员工主职 + 申请部门）→
// requireWriteButtons（对象权 + 字段写权 + 第 1 个按钮，其余按钮只判按钮）
const ACCESS_CHAIN = (access: string): Evidence[] => [
  fn(PART_TIME_GUARD, access, 'await requireWriteButtons('),
  fn(
    PART_TIME_GUARD,
    'requireWriteButtons',
    'await requireEmploymentWrite(scoped, operation, business, first, undefined, {',
  ),
  fn(
    PART_TIME_GUARD,
    'requireWriteButtons',
    'await requireEmploymentWrite(scoped, operation, {}, button, undefined, {',
  ),
];
function partTimeRequestWrite(
  method: string,
  path: string,
  readCall: string,
  operation: 'create' | 'update' | 'delete',
  buttons: readonly string[],
): Obligation[] {
  const create = path === '/part-time-requests' && method === 'POST';
  const accessFn = create ? 'requirePartTimeCreateAccess' : 'requirePartTimeRequestAccess';
  const access = at(
    PART_TIME_REQUEST,
    method,
    path,
    `await withTenant(deps.db, ctx.tenantId, (tx) => ${accessFn}(tx, ctx, target))`,
  );
  const chain = ACCESS_CHAIN(accessFn);
  const scope = create
    ? [
        fn(PART_TIME_GUARD, 'requirePartTimeCreateAccess', 'await requirePartTimeScope(tx, scoped, target.employeeId'),
        fn(
          PART_TIME_GUARD,
          'requirePartTimeScope',
          'await requireScopedEmploymentObject(tx, ctx, employeeId, departmentId)',
        ),
      ]
    : [
        fn(PART_TIME_GUARD, 'requirePartTimeRequestAccess', 'await requireRequestScope(tx, scoped, request)'),
        fn(
          PART_TIME_REQUEST_SERVICE,
          'requireRequestScope',
          'await requireScopedEmploymentObject( tx, { ...ctx, userId: request.initiatorUserId },',
        ),
      ];
  return [
    ob(
      `obj:${RECORD}:${operation}`,
      ['object:readContext(object.*)', `objectOp:TenantBase.EmploymentRecord:${operation}`, 'object:object.* 动作'],
      [
        at(PART_TIME_REQUEST, method, path, readCall),
        READ,
        access,
        ...chain,
        operation === 'delete' ? WRITE_DELETE : WRITE_OBJECT,
      ],
    ),
    ...buttons.map((button) =>
      ob(`btn:${RECORD}#${button}@detail`, [], [access, ...chain, WRITE_BUTTON, RECORD_CONST]),
    ),
    ob('guard:employment.scope', [], [access, ...scope, DIRECT_OPERATION]),
    directOperation(access),
  ];
}
// ---- R2-T03 B4 撤销离职（exit-routes.ts registerExitCancel / runExitCancel）；R2-T04 5a′ 撤销退休同一套 ----
interface CancelEntry {
  readonly file: string;
  readonly base: '/exits' | '/retirements';
  readonly button: string;
  readonly buttonText: string;
}
const EXIT_CANCEL: CancelEntry = {
  file: EXIT,
  base: '/exits',
  button: 'Employment.DimissionCancel',
  buttonText: "await requireEmploymentWrite(ctx, 'update', {}, EXIT_BUTTONS.cancel, undefined, { commandOnly: true })",
};
const RETIRE_CANCEL: CancelEntry = {
  file: RETIRE,
  base: '/retirements',
  button: 'Employment.RetireCancel',
  buttonText:
    "await requireEmploymentWrite(ctx, 'update', {}, RETIREMENT_BUTTONS.cancel, undefined, { commandOnly: true })",
};
const EXIT_CANCEL_READ = "const ctx = await readContext(c, deps, 'object.update', revision(c))";
function exitCancelEntry(method: string, path: string, entry: CancelEntry = EXIT_CANCEL): Obligation[] {
  const call = (text: string) => at(entry.file, method, path, text);
  return [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [call(EXIT_CANCEL_READ), READ, call(entry.buttonText), WRITE_OBJECT],
    ),
    ob(`btn:${RECORD}#${entry.button}@detail`, [], [call(entry.buttonText), WRITE_BUTTON]),
  ];
}
function exitCancelCommand(entry: CancelEntry = EXIT_CANCEL): Obligation[] {
  const path = `${entry.base}/:id/cancel`;
  const call = (text: string) => at(entry.file, 'POST', path, text);
  const run = fn(EXIT, 'runExitCancel', "guard: exitCommandGuard(deps, ctx, 'cancel'");
  return [
    ...exitCancelEntry('POST', path, entry),
    ob(`btn:${RECORD}#${entry.button}@detail`, [], [run, EXIT_GUARD, EXIT_PERMISSION, WRITE_BUTTON]),
    businessWrite(call('const current = await authorizeBusinessWrite(deps, ctx, id)')),
    linkage(fn(EXIT, 'runExitCancel', 'body: await cancelExit(tx, context, id, input)')),
  ];
}
function exitCancelRestore(entry: CancelEntry = EXIT_CANCEL): Obligation[] {
  const path = `${entry.base}/:id/restore`;
  return [
    ...exitCancelEntry('POST', path, entry),
    businessWrite(at(entry.file, 'POST', path, 'await authorizeBusinessWrite(deps, ctx, id)')),
  ];
}
function exitCancellationPatch(entry: CancelEntry = EXIT_CANCEL): Obligation[] {
  const path = `${entry.base}/cancellations/:id`;
  return [
    ...exitCancelEntry('PATCH', path, entry),
    ob(
      `btn:${RECORD}#${entry.button}@detail`,
      [],
      [
        at(entry.file, 'PATCH', path, "guard: exitCommandGuard(deps, ctx, 'cancel'"),
        EXIT_GUARD,
        EXIT_PERMISSION,
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:employment.exitCancellation',
      [],
      [
        fn(EXIT, 'requireCancellationOwner', 'await requireEmployeeInScope(tx, ctx, found.employeeId)'),
        EMPLOYEE_IN_SCOPE,
      ],
    ),
  ];
}

// PT-4c 兼职申请新建（POST /part-time-requests）：requestType = add 走 requirePartTimeCreateAccess；
// extend / end 走 createDateRequestRoute 的
// requirePartTimeWriteAccess（同编辑兼职：目标兼职与其兼职部门写入口径范围 → 对象更新权 + 字段写权 + 延长 / 结束按钮）
function partTimeRequestCreate(): Obligation[] {
  const add = partTimeRequestWrite(
    'POST',
    '/part-time-requests',
    "const ctx = await readContext(c, deps, 'object.create')",
    'create',
    ['Employment.PartTimeApproval'],
  );
  const [addObject, addButton, ...shared] = add;
  const route = (anchor: string) => fn(PART_TIME_REQUEST, 'createDateRequestRoute', anchor);
  const access = route('await withTenant(deps.db, ctx.tenantId, (tx) => requirePartTimeWriteAccess(tx, ctx, target))');
  const write = fn(
    PART_TIME_GUARD,
    'requirePartTimeWriteAccess',
    "await requireEmploymentWrite(scoped, 'update', target.business, target.button)",
  );
  const buttons = ['Employment.PartTimeApproval', 'Employment.PartTimeEnd', 'Employment.PartTimeExtend'];
  return [
    ob(
      `obj:${RECORD}:{create,update}`,
      [
        'object:readContext(object.*)',
        'objectOp:TenantBase.EmploymentRecord:create',
        'objectOp:TenantBase.EmploymentRecord:update',
        'object:object.* 动作',
      ],
      [
        ...addObject!.at,
        route("const ctx = await readContext(c, deps, 'object.update')"),
        READ,
        access,
        write,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#{${buttons.map((button) => `${button}@detail`).join(',')}}`,
      [],
      [...addButton!.at, access, write, WRITE_BUTTON, RECORD_CONST],
    ),
    ...shared,
  ];
}
const GUARD_ANCHOR = {
  registerExitChanges: '{ guard: exitCommandGuard(deps, ctx,',
  registerRetirementChanges: 'guard: exitCommandGuard(deps, ctx, action, target, { businessId: id })',
} as const;
function exitBusinessCommand(
  path: string,
  anchor: string,
  unit: 'route' | 'registerExitChanges' | 'registerRetirementChanges',
  file = EXIT,
): Obligation[] {
  const call = (text: string) => (unit === 'route' ? at(file, 'PATCH', path, text) : fn(file, unit, text));
  const guard =
    unit === 'route'
      ? fn(REPLAY, 'requireExitEditRights', "await requireExitPermission(ctx, 'update', target)")
      : EXIT_GUARD;
  return [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        call("const ctx = await readContext(c, deps, 'object.update', revision(c))"),
        READ,
        guard,
        EXIT_PERMISSION,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#${anchor}@detail`,
      [],
      [
        call(unit === 'route' ? '{ guard: exitEditGuard(deps, ctx, gate, id) }' : GUARD_ANCHOR[unit]),
        guard,
        EXIT_PERMISSION,
        WRITE_BUTTON,
      ],
    ),
    businessWrite(call('const current = await authorizeBusinessWrite(deps, ctx, id)')),
    ...(unit !== 'route'
      ? [linkage(call('const business = await transitionEmployment(tx, context, { id, action })'))]
      : []),
  ];
}

/** R2 BE-8a 黑名单：入口 readContext 判对象操作，写权限链在命令内 requireBlacklistWrite（#199，guard.before）。 */
const BLACKLIST = 'TenantBase.Blacklist';
const BL_CONST: Evidence = {
  role: 'const',
  unit: `${SRC}/employment/blacklist.ts#BLACKLIST_OBJECT`,
  anchor: 'MODULE_OBJECTS.blacklist.code',
};
const blWrite = (anchor: string): Evidence => fn(BL, 'requireBlacklistWrite', anchor);
const VIEW_FACTS = (operation: string) => [
  'object:readContext(object.*)',
  `objectOp:${BLACKLIST}:${operation}`,
  'object:object.* 动作',
];
const OBJECT_WRITE_FACT = 'object:requireObjectWrite（对象写操作权）';
/** 规则写入的命令内复核 ruleGuard 也调 requireObjectWrite：由配置对象的写操作义务承接该事实。 */
const withObjectWriteFact = (obligations: Obligation[]): Obligation[] =>
  obligations.map((o) => (o.perm.startsWith('obj:') ? { ...o, facts: [...(o.facts ?? []), OBJECT_WRITE_FACT] } : o));
function blacklistRoute(
  method: string,
  path: string,
  operation: 'view' | 'create' | 'update' | 'delete',
  context: string,
  button?: readonly [string, 'list' | 'list_row'],
  employee = false,
): Obligation[] {
  const entry = at(BL, method, path, context);
  const write =
    operation === 'delete'
      ? blWrite("await requirePermission(authorize, { ...ctx, action: 'object.delete', resource: BLACKLIST_OBJECT })")
      : blWrite('await requireObjectWrite(authorize, ctx, {');
  return [
    ob(
      `obj:${BLACKLIST}:${operation}`,
      operation === 'view' ? VIEW_FACTS(operation) : [...VIEW_FACTS(operation), OBJECT_WRITE_FACT],
      operation === 'view' ? [entry, READ, BL_CONST] : [entry, READ, write, BL_CONST],
    ),
    ...(button
      ? [
          ob(
            `btn:${BLACKLIST}#${button[0]}@${button[1]}`,
            ['button:buttonResource', 'button:object.button'],
            [
              blWrite("action: 'object.button', resource: buttonResource(BLACKLIST_OBJECT, write.button, level),"),
              BL_CONST,
            ],
          ),
        ]
      : []),
    ...(employee
      ? [
          ob(
            'guard:employment.blacklistEmployeeScope',
            [],
            [blWrite('await requireEmployeeInScope(tx, { ...ctx, scope: employment }, write.employeeId)')],
          ),
        ]
      : []),
  ];
}

/** R2 BE-15b1 试用期考核：考核对象 TenantBase.ProbationAssessment，写入口复用 readContext / requireEmploymentWrite（带对象编码）。 */
const ASSESSMENT = 'TenantBase.ProbationAssessment';
const ASSESS = `${SRC}/employment/assessment-routes.ts`;
const ASSESS_SERVICE = `${SRC}/employment/assessment.ts`;
const ASSESSMENT_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/employment/assessment.ts#PROBATION_ASSESSMENT_OBJECT',
  anchor: "'TenantBase.ProbationAssessment'",
};
// 单条判定与列表共用同一个人员范围谓词 assessmentScopeSql（员工当前任职，不看创建时的部门快照）
const ASSESSMENT_IN_SCOPE: Evidence = {
  role: 'impl',
  unit: `${SRC}/employment/assessment-store.ts#requireAssessmentInScope`,
  anchor: 'const visible = assessmentScopeSql(ctx.scope, ctx.tenantId)',
};
const ASSESSMENT_SCOPE_SQL: Evidence = {
  role: 'impl',
  unit: `${SRC}/employment/assessment-store.ts#assessmentScopeSql`,
  anchor: 'employmentScopePredicate(scope, sql`a.employee_id`, undefined,',
};
const assessmentView = (call: Evidence) =>
  ob(`obj:${ASSESSMENT}:view`, ['object:readPageContext'], [call, PAGE, READ, ASSESSMENT_CONST]);

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
  // F-181a：他人调动申请暂存的元数据读口与清除（槽位按用户 × 员工，draft-slot.ts）
  'GET /api/tenant/employment/transfers/employees/:id/draft': [
    recordView(
      at(TRF, 'GET', '/transfers/employees/:id/draft', "const ctx = await readPageContext(c, deps, 'detail')"),
    ),
    ob(
      `btn:${RECORD}#Transfer.Hr@detail`,
      ['button:requireTransferButton'],
      [
        at(TRF, 'GET', '/transfers/employees/:id/draft', "await requireTransferSource(tx, ctx, id, 'hr')"),
        ...TRANSFER_BUTTON,
      ],
      '读口与暂存同一发起权限：他人调动入口 Transfer.Hr',
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source'],
      [at(TRF, 'GET', '/transfers/employees/:id/draft', "await requireTransferSource(tx, ctx, id, 'hr')"), ...SOURCE],
    ),
  ],
  'DELETE /api/tenant/employment/transfers/employees/:id/draft/:businessId': [
    ob(
      `obj:${RECORD}:delete`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:delete', 'object:object.* 动作'],
      [
        at(
          TRF,
          'DELETE',
          '/transfers/employees/:id/draft/:businessId',
          "const base = await readContext(c, deps, 'object.delete', revision(c))",
        ),
        READ,
        at(
          TRF,
          'DELETE',
          '/transfers/employees/:id/draft/:businessId',
          "await requireEmploymentWrite(ctx, 'delete', {}, 'Employment.Delete')",
        ),
        WRITE_DELETE,
        RECORD_CONST,
      ],
      '清除走与 DELETE /businesses/:id 同一条删除授权链',
    ),
    ob(
      `btn:${RECORD}#Employment.Delete@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          TRF,
          'DELETE',
          '/transfers/employees/:id/draft/:businessId',
          "await requireEmploymentWrite(ctx, 'delete', {}, 'Employment.Delete')",
        ),
        WRITE_BUTTON,
        RECORD_CONST,
      ],
    ),
    ob(
      'guard:employment.businessWrite',
      ['guard:employment.businessWrite'],
      [
        at(
          TRF,
          'DELETE',
          '/transfers/employees/:id/draft/:businessId',
          'await authorizeBusinessWrite(deps, ctx, businessId, id)',
        ),
        {
          role: 'impl',
          unit: `${TRF}#authorizeBusinessWrite`,
          anchor: '(tx) => requireBusinessWriteScope(tx, deps.authorize, ctx, id, employeeId)',
        },
        BUSINESS_WRITE,
      ],
    ),
    ob(
      'guard:transfer.source',
      ['guard:transfer.source', 'button:requireTransferButton'],
      [
        at(
          TRF,
          'DELETE',
          '/transfers/employees/:id/draft/:businessId',
          "transferBusinessContext(tx, base, businessId, 'before-command')",
        ),
        ...BUSINESS_SOURCE,
      ],
    ),
    linkage(
      at(
        TRF,
        'DELETE',
        '/transfers/employees/:id/draft/:businessId',
        'const deleted = await releaseTransferDraft(tx, checked, id, { businessId, revision: ctx.expectedRevision })',
      ),
      '删暂存单走 transitionEmployment delete 内核，同 DELETE /businesses/:id',
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
      [
        'object:readContext(object.*)',
        'objectOp:TenantBase.EmploymentRecord:create',
        'object:object.* 动作',
        'object:requireObjectWrite（对象写操作权）',
      ],
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
      ['button:requireEmploymentWrite(按钮)', 'button:buttonResource', 'button:object.button'],
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
        'const business = await createEmploymentBusiness(tx, context, id, input, entry ? { entry } : {})',
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
  'GET /api/tenant/employment/pending-entries': [
    recordView(at(ENTRY, 'GET', '/pending-entries', "const ctx = await readPageContext(c, deps, 'list')")),
  ],
  // ---- employment/intern-routes.ts：R2 BE-6a 实习四视图 / 直接实习转正 / 重聘判定 ------------------------------------------
  'GET /api/tenant/employment/interns': [
    recordView(at(INTERN, 'GET', '/interns', "const ctx = await readPageContext(c, deps, 'list')")),
    ob(
      'guard:employment.viewableFilters',
      [],
      [
        at(INTERN, 'GET', '/interns', 'requireViewableInternFilters(filter, await viewableIn(deps, ctx))'),
        fn(INTERN, 'requireViewableInternFilters', "if (hidden) throw new AppError('FORBIDDEN', '筛选字段不可查看')"),
      ],
    ),
  ],
  'POST /api/tenant/employment/interns/:id/regularize': [
    ob(
      `obj:${RECORD}:create`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:create', 'object:object.* 动作'],
      [
        at(
          INTERN,
          'POST',
          '/interns/:id/regularize',
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
          INTERN,
          'POST',
          '/interns/:id/regularize',
          "await requireEmploymentWrite(ctx, 'create', business, 'Employment.Create')",
        ),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        at(INTERN, 'POST', '/interns/:id/regularize', 'requireEmploymentScope(ctx, id, input.departmentId)'),
        EMPLOYMENT_SCOPE,
      ],
    ),
    directOperation(
      at(INTERN, 'POST', '/interns/:id/regularize', 'body: await regularizeIntern(tx, context, id, input)'),
    ),
    linkage(
      at(INTERN, 'POST', '/interns/:id/regularize', 'body: await regularizeIntern(tx, context, id, input)'),
      '直接落地的实习转正把人员状态联动到后续记录前按 DEC-178 复核',
    ),
  ],
  // 结束实习（BE-6b）：权限与直接离职同一组合；范围由 readContext 的人员范围与命令内 exitCommandGuard 的 requireExitScope 判，没有部门参数
  'POST /api/tenant/employment/interns/:id/terminate': [
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
          INTERN,
          'POST',
          '/interns/:id/terminate',
          "const ctx = await readContext(c, deps, 'object.create', revision(c), id)",
        ),
        READ,
        EXIT_GUARD,
        EXIT_PERMISSION,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Dimission@detail`,
      [],
      [
        at(INTERN, 'POST', '/interns/:id/terminate', "{ guard: exitCommandGuard(deps, ctx, 'create', gate, {}) }"),
        EXIT_GUARD,
        EXIT_PERMISSION,
        WRITE_BUTTON,
      ],
      '结束实习沿用直接离职的按钮（原站是否另有独立权限项未验证）',
    ),
    linkage(at(INTERN, 'POST', '/interns/:id/terminate', 'body: await terminateIntern(tx, context, id, input)')),
  ],
  'POST /api/tenant/employment/rehire-matches': [
    ob(
      `obj:${EMPLOYEE}:create`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.Employee:create', 'object:object.* 动作'],
      [
        at(
          INTERN,
          'POST',
          '/rehire-matches',
          "const ctx = await readContext(c, deps, 'object.create', 0, undefined, EMPLOYEE_OBJECT)",
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
          INTERN,
          'POST',
          '/rehire-matches',
          "await requireEmploymentWrite(ctx, 'create', {}, 'Employee.Create', EMPLOYEE_OBJECT, { commandOnly: true })",
        ),
        WRITE_BUTTON,
      ],
    ),
  ],
  // ---- employment/part-time/routes.ts：R2 BE-7 PT-3b 兼职新增与读取入口 -------------------------------------------------------
  'POST /api/tenant/employment/employees/:id/part-times/preview': [
    ...partTimePreview('Employment.PartTime'),
    ...partTimePreview('Employment.PartTimeApproval'),
  ],
  'POST /api/tenant/employment/employees/:id/part-times': [
    ob(
      `obj:${RECORD}:create`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:create', 'object:object.* 动作'],
      [
        at(
          PART_TIME,
          'POST',
          '/employees/:id/part-times',
          "const ctx = await readContext(c, deps, 'object.create', 0, id)",
        ),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.PartTime@detail`,
      [],
      [
        at(
          PART_TIME,
          'POST',
          '/employees/:id/part-times',
          "await requireEmploymentWrite(ctx, 'create', business, PART_TIME_BUTTONS.direct)",
        ),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        at(
          PART_TIME,
          'POST',
          '/employees/:id/part-times',
          "const ctx = await readContext(c, deps, 'object.create', 0, id)",
        ),
        { role: 'impl', unit: `${CTX}#readContext`, anchor: '(tx) => requireEmployeeInScope(tx, result, resource)' },
        EMPLOYEE_IN_SCOPE,
      ],
    ),
    directOperation(
      at(
        PART_TIME,
        'POST',
        '/employees/:id/part-times',
        'const created = await createPartTime(tx, context, serviceInput(id, body))',
      ),
    ),
  ],
  // ---- R2 BE-7 PT-3c 编辑兼职 / 批量结束（part-time/routes.ts；写入口径判定与命令内复核在 replay-guard.ts）-----------------------------
  'PATCH /api/tenant/employment/part-times/:recordId': partTimeWrite(
    'PATCH',
    '/part-times/:recordId',
    "const ctx = await readContext(c, deps, 'object.update', revision(c))",
    'Employment.PartTimeEdit',
  ),
  'POST /api/tenant/employment/part-times/batch-end': partTimeWrite(
    'POST',
    '/part-times/batch-end',
    "const ctx = await readContext(c, deps, 'object.update')",
    'Employment.PartTimeBatchEnd',
    'list',
  ),
  // ---- R2 BE-7 PT-4b 兼职新增申请入口（request-routes.ts）---------------------------------------------------------------------
  // 声明里对象操作与按钮是 requestType 的映射选择器，权限记为取值集合（obj:…:{create,update}、btn:…#{三个按钮}），一条义务各登记
  // add 与 extend / end 两条路径的证据；范围与直接操作守卫两条路径共有
  'POST /api/tenant/employment/part-time-requests': partTimeRequestCreate(),
  'PATCH /api/tenant/employment/part-time-requests/:id': partTimeRequestWrite(
    'PATCH',
    '/part-time-requests/:id',
    "const ctx = await readContext(c, deps, 'object.update', revision(c))",
    'update',
    ['Employment.PartTimeApproval'],
  ),
  'POST /api/tenant/employment/part-time-requests/:id/submit': partTimeRequestWrite(
    'POST',
    '/part-time-requests/:id/submit',
    "const ctx = await readContext(c, deps, 'object.update', revision(c))",
    'update',
    ['Employment.PartTimeApproval', 'Employment.Submit'],
  ),
  'POST /api/tenant/employment/part-time-requests/:id/withdraw': partTimeRequestWrite(
    'POST',
    '/part-time-requests/:id/withdraw',
    "const ctx = await readContext(c, deps, 'object.update', revision(c))",
    'update',
    ['Employment.PartTimeApproval', 'Employment.Withdraw'],
  ),
  'POST /api/tenant/employment/part-time-requests/:id/revoke': partTimeRequestWrite(
    'POST',
    '/part-time-requests/:id/revoke',
    "const ctx = await readContext(c, deps, 'object.update', revision(c))",
    'update',
    ['Employment.Revoke'],
  ),
  'DELETE /api/tenant/employment/part-time-requests/:id': partTimeRequestWrite(
    'DELETE',
    '/part-time-requests/:id',
    "const ctx = await readContext(c, deps, 'object.delete', revision(c))",
    'delete',
    ['Employment.PartTimeApproval', 'Employment.Delete'],
  ),
  'GET /api/tenant/employment/part-time-requests/:id': [
    recordView(
      at(PART_TIME_REQUEST, 'GET', '/part-time-requests/:id', "const ctx = await readPageContext(c, deps, 'detail')"),
    ),
  ],
  // PT-5 兼职六视图：readPageContext(list) + 筛选字段须可见（requireViewableFilters，否则 403）；范围谓词在 queries.ts 分页前过滤
  'GET /api/tenant/employment/part-times': [
    recordView(at(PART_TIME, 'GET', '/part-times', "const ctx = await readPageContext(c, deps, 'list')")),
    ob(
      'guard:employment.viewableFilters',
      [],
      [
        at(PART_TIME, 'GET', '/part-times', 'requireViewableFilters('),
        fn(PART_TIME, 'requireViewableFilters', "throw new AppError('FORBIDDEN', '筛选字段不可查看')"),
      ],
    ),
  ],
  'GET /api/tenant/employment/employees/:id/part-times': [
    recordView(
      at(PART_TIME, 'GET', '/employees/:id/part-times', "const ctx = await readPageContext(c, deps, 'detail')"),
    ),
  ],
  'GET /api/tenant/employment/part-times/:recordId': [
    recordView(at(PART_TIME, 'GET', '/part-times/:recordId', "const ctx = await readPageContext(c, deps, 'detail')")),
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
      ['objectOp:TenantBase.EmploymentRecord:update', 'objectOp:TenantBase.EmploymentRecord:create'],
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
        // F-202 / F-208：编辑行与新建行在命令事务内按当前授权再判一次（同键重放、失败回查也过这道），见 replay-guard.ts
        fn(EMP, 'importEmployment', '{ guard: importWriteGuard(deps, ctx, id, targets, creates) }'),
        {
          role: 'impl',
          unit: `${REPLAY}#requireEditTargets`,
          anchor: "await requireEmploymentWrite(scoped, 'update', target.patch, 'Employment.Edit')",
        },
        {
          role: 'impl',
          unit: `${REPLAY}#importWriteGuard`,
          anchor: "await requireEmploymentWrite(scoped, 'create', create.business, 'Employment.Create')",
        },
      ],
      '逐行：operation = create 判 create，其余判 update；两类行另在命令内复核（importWriteGuard）',
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
  // ---- employment/entry-routes.ts：R2 BE-2a 待入职状态动作（办理入职 / 取消 / 改期 / 删除）-------------------------------
  'POST /api/tenant/employment/pending-entries/:id/complete': [
    ...entryUpdate(
      '/pending-entries/:id/complete',
      at(
        ENTRY,
        'POST',
        '/pending-entries/:id/complete',
        'const record = await completePendingEntry(tx, context, id, probation)',
      ),
    ),
    // 条件准入（带 contract 才挂）：CommandGuard.before 在命令事务内复核合同“新建”按钮（首次 / 重放 / 回查三个出口）
    ob(
      'guard:employment.entryContract',
      [],
      [
        at(
          ENTRY,
          'POST',
          '/pending-entries/:id/complete',
          '{ guard: completeEntryGuard(deps, ctx, id, input.contract) }',
        ),
        fn(ENTRY, 'completeEntryGuard', 'requireEntryContractAccess(tx, deps, ctx, id, contract)'),
      ],
      '条件守卫：请求带 contract 时另要合同新建按钮 / 字段创建权 / 合同数据范围',
    ),
    {
      ...ob(
        'btn:TenantBase.EmploymentContract#create@list',
        ['button:buttonResource', 'button:object.button'],
        [
          fn(ENTRY, 'completeEntryGuard', 'requireEntryContractAccess(tx, deps, ctx, id, contract)'),
          fn(
            `${SRC}/employment/entry-contract.ts`,
            'requireEntryContractAccess',
            "resource: buttonResource(CONTRACT_OBJECT, contractAction('create', 'direct'), 'list')",
          ),
          {
            role: 'const',
            unit: 'packages/domain/src/contracts/rules.ts#CONTRACT_OBJECT',
            anchor: "'TenantBase.EmploymentContract'",
          },
        ],
      ),
      purpose: 'when:employment.entryContract',
    },
  ],
  'POST /api/tenant/employment/pending-entries/:id/generate-email': entryUpdate('/pending-entries/:id/generate-email'),
  // ---- employment/entry-email-routes.ts：R2 BE-2b 入职生成邮箱规则配置（EN-R12）------------------------------------------
  'GET /api/tenant/employment/entry-email-rules': [
    ob(
      'obj:TenantBase.EmploymentSettings:view',
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentSettings:view', 'object:object.* 动作'],
      [
        at(
          EMAIL,
          'GET',
          '/entry-email-rules',
          "const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings')",
        ),
        READ,
      ],
    ),
  ],
  'PUT /api/tenant/employment/entry-email-rules': configWrite(
    at(EMAIL, 'PUT', '/entry-email-rules', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentSettings',
    'update',
    at(
      EMAIL,
      'PUT',
      '/entry-email-rules',
      "await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings')",
    ),
  ),
  'POST /api/tenant/employment/pending-entries/:id/cancel': entryUpdate('/pending-entries/:id/cancel'),
  'POST /api/tenant/employment/pending-entries/:id/postpone': entryUpdate(
    '/pending-entries/:id/postpone',
    at(ENTRY, 'POST', '/pending-entries/:id/postpone', 'body: await postponePendingEntry(tx, context, id, input)'),
  ),
  // F-188 行内编辑：与改期同一套入口（prepareEntryAction）与替换内核（editPendingEntry → 删除重建）
  'PATCH /api/tenant/employment/pending-entries/:id': entryUpdate(
    '/pending-entries/:id',
    at(ENTRY, 'PATCH', '/pending-entries/:id', 'body: await editPendingEntry(tx, context, id, input)'),
    'PATCH',
  ),
  'DELETE /api/tenant/employment/pending-entries/:id': [
    ob(
      `obj:${RECORD}:delete`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:delete', 'object:object.* 动作'],
      [
        at(
          ENTRY,
          'DELETE',
          '/pending-entries/:id',
          "const ctx = await readContext(c, deps, 'object.delete', revision(c))",
        ),
        READ,
        at(
          ENTRY,
          'DELETE',
          '/pending-entries/:id',
          "await requireEmploymentWrite(ctx, 'delete', {}, 'Employment.Delete')",
        ),
        WRITE_DELETE,
        RECORD_CONST,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Delete@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          ENTRY,
          'DELETE',
          '/pending-entries/:id',
          "await requireEmploymentWrite(ctx, 'delete', {}, 'Employment.Delete')",
        ),
        WRITE_BUTTON,
        RECORD_CONST,
      ],
    ),
    businessWrite(at(ENTRY, 'DELETE', '/pending-entries/:id', 'await authorizeBusinessWrite(deps, ctx, id)')),
    directOperation(PENDING_LOCK),
    linkage(at(ENTRY, 'DELETE', '/pending-entries/:id', 'body: await deletePendingEntry(tx, context, id)')),
  ],
  // ---- employment/probation-routes.ts：R2 BE-3 试用期与转正（视图、详情、调整试用信息、转正、试用结果字典）----------------
  'GET /api/tenant/employment/probation-views': [
    recordView(at(PROBATION, 'GET', '/probation-views', "const ctx = await readPageContext(c, deps, 'list')")),
  ],
  'GET /api/tenant/employment/employees/:id/probation': [
    recordView(
      at(PROBATION, 'GET', '/employees/:id/probation', "const ctx = await readPageContext(c, deps, 'detail', id)"),
    ),
  ],
  'PUT /api/tenant/employment/employees/:id/probation': [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        at(
          PROBATION,
          'PUT',
          '/employees/:id/probation',
          "const ctx = await readContext(c, deps, 'object.update', revision(c), id)",
        ),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Edit@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          PROBATION,
          'PUT',
          '/employees/:id/probation',
          "await requireEmploymentWrite(ctx, 'update', {}, 'Employment.Edit', undefined, { commandOnly: true })",
        ),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        at(
          PROBATION,
          'PUT',
          '/employees/:id/probation',
          "const ctx = await readContext(c, deps, 'object.update', revision(c), id)",
        ),
        {
          role: 'impl',
          unit: `${CTX}#readContext`,
          anchor: '(tx) => requireEmployeeInScope(tx, result, resource)',
        },
        EMPLOYEE_IN_SCOPE,
      ],
    ),
    directOperation(
      fn(
        STATUS,
        'switchProbationStatus',
        'await requireScopedEmploymentObject(tx, ctx, record.employeeId, record.fields.departmentId, record.id)',
      ),
    ),
    linkage(at(PROBATION, 'PUT', '/employees/:id/probation', 'await adjustProbation(tx, context, id, adjustment)')),
  ],
  'POST /api/tenant/employment/regularizations': [
    ob(
      `obj:${RECORD}:create`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:create', 'object:object.* 动作'],
      [
        at(PROBATION, 'POST', '/regularizations', "const ctx = await readContext(c, deps, 'object.create')"),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Create@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          PROBATION,
          'POST',
          '/regularizations',
          "await requireEmploymentWrite(ctx, 'create', payload, 'Employment.Create')",
        ),
        WRITE_BUTTON,
      ],
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        fn(REGULARIZATION, 'regularizeOne', 'await requireEmployeeInScope(tx, ctx, item.employeeId)'),
        EMPLOYEE_IN_SCOPE,
      ],
      '逐人在保存点内判定，只让那一人失败（回执 404）',
    ),
    directOperation(
      fn(
        `${SRC}/employment/write-service.ts`,
        'materializeEmploymentRecord',
        'await requireScopedEmploymentObject(tx, ctx, business.employeeId, fields.departmentId)',
      ),
    ),
    linkage(
      at(
        PROBATION,
        'POST',
        '/regularizations',
        'async (tx, context) => ({ status: 200, body: await regularizeEmployees(tx, context, input) })',
      ),
    ),
  ],
  'POST /api/tenant/employment/businesses/:id/regularization-date': [
    ob(
      `obj:${RECORD}:update`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:update', 'object:object.* 动作'],
      [
        at(
          PROBATION,
          'POST',
          '/businesses/:id/regularization-date',
          "const ctx = await readContext(c, deps, 'object.update', revision(c))",
        ),
        READ,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#Employment.Edit@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          PROBATION,
          'POST',
          '/businesses/:id/regularization-date',
          "await requireEmploymentWrite(ctx, 'update', input, 'Employment.Edit')",
        ),
        WRITE_BUTTON,
      ],
    ),
    businessWrite(
      at(PROBATION, 'POST', '/businesses/:id/regularization-date', 'await authorizeBusinessWrite(deps, ctx, id)'),
    ),
    directOperation(
      fn(
        `${SRC}/employment/regularization-reschedule.ts`,
        'rescheduleRegularization',
        'await requireScopedEmploymentObject(',
      ),
    ),
    linkage(
      at(
        PROBATION,
        'POST',
        '/businesses/:id/regularization-date',
        'body: await rescheduleRegularization(tx, context, id, input.effectiveDate)',
      ),
    ),
  ],
  'GET /api/tenant/employment/probation-results': [
    ob(
      `obj:${RECORD}:view`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:view', 'object:object.* 动作'],
      [at(PROBATION, 'GET', '/probation-results', "const ctx = await readContext(c, deps, 'object.view', 0)"), READ],
    ),
  ],
  'POST /api/tenant/employment/probation-results': configWrite(
    at(PROBATION, 'POST', '/probation-results', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentSettings',
    'create',
    at(
      PROBATION,
      'POST',
      '/probation-results',
      "await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings')",
    ),
  ),
  'PUT /api/tenant/employment/probation-results/:id': configWrite(
    at(PROBATION, 'PUT', '/probation-results/:id', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentSettings',
    'update',
    at(
      PROBATION,
      'PUT',
      '/probation-results/:id',
      "await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings')",
    ),
  ),
  // ---- employment/exit-routes.ts：R2-T03 离职三个字典（读：任职记录查看权；写：配置对象，设计 §9.1）----------------
  // ---- R2-T03 B2b 离职办理入口 ----------------------------------------------------------------------------------
  'POST /api/tenant/employment/exits/employees/:id/preview': [
    ...exitPreview('Employment.Dimission'),
    ...exitPreview('Employment.DimissionApproval'),
  ],
  'POST /api/tenant/employment/exits/employees/:id': [
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
          EXIT,
          'POST',
          '/exits/employees/:id',
          "const ctx = await readContext(c, deps, 'object.create', revision(c), id)",
        ),
        READ,
        EXIT_GUARD,
        EXIT_PERMISSION,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#{mapper:employment.exitButton}`,
      ['button:buttonResource', 'button:object.button'],
      [
        at(
          EXIT,
          'POST',
          '/exits/employees/:id',
          "{ guard: exitCommandGuard(deps, ctx, 'create', gate, { departmentId }) }",
        ),
        EXIT_GUARD,
        EXIT_PERMISSION,
        WRITE_BUTTON,
      ],
      '按钮 = 办理方式：direct → Employment.Dimission、application → Employment.DimissionApproval',
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        at(
          EXIT,
          'POST',
          '/exits/employees/:id',
          'if (departmentId !== undefined) requireEmploymentScope(ctx, id, departmentId)',
        ),
        EMPLOYMENT_SCOPE,
      ],
    ),
    linkage(at(EXIT, 'POST', '/exits/employees/:id', 'body: await createExitApplication(tx, context,')),
  ],
  'POST /api/tenant/employment/exits/batch': [
    ob(
      `obj:${RECORD}:create`,
      [
        'object:readContext(object.*)',
        'objectOp:TenantBase.EmploymentRecord:create',
        'object:object.* 动作',
        'object:requireObjectWrite（对象写操作权）',
      ],
      [at(EXIT, 'POST', '/exits/batch', "const ctx = await readContext(c, deps, 'object.create')"), READ, WRITE_OBJECT],
    ),
    ob(
      `btn:${RECORD}#Employment.DimissionApproval@detail`,
      [],
      [
        at(EXIT, 'POST', '/exits/batch', 'const guard = exitBatchGuard(deps, ctx, items)'),
        fn(REPLAY, 'exitBatchGuard', "await requireExitPermission(scoped, 'create', target)"),
        EXIT_PERMISSION,
        WRITE_BUTTON,
      ],
      '逐人复核；不通过的人作为逐条原因进整批 409（不单独 403）',
    ),
    ob(
      'guard:employment.scope',
      [],
      [fn(REPLAY, 'exitBatchGuard', 'await requireExitScope(tx, scoped, target, {})'), EMPLOYMENT_SCOPE],
    ),
    linkage(at(EXIT, 'POST', '/exits/batch', 'body: await createExitBatch(tx, context, items, guard.failures())')),
  ],
  'PATCH /api/tenant/employment/exits/:id': [
    ...exitBusinessCommand('/exits/:id', 'Employment.DimissionEdit', 'route'),
    ob(
      'btn:TenantBase.ApprovalInstance#adminIntervene@detail',
      ['button:object.button', 'button:buttonResource'],
      [
        at(EXIT, 'PATCH', '/exits/:id', '{ guard: exitEditGuard(deps, ctx, gate, id) }'),
        fn(REPLAY, 'exitEditGuard', 'await requireExitEditRights(tx, scoped, target, businessId)'),
        fn(
          REPLAY,
          'requireExitEditRights',
          "resource: buttonResource(APPROVAL_INSTANCE_OBJECT, 'adminIntervene', 'detail')",
        ),
      ],
      '只在单据处于 in_review 时要求（与审批编辑同约束，B-65a）',
    ),
  ],
  'POST /api/tenant/employment/exits/:id/submit': exitBusinessCommand(
    '/exits/:id/submit',
    'Employment.DimissionApproval',
    'registerExitChanges',
  ),
  'POST /api/tenant/employment/exits/:id/withdraw': exitBusinessCommand(
    '/exits/:id/withdraw',
    'Employment.DimissionApproval',
    'registerExitChanges',
  ),
  // ---- R2-T04 BE-5a 退休办理入口（retirement-routes.ts；与离职同一门禁，按钮取 Retire*）-----------------------------------
  'POST /api/tenant/employment/retirements/employees/:id/preview': [
    ...exitPreview('Employment.Retire', RETIRE, '/retirements/employees/:id/preview', ', KIND'),
    ...exitPreview('Employment.RetireApproval', RETIRE, '/retirements/employees/:id/preview', ', KIND'),
  ],
  'POST /api/tenant/employment/retirements/employees/:id': [
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
          RETIRE,
          'POST',
          '/retirements/employees/:id',
          "const ctx = await readContext(c, deps, 'object.create', revision(c), id)",
        ),
        READ,
        EXIT_GUARD,
        EXIT_PERMISSION,
        WRITE_OBJECT,
      ],
    ),
    ob(
      `btn:${RECORD}#{mapper:employment.retirementButton}`,
      ['button:buttonResource', 'button:object.button'],
      [
        at(
          RETIRE,
          'POST',
          '/retirements/employees/:id',
          "{ guard: exitCommandGuard(deps, ctx, 'create', gate, { departmentId }) }",
        ),
        EXIT_GUARD,
        EXIT_PERMISSION,
        WRITE_BUTTON,
      ],
      '按钮 = 办理方式：direct → Employment.Retire、application → Employment.RetireApproval（buttonsOf(kind)）',
    ),
    ob(
      'guard:employment.scope',
      [],
      [
        at(
          RETIRE,
          'POST',
          '/retirements/employees/:id',
          'if (departmentId !== undefined) requireEmploymentScope(ctx, id, departmentId)',
        ),
        EMPLOYMENT_SCOPE,
      ],
    ),
    linkage(at(RETIRE, 'POST', '/retirements/employees/:id', 'body: await createExitApplication(tx, context,')),
  ],
  'PATCH /api/tenant/employment/retirements/:id': [
    ...exitBusinessCommand('/retirements/:id', 'Employment.RetireEdit', 'route', RETIRE),
    ob(
      'btn:TenantBase.ApprovalInstance#adminIntervene@detail',
      ['button:object.button', 'button:buttonResource'],
      [
        at(RETIRE, 'PATCH', '/retirements/:id', '{ guard: exitEditGuard(deps, ctx, gate, id) }'),
        fn(REPLAY, 'exitEditGuard', 'await requireExitEditRights(tx, scoped, target, businessId)'),
        fn(
          REPLAY,
          'requireExitEditRights',
          "resource: buttonResource(APPROVAL_INSTANCE_OBJECT, 'adminIntervene', 'detail')",
        ),
      ],
      '只在单据处于 in_review 时要求（与审批编辑同约束，B-65a）',
    ),
  ],
  'POST /api/tenant/employment/retirements/:id/submit': exitBusinessCommand(
    '/retirements/:id/submit',
    'Employment.RetireApproval',
    'registerRetirementChanges',
    RETIRE,
  ),
  'POST /api/tenant/employment/retirements/:id/withdraw': exitBusinessCommand(
    '/retirements/:id/withdraw',
    'Employment.RetireApproval',
    'registerRetirementChanges',
    RETIRE,
  ),
  // ---- R2-T03 B4 撤销离职 ----
  'POST /api/tenant/employment/exits/:id/cancel': exitCancelCommand(),
  'POST /api/tenant/employment/exits/:id/restore': exitCancelRestore(),
  'PATCH /api/tenant/employment/exits/cancellations/:id': exitCancellationPatch(),
  // ---- R2-T04 BE-5a′ 撤销退休（同一套，按钮 RetireCancel）----
  'POST /api/tenant/employment/retirements/:id/cancel': exitCancelCommand(RETIRE_CANCEL),
  'POST /api/tenant/employment/retirements/:id/restore': exitCancelRestore(RETIRE_CANCEL),
  'PATCH /api/tenant/employment/retirements/cancellations/:id': exitCancellationPatch(RETIRE_CANCEL),
  // ---- R2-T03 B5 离职视图与详情（exit-routes.ts registerExitViews）--------------------------------------------------
  'GET /api/tenant/employment/exits': [
    recordView(at(EXIT, 'GET', '/exits', "const ctx = await readPageContext(c, deps, 'list')")),
    ob(
      'guard:employment.viewableFilters',
      [],
      [
        at(EXIT, 'GET', '/exits', 'requireViewableExitFilters(filter, show)'),
        fn(EXIT, 'requireViewableExitFilters', "throw new AppError('FORBIDDEN', '筛选字段不可查看')"),
      ],
    ),
  ],
  'GET /api/tenant/employment/exits/:id': [
    recordView(at(EXIT, 'GET', '/exits/:id', "const ctx = await readPageContext(c, deps, 'detail')")),
  ],
  // ---- R2-T04 BE-5d1 退休五视图与详情（retirement-view-routes.ts registerRetirementViews）-------------------------------
  'GET /api/tenant/employment/retirements': [
    recordView(at(RETIRE_VIEWS, 'GET', '/retirements', "const ctx = await readPageContext(c, deps, 'list')")),
  ],
  'GET /api/tenant/employment/retirements/:id': [
    recordView(at(RETIRE_VIEWS, 'GET', '/retirements/:id', "const ctx = await readPageContext(c, deps, 'detail')")),
  ],
  'GET /api/tenant/employment/exits/dictionaries/:dict': [
    ob(
      `obj:${RECORD}:view`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:view', 'object:object.* 动作'],
      [at(EXIT, 'GET', '/exits/dictionaries/:dict', "const ctx = await readContext(c, deps, 'object.view', 0)"), READ],
    ),
  ],
  'POST /api/tenant/employment/exits/dictionaries/:dict': configWrite(
    at(EXIT, 'POST', '/exits/dictionaries/:dict', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentSettings',
    'create',
    at(
      EXIT,
      'POST',
      '/exits/dictionaries/:dict',
      "await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings')",
    ),
  ),
  'PUT /api/tenant/employment/exits/dictionaries/:dict/:id': configWrite(
    at(EXIT, 'PUT', '/exits/dictionaries/:dict/:id', "'tenant.employment.configuration.write'"),
    'TenantBase.EmploymentSettings',
    'update',
    at(
      EXIT,
      'PUT',
      '/exits/dictionaries/:dict/:id',
      "await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings')",
    ),
  ),
  // ---- employment/blacklist-routes.ts：R2 BE-8a 黑名单（B68）与离职自动加黑规则（任职设置配置对象）------------------
  'GET /api/tenant/employment/blacklist': blacklistRoute(
    'GET',
    '/blacklist',
    'view',
    "const ctx = await readContext(c, deps, 'object.view', 0, undefined, BLACKLIST_OBJECT)",
  ),
  'POST /api/tenant/employment/blacklist': blacklistRoute(
    'POST',
    '/blacklist',
    'create',
    "const ctx = await readContext(c, deps, 'object.create', revision(c), undefined, BLACKLIST_OBJECT)",
    ['create', 'list'],
    true,
  ),
  'PUT /api/tenant/employment/blacklist/:id': blacklistRoute(
    'PUT',
    '/blacklist/:id',
    'update',
    "const ctx = await readContext(c, deps, 'object.update', revision(c), undefined, BLACKLIST_OBJECT)",
    ['update', 'list_row'],
  ),
  'POST /api/tenant/employment/blacklist/remove': blacklistRoute(
    'POST',
    '/blacklist/remove',
    'update',
    "const ctx = await readContext(c, deps, 'object.update', 0, undefined, BLACKLIST_OBJECT)",
    ['remove', 'list'],
  ),
  'POST /api/tenant/employment/blacklist/delete': blacklistRoute(
    'POST',
    '/blacklist/delete',
    'delete',
    "const ctx = await readContext(c, deps, 'object.delete', 0, undefined, BLACKLIST_OBJECT)",
    ['delete', 'list'],
  ),
  'GET /api/tenant/employment/blacklist-rules': [
    ob(
      'obj:TenantBase.EmploymentSettings:view',
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentSettings:view', 'object:object.* 动作'],
      [
        at(
          BL,
          'GET',
          '/blacklist-rules',
          "const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings')",
        ),
        READ,
      ],
    ),
  ],
  ...Object.fromEntries(
    (
      [
        ['POST', '/blacklist-rules', 'create'],
        ['PUT', '/blacklist-rules/:id', 'update'],
        ['DELETE', '/blacklist-rules/:id', 'update'],
      ] as const
    ).map(([method, path, operation]) => [
      `${method} /api/tenant/employment${path}`,
      withObjectWriteFact(
        configWrite(
          fn(
            BL,
            'registerBlacklistRuleRoutes',
            "readContext( c, deps, 'tenant.employment.configuration.write', revision(c),",
          ),
          'TenantBase.EmploymentSettings',
          operation,
          at(
            BL,
            method,
            path,
            `await requireEmploymentWrite(ctx, '${operation}', ${method === 'DELETE' ? '{}' : 'input'}, undefined, ` +
              "'TenantBase.EmploymentSettings'",
          ),
        ),
      ),
    ]),
  ),
  // ---- employment/auto-regularization-routes.ts：R2 BE-15a 自动转正规则与立即执行（同自动加黑规则，配置写入口 writeContext）--
  'GET /api/tenant/employment/auto-regularization-rules': [
    ob(
      'obj:TenantBase.EmploymentSettings:view',
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentSettings:view', 'object:object.* 动作'],
      [
        at(
          AUTO_REG,
          'GET',
          '/auto-regularization-rules',
          "const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings')",
        ),
        READ,
      ],
    ),
  ],
  ...Object.fromEntries(
    (
      [
        ['POST', '/auto-regularization-rules', 'create', 'input'],
        ['PUT', '/auto-regularization-rules/:id', 'update', 'input'],
        ['POST', '/auto-regularization-rules/:id/copy', 'create', '{}'],
        ['PUT', '/auto-regularization-rules/:id/enabled', 'update', '{ enabled }'],
        ['DELETE', '/auto-regularization-rules/:id', 'update', '{}'],
      ] as const
    ).map(([method, path, operation, payload]) => [
      `${method} /api/tenant/employment${path}`,
      withObjectWriteFact(
        configWrite(
          fn(AUTO_REG, 'writeContext', "readContext( c, deps, 'tenant.employment.configuration.write', revision(c),"),
          'TenantBase.EmploymentSettings',
          operation,
          at(
            AUTO_REG,
            method,
            path,
            `await requireEmploymentWrite(ctx, '${operation}', ${payload}, undefined, ` +
              "'TenantBase.EmploymentSettings'",
          ),
        ),
      ),
    ]),
  ),
  /**
   * 立即执行：准入只认配置写（admin:other_settings 不叠加数据范围，系统批次按规则适用组织办理）；任职记录查看权的
   * 披露用途另列 runReceiptDisclosure（第 4 轮审查 P2）。配置对象 update 义务的范围是回执的人员披露（BE-15a 第 2 轮审查 P1）——首次返回与同键重放都经 runWrite 的投影出口
   * visibleRunReceipt → visibleEmployees，按操作人当前的任职记录查看权与数据范围逐人过滤。
   */
  'POST /api/tenant/employment/auto-regularization/run': [
    ...withObjectWriteFact(
      withNeeds(
        configWriteBase(
          fn(AUTO_REG, 'writeContext', "readContext( c, deps, 'tenant.employment.configuration.write', revision(c),"),
          'TenantBase.EmploymentSettings',
          'update',
          at(
            AUTO_REG,
            'POST',
            '/auto-regularization/run',
            "await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings'",
          ),
        ),
        {
          'admin:other_settings': bound(NONE),
          'obj:TenantBase.EmploymentSettings:update': bound(list('employment.runReceipt'), [
            at(
              AUTO_REG,
              'POST',
              '/auto-regularization/run',
              '{ guard: ruleGuard(deps, ctx, {}), project: (body) => visibleRunReceipt(deps, ctx, body) }',
            ),
            ...SCOPE_AT['employment.runReceipt'],
          ]),
        },
      ),
    ),
    // 任职记录查看权的披露用途（第 4 轮审查 P2）：object.view 的探测事实由这条 disclosure 义务承接
    runReceiptDisclosure(AUTO_REG, '/auto-regularization/run'),
    // 逐人经 BE-3 转正入口发起，联动校验在那里照常调用（系统批次无数据范围）
    linkage(
      at(
        AUTO_REG,
        'POST',
        '/auto-regularization/run',
        'async (tx, context) => ({ status: 200, body: await runAutoRegularizationNow(tx, context, cursor) })',
      ),
    ),
  ],
  // ---- employment/auto-assessment-routes.ts：R2 BE-15b2 自动发起考核规则与立即执行（同自动转正规则，配置写入口 writeContext）--
  'GET /api/tenant/employment/auto-assessment-rules': [
    ob(
      'obj:TenantBase.EmploymentSettings:view',
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentSettings:view', 'object:object.* 动作'],
      [
        at(
          AUTO_ASSESS,
          'GET',
          '/auto-assessment-rules',
          "const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings')",
        ),
        READ,
      ],
    ),
  ],
  ...Object.fromEntries(
    (
      [
        ['POST', '/auto-assessment-rules', 'create', 'input'],
        ['PUT', '/auto-assessment-rules/:id', 'update', 'input'],
        ['POST', '/auto-assessment-rules/:id/copy', 'create', '{}'],
        ['PUT', '/auto-assessment-rules/:id/enabled', 'update', '{ enabled }'],
        ['DELETE', '/auto-assessment-rules/:id', 'update', '{}'],
      ] as const
    ).map(([method, path, operation, payload]) => [
      `${method} /api/tenant/employment${path}`,
      withObjectWriteFact(
        configWrite(
          fn(AUTO_REG, 'writeContext', "readContext( c, deps, 'tenant.employment.configuration.write', revision(c),"),
          'TenantBase.EmploymentSettings',
          operation,
          at(
            AUTO_ASSESS,
            method,
            path,
            `await requireEmploymentWrite(ctx, '${operation}', ${payload}, undefined, ` +
              "'TenantBase.EmploymentSettings'",
          ),
        ),
      ),
    ]),
  ),
  // ---- employment/retirement-rule-routes.ts：R2 BE-5c1a 预计退休日期规则与个人身份字典（同自动转正规则，配置写入口 writeContext）--
  'GET /api/tenant/employment/retirement-rules': [
    ob(
      'obj:TenantBase.EmploymentSettings:view',
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentSettings:view', 'object:object.* 动作'],
      [
        at(
          RETIREMENT_RULE,
          'GET',
          '/retirement-rules',
          "const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings')",
        ),
        READ,
      ],
    ),
  ],
  ...Object.fromEntries(
    (
      [
        ['POST', '/retirement-rules', 'create', 'input'],
        ['PUT', '/retirement-rules/:id', 'update', 'input'],
        ['POST', '/retirement-rules/:id/copy', 'create', '{}'],
        ['PUT', '/retirement-rules/:id/enabled', 'update', '{ enabled }'],
        ['DELETE', '/retirement-rules/:id', 'update', '{}'],
      ] as const
    ).map(([method, path, operation, payload]) => [
      `${method} /api/tenant/employment${path}`,
      withObjectWriteFact(
        configWrite(
          fn(AUTO_REG, 'writeContext', "readContext( c, deps, 'tenant.employment.configuration.write', revision(c),"),
          'TenantBase.EmploymentSettings',
          operation,
          at(
            RETIREMENT_RULE,
            method,
            path,
            `await requireEmploymentWrite(ctx, '${operation}', ${payload}, undefined, ` +
              "'TenantBase.EmploymentSettings'",
          ),
        ),
      ),
    ]),
  ),
  'GET /api/tenant/employment/retirement-identity-types': [
    ob(
      `obj:${RECORD}:view`,
      ['object:readContext(object.*)', 'objectOp:TenantBase.EmploymentRecord:view', 'object:object.* 动作'],
      [
        at(
          RETIREMENT_RULE,
          'GET',
          '/retirement-identity-types',
          "const ctx = await readContext(c, deps, 'object.view', 0)",
        ),
        READ,
      ],
    ),
  ],
  /**
   * 立即执行：准入只认配置写（admin:other_settings 不叠加数据范围，系统批次按规则适用组织办理）；任职记录查看权的
   * 披露用途另列 runReceiptDisclosure（第 4 轮审查 P2）。配置对象 update 义务的范围是回执的人员披露（同 BE-15a 第 2 轮审查 P1）——首次返回与同键重放都经 runWrite 的投影出口
   * visibleRunReceipt → visibleEmployees，按操作人当前的任职记录查看权与数据范围逐人过滤。
   */
  'POST /api/tenant/employment/auto-assessment/run': [
    ...withObjectWriteFact(
      withNeeds(
        configWriteBase(
          fn(AUTO_REG, 'writeContext', "readContext( c, deps, 'tenant.employment.configuration.write', revision(c),"),
          'TenantBase.EmploymentSettings',
          'update',
          at(
            AUTO_ASSESS,
            'POST',
            '/auto-assessment/run',
            "await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings'",
          ),
        ),
        {
          'admin:other_settings': bound(NONE),
          'obj:TenantBase.EmploymentSettings:update': bound(list('employment.runReceipt'), [
            at(
              AUTO_ASSESS,
              'POST',
              '/auto-assessment/run',
              '{ guard: ruleGuard(deps, ctx, {}), project: (body) => visibleRunReceipt(deps, ctx, body) }',
            ),
            ...SCOPE_AT['employment.runReceipt'],
          ]),
        },
      ),
    ),
    // 任职记录查看权的披露用途（第 4 轮审查 P2）：object.view 的探测事实由这条 disclosure 义务承接
    runReceiptDisclosure(AUTO_ASSESS, '/auto-assessment/run'),
  ],
  // ---- employment/assessment-routes.ts：R2 BE-15b1 试用中考核 / 转正考核（B2，29 PB-R3～R6）-------------------------------
  'GET /api/tenant/employment/probation-assessments': [
    assessmentView(
      at(
        ASSESS,
        'GET',
        '/probation-assessments',
        "const ctx = await readPageContext(c, deps, 'list', undefined, PROBATION_ASSESSMENT_OBJECT)",
      ),
    ),
  ],
  'GET /api/tenant/employment/probation-assessments/:id': [
    assessmentView(
      at(
        ASSESS,
        'GET',
        '/probation-assessments/:id',
        "const ctx = await readPageContext(c, deps, 'detail', undefined, PROBATION_ASSESSMENT_OBJECT)",
      ),
    ),
    ob(
      'guard:employment.assessmentScope',
      [],
      [
        at(ASSESS, 'GET', '/probation-assessments/:id', 'await requireAssessmentInScope(tx, ctx, found)'),
        ASSESSMENT_IN_SCOPE,
        ASSESSMENT_SCOPE_SQL,
      ],
      '考核不存在与考核对象在范围外同一个 404',
    ),
  ],
  'POST /api/tenant/employment/probation-assessments': [
    ob(
      `obj:${ASSESSMENT}:create`,
      ['object:readContext(object.*)', `objectOp:${ASSESSMENT}:create`, 'object:object.* 动作'],
      [
        at(
          ASSESS,
          'POST',
          '/probation-assessments',
          "const ctx = await readContext(c, deps, 'object.create', 0, undefined, PROBATION_ASSESSMENT_OBJECT)",
        ),
        READ,
        WRITE_OBJECT,
        ASSESSMENT_CONST,
      ],
    ),
    ob(
      `btn:${ASSESSMENT}#Assessment.Create@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          ASSESS,
          'POST',
          '/probation-assessments',
          "await requireEmploymentWrite(ctx, 'create', payload, 'Assessment.Create', PROBATION_ASSESSMENT_OBJECT)",
        ),
        WRITE_BUTTON,
        ASSESSMENT_CONST,
      ],
    ),
    ob(
      'guard:employment.scope',
      [],
      [fn(ASSESS_SERVICE, 'createOne', 'await requireEmployeeInScope(tx, ctx, item.employeeId)'), EMPLOYEE_IN_SCOPE],
      '逐人在保存点内判定，只让那一人失败（回执 404）',
    ),
    directOperation(
      fn(
        `${SRC}/employment/write-service.ts`,
        'materializeEmploymentRecord',
        'await requireScopedEmploymentObject(tx, ctx, business.employeeId, fields.departmentId)',
      ),
    ),
  ],
  'PATCH /api/tenant/employment/probation-assessments/:id': [
    ob(
      `obj:${ASSESSMENT}:update`,
      ['object:readContext(object.*)', `objectOp:${ASSESSMENT}:update`, 'object:object.* 动作'],
      [
        at(
          ASSESS,
          'PATCH',
          '/probation-assessments/:id',
          "const ctx = await readContext(c, deps, 'object.update', revision(c), " +
            'undefined, PROBATION_ASSESSMENT_OBJECT)',
        ),
        READ,
        WRITE_OBJECT,
        ASSESSMENT_CONST,
      ],
    ),
    ob(
      `btn:${ASSESSMENT}#Assessment.Edit@detail`,
      ['button:requireEmploymentWrite(按钮)'],
      [
        at(
          ASSESS,
          'PATCH',
          '/probation-assessments/:id',
          "await requireEmploymentWrite(ctx, 'update', patch, 'Assessment.Edit', PROBATION_ASSESSMENT_OBJECT)",
        ),
        WRITE_BUTTON,
        ASSESSMENT_CONST,
      ],
    ),
    ob(
      'guard:employment.assessmentScope',
      [],
      [
        fn(ASSESS_SERVICE, 'updateAssessment', 'await requireAssessmentInScope(tx, ctx, row)'),
        ASSESSMENT_IN_SCOPE,
        ASSESSMENT_SCOPE_SQL,
      ],
      '考核对象不在范围内 404',
    ),
  ],
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
        BUSINESS_WRITE_ENTRY,
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
