/**
 * 合同模块路由的现状声明（F-039 PR-A；附录 A「/api/tenant/contracts」23 条）。子应用挂在 /api/tenant/contracts，
 * 键用本地路径（routes.ts 的 module.get('/')、module.on('PUT', '/rules/:id') …）。
 *
 * 现状骨架（routes.ts）：
 * - routeContext(c, deps, object, write)：解析该对象的模块范围（resolveModuleScope，pageCode `${object}.list`）；只读路由再查
 *   requirePermission('object.view', object)；**写路由不查 object.view**（routes.ts:55–61），功能权限由 checkFields /
 *   requireObjectWrite（object.create / object.update + 字段）与 object.button 承担，并要求 If-Match
 *   （revision(c) → 400 REVISION_REQUIRED），Idempotency-Key 由 runCommand 强制（400 IDEMPOTENCY_KEY_REQUIRED）。
 * - 配置对象 ContractSettings / ContractRenewalRule 的 object.* 由授权器 CONFIG_OBJECTS 分支判定（tenant_admin 或
 *   contractConfiguration；写入口逐键对非系统字段），仍登记为 kind 'object'（§2.4）。
 * - write()：命令前 requireMasterScope（主数据无看全部 → 404「合同主数据不存在」）→ runCommand（事务内重新解析范围并再
 *   requireMasterScope）→ 返回后再 requireMasterScope；合同对象另逐 employeeId（+ createdBy）checkScope
 *   （contracts.resultEmployees）→ trim 按对象查看字段裁剪（customFields 按 custom:<id>；items / page / pageSize /
 *   hasDataPermission / count 为信封键）。
 * - checkScope：无创建人时按人员新建范围端口（DEC-180④），不可见 → 404 NOT_FOUND「合同数据不存在」；
 *   checkOperationScope：目标合同不属于该员工 → 404；create / renew 走新建范围（DEC-202），其余用目标合同创建人。
 * - checkFields 只查**本次输入** fields（去 customFields，自定义字段转 custom:<id>）；续签 / 变更 / 终止继承的目标合同字段在
 *   命令内 prepare 做格式 / 引用 / 范围校验，不查编辑权（§2.4，第 3 轮 P2-1 ②）。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * - POST /imports、/imports/preview、/imports/errors：附录写「view + button import(list)」；routeContext(write = true) 不查
 *   object.view，路由级只有 import@list 按钮，create / update 开关逐行由 checkFields 判定 → operation 'button'。
 * - POST /imports/preview：附录写 shape contracts.importPreview；代码 c.json(result) 不经 trim（routes.ts:409），响应是固定键
 *   valid / count / errors → fixed。
 * - POST /todos/batch 出口：附录写 projector approval.receipt；代码直接返回逐单回执（todos.ts:89–95），result 是动作的
 *   Outcome.body（{ instanceId }，approval/actions.ts:59；盲审 403 的错误体，actions.ts:163–166），无投影 →
 *   fixed(id / status / result / error)。
 * - POST /todos/batch result：附录写 generic(items[*].id → approval.canOpen)；代码返回后没有任何复核 → none。
 * - GET /failures 固定键：附录只列 kind / state / error / 时间；代码 `SELECT a.*`（routes.ts:479）原样返回
 *   contract_job_attempts 的 10 个 snake_case 列（packages/db/src/schema/contracts.ts:258–273）。
 * - PUT /master-data/<kind>/:id 的 uuidParam 在命令内求值（saveMaster 实参，routes.ts:337），先经过 requireObjectWrite /
 *   requireMasterScope / Idempotency-Key，仍是 400 VALIDATION_FAILED，只是顺序靠后。
 * - GET / 信封：处理函数只返回 items / page / pageSize / hasDataPermission（routes.ts:153–160），count 不在列表响应里
 *   （只出现在导入结果），形状 contracts.list 登记时按此。
 * - POST /imports/errors：任一行格式不合法时直接返回 CSV（routes.ts:406），authorizeImport（字段权 / 范围 / 初始化删除权）在
 *   该分支不执行；附录未提及，按现状在此登记。
 *
 * 路径约定：选择器与 rows 里的 path 一律从请求体根算起，`[*]` 表示逐行（如 items[*].command.operation）；rows.target 同。
 * 前提（preconditions）登记真实函数名；`revision` 指 contracts/context.ts 的乐观锁比对（409 REVISION_CONFLICT）。
 */
import {
  CONTRACT_FLOW,
  CONTRACT_OBJECT,
  contractAction,
  type ContractOperation,
  MODULE_OBJECTS,
} from '@italent/domain';
import {
  type ButtonPolicy,
  defineTable,
  type FieldsFrom,
  type OperationSelector,
  type RoutePolicy,
  type RowsPolicy,
  type Selector,
} from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  commandWrite,
  EMPTY_LIST,
  fixed,
  FORBIDDEN,
  guardScope,
  listScope,
  noButton,
  noFields,
  none,
  noScope,
  NOT_FOUND,
  object,
  pointScope,
  projector,
  seeAll,
  shape,
  write,
} from '../../route-policy/presets.js';

const CONTRACT = CONTRACT_OBJECT;
const SETTINGS = MODULE_OBJECTS.contractSettings.code;
const RULE = MODULE_OBJECTS.contractRules.code;
const TYPE = MODULE_OBJECTS.contractType.code;
const COMPANY = MODULE_OBJECTS.contractCompany.code;

// ---- 分支域（供选择器与 FW-02 分支域常量对账）-----------------------------------------------------------------------
/** commandSchema.operation 的域 = @italent/domain CONTRACT_FLOW 的键（create / renew / change / terminate）。 */
export const CONTRACT_OPERATIONS = Object.keys(CONTRACT_FLOW) as readonly ContractOperation[];
/** commandSchema.mode（input.ts）。 */
export const CONTRACT_COMMAND_MODES = ['direct', 'application'] as const;
/** importSchema.mode（imports.ts）。 */
export const CONTRACT_IMPORT_MODES = ['add', 'edit', 'change', 'initialize'] as const;
/** 合同待办批量的 action 枚举（todos.ts）。 */
export const CONTRACT_TODO_ACTIONS = ['approve', 'decline', 'reject', 'resubmit'] as const;

/** 现状 routes.ts:192 / :224：create → 新增开关，其余三种 → 编辑开关（checkFields 的 operation 实参）。 */
const dataOperation = (operation: string): 'create' | 'update' => (operation === 'create' ? 'create' : 'update');
/** 现状 routes.ts:200 / :232：create 系列按钮在列表级，其余在详情级。 */
const buttonLevel = (operation: string): 'list' | 'detail' => (operation === 'create' ? 'list' : 'detail');
/**
 * 按钮选择器 contracts.commandButton 的域：operation × mode 共 8 个 `code@level`
 * （buttonResource(CONTRACT, contractAction(operation, mode), level)，routes.ts:196–201）。
 */
export const CONTRACT_COMMAND_BUTTONS: readonly string[] = CONTRACT_OPERATIONS.flatMap((operation) =>
  CONTRACT_COMMAND_MODES.map((mode) => `${contractAction(operation, mode)}@${buttonLevel(operation)}`),
);

function operationSelector(
  path: string,
  domain: readonly string[],
  toOperation: (value: string) => 'create' | 'update',
): OperationSelector {
  return { from: 'body', path, map: Object.fromEntries(domain.map((value) => [value, toOperation(value)] as const)) };
}
const COMMAND_OPERATION = operationSelector('operation', CONTRACT_OPERATIONS, dataOperation);
const BATCH_OPERATION = operationSelector('items[*].command.operation', CONTRACT_OPERATIONS, dataOperation);
/** authorizeImport（routes.ts:381）：edit / change → 编辑开关，add / initialize → 新增开关；mode 是整批共用的顶层键。 */
const IMPORT_OPERATION = operationSelector('mode', CONTRACT_IMPORT_MODES, (mode) =>
  mode === 'edit' || mode === 'change' ? 'update' : 'create',
);
const COMMAND_BUTTON: ButtonPolicy = {
  from: 'mapper',
  mapper: 'contracts.commandButton',
  domain: CONTRACT_COMMAND_BUTTONS,
};
/** todos.ts:46–61：approve / decline / reject 查 approval_tasks.assignee_user_id = 本人；resubmit 走 requireResubmitRight。 */
const TODO_RELATION: Selector<string> = {
  from: 'body',
  path: 'action',
  map: Object.fromEntries(
    CONTRACT_TODO_ACTIONS.map(
      (action) => [action, action === 'resubmit' ? 'approval.initiator' : 'approval.currentAssignee'] as const,
    ),
  ),
};

// ---- 拒绝码与形状 ----------------------------------------------------------------------------------------------
/** checkScope / checkOperationScope：范围外、目标合同不属于该员工 → 404 NOT_FOUND「合同数据不存在」（无 details.reason）。 */
const NF_CONTRACT = NOT_FOUND;
/** requireMasterScope：主数据无看全部 → 404 NOT_FOUND「合同主数据不存在」（命令前 + 事务内 + 返回后）。 */
const NF_MASTER = NOT_FOUND;
/** 合同记录 / 申请 / 命令结果都经 trim 按 EmploymentContract 查看字段裁剪（含 customFields 的 custom:<id>）。 */
const record = shape('contracts.record');
const master = shape('contracts.master');
/** 合同对象的列表谓词：employmentVisibilitySql（employee + creator 列，department 为 NULL），queries.ts / routes.ts:469。 */
const EMPLOYEE_VISIBILITY = 'contracts.employeeVisibility';
const NO_CONFIG_BUTTON = noButton('配置对象只有数据操作开关，没有按钮（authorizer CONFIG_OBJECTS 分支）');
const CONFIG_SCOPE = noScope('配置对象是租户全局配置，resolveModuleScope 的结果不参与判定');
const NO_MASTER_BUTTON = noButton('主数据只有数据操作开关，没有按钮');

// ---- 写策略 ------------------------------------------------------------------------------------------------------
const MASTER_SCOPE = 'contracts.masterScope';
const RESULT_EMPLOYEES = 'contracts.resultEmployees';
/**
 * 合同命令内（createCommand → prepare，service.ts）的业务前提：员工行锁、乐观锁（409 REVISION_CONFLICT）、目标合同状态
 * （409「当前合同状态不允许该操作」）、同类型在途合同（409 CONTRACT_IN_FLIGHT）；prepare 内另复跑 checkOperationScope /
 * checkFields（已在 scope / write.fields 登记，不重复列）。
 */
const COMMAND_PRECONDITIONS = ['lockEmployee', 'revision', 'assertOperationState', 'assertNoInFlight'];
const contractCommand = (fields: FieldsFrom) =>
  write(fields, MASTER_SCOPE, RESULT_EMPLOYEES, { preconditions: COMMAND_PRECONDITIONS, ledger: 'single' });
/**
 * 配置写入口：requireObjectWrite(payload = body) 逐键对配置对象的非系统字段（authorizer.ts CONFIG_OBJECTS 分支）；事务内
 * 只有 revision 比对与 audit（objectType = EmploymentContract，action 即登记名，§10.3 残留①）；配置对象无范围，返回后只 trim。
 */
const auditedConfigWrite = (action: string) =>
  write('body', `config.audited:${action}`, none('配置对象无范围，返回后只按配置对象字段权 trim'), {
    preconditions: ['revision'],
  });
/** 主数据写入口：requireMasterScope 在命令前、事务内、返回后各一次；saveMaster 内 revision 比对。 */
const masterWrite = write('body', MASTER_SCOPE, MASTER_SCOPE, { preconditions: ['revision'] });
/**
 * 合同待办批量逐项 runCommand（key:index）内的前提（approval/actions.ts）：approve / decline / reject 走 openTask →
 * assertOpen（assertRevision + 状态 + assertBusinessUnchanged）→ assertExit（approve / disagree）或 assertRejectEnabled →
 * blindReview（盲审 Outcome 403，已提交入台账）→ assertNotSelf；resubmit 走 openOwn（发起人 + assertRevision）→ 重提状态 →
 * recheckContractResubmit（requireResubmitRight 事务内复查）。openTask / openOwn 都经 openRun。approveTask 的编辑分支
 * （assertApprovalEdit / assertNotBlindAfterEdit）在批量里不传 fields 时不执行；它们静态可达（同一 approveTask），
 * 按“前提允许多登”的口径登记，避免基准观测到而声明缺失。
 */
const TODO_PRECONDITIONS = [
  'openTask',
  'openRun',
  'assertOpen',
  'assertRevision',
  'assertBusinessUnchanged',
  'assertExit',
  'assertRejectEnabled',
  'blindReview',
  'assertNotSelf',
  'openOwn',
  'assertApprovalEdit',
  'assertNotBlindAfterEdit',
];

// ---- 导入三入口共用的准入 ----------------------------------------------------------------------------------------
/**
 * 导入逐行：checkFields(row.fields)（只校验本次行字段）→ checkImportScope（edit / change 先定位原合同，未匹配按人员范围；
 * 其余 checkOperationScope）→ mode = initialize 另须 object.delete（contracts.importInitializeDelete）。
 */
const importRows: RowsPolicy = {
  path: 'rows[*]',
  operation: IMPORT_OPERATION,
  fields: 'contracts.fields+customFields',
  target: { body: 'rows[*].employeeId' },
  batch: 'atomic',
};
const importAdmission = {
  object: CONTRACT,
  operation: 'button' as const,
  button: button('import', 'list'),
  guards: ['contracts.importInitializeDelete'],
  scope: guardScope('contracts.importScope', NF_CONTRACT),
  rows: importRows,
};

function masterList(objectCode: string): RoutePolicy {
  // 列表 `WHERE tenant_id = ? AND ${scope.all}`：无看全部 → 200、items: []，不 404（routes.ts:314）
  return object({
    object: objectCode,
    operation: 'view',
    button: NO_MASTER_BUTTON,
    scope: seeAll(EMPTY_LIST),
    fields: master,
  });
}
function masterSave(objectCode: string, operation: 'create' | 'update'): RoutePolicy {
  return object({
    object: objectCode,
    operation,
    button: NO_MASTER_BUTTON,
    scope: seeAll(NF_MASTER),
    fields: master,
    write: masterWrite,
    ...(operation === 'update' ? { invalidId: BAD_REQUEST } : {}),
  });
}

export const CONTRACT_POLICIES = defineTable('contracts', {
  // ---- routes.ts registerContractRoutes：列表 / 版本 / 记录 ------------------------------------------------------------
  // view 查询参数（all / valid / expiring / expired_unrenewed / missing / in_review）非法 → 400；
  // 响应 { items, page, pageSize, hasDataPermission } 经 trim；missing 视图的 items 是缺合同员工（employeeId / code / name）
  'GET /': object({
    object: CONTRACT,
    operation: 'view',
    button: noButton('列表只按查看权与范围过滤'),
    scope: listScope(EMPLOYEE_VISIBILITY),
    fields: shape('contracts.list'),
  }),
  // 合同集合版本号；checkScope(id) 无创建人 → 人员新建范围端口（DEC-180④）
  'GET /employees/:id/revision': object({
    object: CONTRACT,
    operation: 'view',
    button: noButton('只读'),
    scope: pointScope({ param: 'id' }, 'contracts.employeeScope', NF_CONTRACT),
    fields: noFields('只返回 { revision }（合同集合版本号），无业务字段'),
    invalidId: BAD_REQUEST,
  }),
  // loadContract 不存在 → 404「合同不存在」；checkScope(employeeId, createdBy) 范围外 → 404「合同数据不存在」
  'GET /records/:id': object({
    object: CONTRACT,
    operation: 'view',
    button: noButton('只读'),
    scope: pointScope({ param: 'id' }, 'contracts.record', NF_CONTRACT),
    fields: record,
    invalidId: BAD_REQUEST,
  }),
  // ---- registerCommands：单条 / 批量命令 ---------------------------------------------------------------------------
  // 顺序：checkFields(body.fields) → object.button（contractAction(operation, mode)）→ checkOperationScope（targetId 先
  // loadContract）→ write()；201 + 命令结果（direct 到期即生效的记录，否则申请）经逐 employeeId checkScope 与 trim
  'POST /commands': object({
    object: CONTRACT,
    operation: COMMAND_OPERATION,
    button: COMMAND_BUTTON,
    scope: pointScope({ body: 'employeeId' }, 'contracts.operationTarget', NF_CONTRACT),
    fields: record,
    write: contractCommand('contracts.fields+customFields'),
  }),
  // items 1～100，每项 { revision, command }；逐项同上三步后一次 write()（整体成功才提交，R1-T16）；200 { items }
  'POST /batch': object({
    object: CONTRACT,
    operation: BATCH_OPERATION,
    button: COMMAND_BUTTON,
    scope: pointScope({ body: 'items[*].command.employeeId' }, 'contracts.operationTarget', NF_CONTRACT),
    fields: record,
    rows: {
      path: 'items[*].command',
      operation: BATCH_OPERATION,
      button: COMMAND_BUTTON,
      fields: 'contracts.fields+customFields',
      target: { body: 'items[*].command.employeeId' },
      batch: 'atomic',
    },
    write: contractCommand({ rows: 'items[*].command' }),
  }),
  // ---- registerConfiguration：合同设置 / 续签规则（配置授权：tenant_admin 或 contractConfiguration）-----------------------
  'GET /settings': object({
    object: SETTINGS,
    operation: 'view',
    button: NO_CONFIG_BUTTON,
    scope: CONFIG_SCOPE,
    fields: shape('contracts.settings'),
  }),
  // saveSettings：咨询锁 → revision 比对 → verifyIds（合同类型引用）→ upsert → audit contract.settings.update
  'PUT /settings': object({
    object: SETTINGS,
    operation: 'update',
    button: NO_CONFIG_BUTTON,
    scope: CONFIG_SCOPE,
    fields: shape('contracts.settings'),
    write: auditedConfigWrite('contract.settings.update'),
  }),
  // { items }，超过 200 条规则 / 20000 条明细 → 413
  'GET /rules': object({
    object: RULE,
    operation: 'view',
    button: NO_CONFIG_BUTTON,
    scope: CONFIG_SCOPE,
    fields: shape('contracts.rule'),
  }),
  // module.on(path.endsWith(':id') ? 'PUT' : 'POST', path)：saveRule 内 200 条上限（413）、revision 比对、引用校验、
  // audit contract.rule.save；201
  'POST /rules': object({
    object: RULE,
    operation: 'create',
    button: NO_CONFIG_BUTTON,
    scope: CONFIG_SCOPE,
    fields: shape('contracts.rule'),
    write: auditedConfigWrite('contract.rule.save'),
  }),
  // uuidParam 在 requireObjectWrite 之前（routes.ts:286）；规则不存在 → 404「续签规则不存在」；200
  'PUT /rules/:id': object({
    object: RULE,
    operation: 'update',
    button: NO_CONFIG_BUTTON,
    scope: CONFIG_SCOPE,
    fields: shape('contracts.rule'),
    write: auditedConfigWrite('contract.rule.save'),
    invalidId: BAD_REQUEST,
  }),
  // ---- registerMasters：合同类型 / 法人公司（DEC-121 无归属对象，只认看全部）------------------------------------------
  'GET /master-data/types': masterList(TYPE),
  'POST /master-data/types': masterSave(TYPE, 'create'),
  'PUT /master-data/types/:id': masterSave(TYPE, 'update'),
  'GET /master-data/companies': masterList(COMPANY),
  'POST /master-data/companies': masterSave(COMPANY, 'create'),
  'PUT /master-data/companies/:id': masterSave(COMPANY, 'update'),
  // ---- registerImports：导入 / 预览 / 错误报告（按钮之后的校验共用 authorizeImport）---------------------------------------
  // withFailedImportLog 在步骤 0（rawImportRows）之后包住 authorizeImport + write()：格式 / 字段权 / 范围 / 删除权失败与
  // 10001 行超限都记任务级失败日志（failureCount = total，逐行 employeeId 归属）；rows 不是数组 → total 0 不记。
  // importContracts：整批先演练回滚，再逐行 createCommand（直接模式），任一行失败 → 400 / 409 整批回滚；200 { items, count }
  'POST /imports': object({
    ...importAdmission,
    fields: shape('contracts.importResult'),
    write: contractCommand({ rows: 'rows[*]' }),
    failureAudit: { kind: 'import', rows: 'rows', objectType: CONTRACT, anchors: 'contracts.importAnchors' },
  }),
  // previewImport 在同一事务内演练后回滚（> 3000 行 → 400）；逐行前提失败成为 errors[*]，lockEmployee / initializePeople 的
  // 失败仍是 HTTP 错误；不包装失败导入日志（现状，§3.6）
  'POST /imports/preview': object({
    ...importAdmission,
    fields: fixed(
      ['valid', 'count', 'errors'],
      'imports.ts previewImport 返回值；errors[*]：row / code / message / details',
    ),
    write: write(
      { rows: 'rows[*]' },
      none('只读预览：previewImport 演练后回滚，不进命令台账'),
      none('只读预览：无返回后复核，响应不经 trim'),
      { preconditions: COMMAND_PRECONDITIONS },
    ),
  }),
  // 任一行格式不合法 → 直接下载格式错误 CSV（不经 authorizeImport）；否则 authorizeImport + 演练后下载业务错误 CSV
  // （行号 / 错误码 / 原因，errorsCsv）；下载记录单独事务写对象操作日志（recordOperationLog，R1-T16），不进命令台账
  'POST /imports/errors': object({
    ...importAdmission,
    fields: projector('contracts.importErrorsCsv', 'contracts.importErrors', 'text/csv'),
    write: write(
      { rows: 'rows[*]' },
      none('错误报告下载是读取，不进命令台账；下载操作日志在处理函数内单独事务写入'),
      none('无返回后复核；CSV 只有行号 / 错误码 / 原因，无合同字段值'),
      { preconditions: COMMAND_PRECONDITIONS },
    ),
  }),
  // ---- registerFailures：撤销失效申请 / 失败任务 / 申请详情 ------------------------------------------------------------
  // 顺序：uuidParam → body 必须为 {}（strictObject）→ requireObjectWrite(update, {}) → withdraw@detail → loadRequest +
  // checkScope(employeeId, createdBy)；命令内 cancelFailedRequest：lockEmployee、FOR UPDATE、再 checkScope、revision、
  // 「可撤销」判定（隔离冲突或到期生效失败，否则 409 CONFLICT / CONTRACT_NOT_FAILED）、隔离分支经 approval cancel → openRun
  'POST /requests/:id/cancel': object({
    object: CONTRACT,
    operation: 'update',
    button: button('withdraw', 'detail'),
    scope: pointScope({ param: 'id' }, 'contracts.request', NF_CONTRACT),
    fields: record,
    invalidId: BAD_REQUEST,
    write: commandWrite(MASTER_SCOPE, RESULT_EMPLOYEES, {
      preconditions: ['lockEmployee', 'revision', 'openRun'],
      ledger: 'single',
    }),
  }),
  // contract_job_attempts（failed / unknown）按 employmentVisibilitySql 过滤（employee = a.employee_id，creator 为申请 / 记录
  // 的创建人子查询）；`SELECT a.*` 不经 trim，无合同业务值（DEC-052 定时任务失败记录）
  'GET /failures': object({
    object: CONTRACT,
    operation: 'view',
    button: noButton('只读'),
    scope: listScope(EMPLOYEE_VISIBILITY),
    fields: fixed(
      [
        'id',
        'tenant_id',
        'object_id',
        'employee_id',
        'kind',
        'attempt_count',
        'state',
        'error',
        'command_id',
        'created_at',
      ],
      'DEC-052；routes.ts:479 SELECT a.* FROM contract_job_attempts，无合同业务字段',
    ),
  }),
  // loadRequest 不存在 → 404「合同申请不存在」；checkScope(employeeId, createdBy) 范围外 → 404「合同数据不存在」
  'GET /requests/:id': object({
    object: CONTRACT,
    operation: 'view',
    button: noButton('只读'),
    scope: pointScope({ param: 'id' }, 'contracts.request', NF_CONTRACT),
    fields: record,
    invalidId: BAD_REQUEST,
  }),
  // ---- todos.ts registerMergedTodos：合同待办批量（逐单回执，HTTP 恒 200）-----------------------------------------------
  // routeContext(write = true) 不查任何对象权限；Idempotency-Key 须 ≤ 60 字符（400 VALIDATION_FAILED），命令 ID = key:index；
  // 逐项：instanceOfTask（resubmit 用 item.id 作实例）→ loadInstance → businessType ≠ contract → 404「合同待办不存在」
  // （contracts.todoIsContract）→ resubmit 查 requireResubmitRight（原发起人 403 APPROVAL_NOT_INITIATOR + contract 分支：
  // 按钮 + checkOperationScope + checkFields(requestWriteFields(request) + corrections)），其余查当前审批人（403 FORBIDDEN
  // 「只有当前审批人可以处理该任务」）；AppError 一律成为回执行（status + error），非 AppError 才抛出。台账只计实际新增并提交的
  // 命令（含盲审 403 Outcome 行；预检失败行、命令内抛错回滚行与重放不计）
  // 关系按 action 分支，预设 relation() 只收字符串，这里直接写字面量
  'POST /todos/batch': {
    kind: 'relation',
    relation: TODO_RELATION,
    target: { body: 'items[*].id' },
    denied: FORBIDDEN,
    guards: ['contracts.todoIsContract', 'approval.resubmitRight'],
    rows: {
      path: 'items[*]',
      relation: TODO_RELATION,
      fields: none('comment 是审批意见，不是对象字段；批量重提不带更正字段'),
      target: { body: 'items[*].id' },
      batch: 'receipt',
    },
    fields: fixed(
      ['id', 'status', 'result', 'error'],
      'todos.ts:89–92 逐单回执：result = Outcome.body（{ instanceId } 或盲审 403 错误体），error = { code, message, reason? }',
    ),
    write: write(
      none('审批意见与 revision 不是字段；盲审按 ctx.fields.viewable 的合同查看字段判定'),
      'approval.commandInstance',
      none('返回后无复核：回执只含 instanceId 或错误体，无业务字段'),
      { preconditions: TODO_PRECONDITIONS, ledger: 'perItem' },
    ),
  },
});
