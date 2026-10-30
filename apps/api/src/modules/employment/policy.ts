/**
 * 任职模块路由的现状声明（F-039 PR-A；附录 A「/api/tenant/employment」46 条：任职记录版本链 + 调动 + 联动 + 经理待办）。
 * 子应用挂在 /api/tenant/employment，键用本地路径；employment/routes.ts、transfer/routes.ts、transfer/manager-routes.ts、
 * transfer/linkage/routes.ts 四个文件注册进同一个子应用（policedSub）。
 *
 * 现状脉络（§3.2 对照表）：
 * - readContext / readPageContext：object.<op> on 对象（EmploymentRecord / Employee / 两个配置对象）；带 resource 的入口先按
 *   人员范围判（scopeAllowsInTransaction）→ 404「任职数据不存在」，看全部用户（data.scope.all）再查 tenant.employment.read /
 *   write 别名（trustedScopeBypass）；配置对象不解析范围，授权器 CONFIG_OBJECTS 分支按 admin.other_settings 判定。
 * - requireEmploymentWrite：写字段 = 顶层元数据 ∪ fields ∪ custom:<id>（'body.fields+customFields'）；Submit / Withdraw /
 *   Revoke / RetryActivation 允许空集合（commandOnly）；按钮 Employment.Import / Employee.Create 为 list 级，其余 detail 级。
 * - runWrite：命令事务内与返回后各跑一次 authorizeEmploymentResult（登记 employment.result），它对非 EmploymentRecord 对象
 *   （Employee / 配置对象）直接返回；响应经 trimEmploymentResponse（投影器 employment.response；Employee / 配置对象走
 *   trimModuleResponse 平铺裁剪）。
 * - 范围：列表用 employmentScopePredicate = scopeSql（module.scopeSql，写入口径）或 employmentVisibilitySql
 *   （employment.visibility，DEC-177）；单条用 loadEmploymentBusiness / loadEmploymentRecord / getEmployee（定位器
 *   employment.business / record / employee）；写入口 requireScopedEmploymentObject（employment.directOperation，DEC-193）、
 *   联动改写 requireLinkedEmploymentRecord（employment.linkage，DEC-178，404 LINKED_RECORD_OUT_OF_SCOPE）。
 * - Denial.reason 登记的是现状 AppError 文案（这些错误没有 details.reason），用于区分同码不同入口。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * 1. GET /transfers/manager/references/:field：附录「无按钮」；代码 requireTransferSource(manager)（manager-routes.ts:160 →
 *    access.ts:48）内 requireTransferButton 要求 Transfer.Manager(detail)，登记 button。
 * 2. POST /transfers/employees/:id/preview：附录「无按钮」；previewTransfer → requireTransferSource(initiator)（preview.ts:17）
 *    要求发起按钮，登记 mapper transfer.initiatorButton；范围 = 源员工 404「员工不存在」+ 目标部门 404「任职数据不存在」
 *    （preview.ts:27）。
 * 3. PUT /transfers/:id/linkage：附录「无按钮」；requireLinkageSource → requireTransferSource(单据 initiator ?? 'hr')
 *    （linkage/service.ts:82–90）要求对应发起按钮，登记 mapper transfer.initiatorButton（initiator 取自 transfer_requests；
 *    employee 单据先 400 TRANSFER_LINKAGE_NOT_ALLOWED）。
 * 4. PUT /transfers/forms/:formId：附录 all[admin, object]；代码只有 configurationContext(write) 的 admin 别名，没有
 *    requireEmploymentWrite（transfer/routes.ts:183–199），登记 admin；formId 长度 1–100 校验 → 400（routes.ts:194）登记 invalidId。
 * 5. GET /completion-todos、GET /activation-todos：附录 list employment.visibility；代码 employmentScopePredicate = scopeSql
 *    （completion.ts:61、activation-store.ts:289），登记 module.scopeSql。
 * 6. GET /employees/:id、POST /employees/:id/preview、POST /employees/:id/forward-update-preview、
 *    POST /employees/:id/import(*)：
 *    readContext 带 resource 先按人员范围判 → 404「任职数据不存在」（context.ts:65–71）；「员工不存在」只在看全部 / 范围内且
 *    员工不存在时出现（employees.ts:117–119），denied 登记为「任职数据不存在」。
 * 7. POST /records/:id/forward-update-preview：附录只有 point employment.business；editedValues 内
 *    requireScopedEmploymentObject
 *    （record-edit.ts:46–47）按 DEC-193 复核 → 补 guard employment.directOperation；loadEmploymentRecord 取不到 → 409 CONFLICT
 *    「只能预览有效任职记录的编辑」（forward-preview.ts:80）。
 * 8. POST /employees/:id/import 与 import 预览：逐行操作域是 create / edit（forward-import.ts:17–25），不是附录的 create / update。
 * 9. POST /businesses/:id/withdraw、/revoke、DELETE /businesses/:id：附录「commandOnly（submit 空体校验）」；emptySubmitBody 只在
 *    submit（routes.ts:313），其余不读请求体。
 * 10. GET /transfers/manager/reporting：附录 shape transfer.reporting；登记 fixed(id / directManagerId / dottedManagerId) ∩
 *    EmploymentRecord 字段权（manager-routes.ts:84–89，§3.5 fixed.intersect）。
 * 11. PATCH /businesses/:id 与 submit / withdraw / revoke / DELETE：调动单的 transferBusinessContext →
 *    requireManagerBusinessSource
 *    （service.ts:217；access.ts:106–131）：非 HR、非本人、无经理身份 → 403「需要经理自助身份」，经理 → requireTransferSource(manager)；
 *    附录范围列未提，补 guard transfer.source。
 * 12. POST /employees：see-all 判定 requireEmploymentScope 在命令前（routes.ts:114），authorizeEmploymentResult 对 Employee 对象
 *    直接返回（employment-replay.ts:43）；footprint / result 仍按附录登记 §10.3 的 employment.employeeCreate / generic（待设计守卫名），
 *    现状事务内 / 返回后都没有复核。
 */
import {
  APPROVAL_INSTANCE_OBJECT,
  CONTRACT_OBJECT,
  EXIT_BUTTONS,
  RETIREMENT_BUTTONS,
  RETIREMENT_INTENTION_BUTTON,
  MODULE_OBJECTS,
  PART_TIME_BUTTONS,
} from '@italent/domain';
import {
  type ButtonPolicy,
  defineTable,
  type FieldsFrom,
  type FieldsPolicy,
  type PolicyBase,
  type RoutePolicy,
  type RowsPolicy,
  type ScopePolicy,
  type WritePolicy,
} from '../../route-policy/index.js';
import {
  admin,
  all,
  any,
  BAD_REQUEST,
  button,
  buttonOnly,
  commandWrite,
  denied,
  EMPTY_LIST,
  fixed,
  guardScope,
  listScope,
  noButton,
  noFields,
  none,
  noScope,
  object,
  own,
  pointScope,
  projector,
  relation,
  seeAll,
  shape,
  write,
  type WriteExtra,
} from '../../route-policy/presets.js';
import type { TransferInitiator } from '../transfer/access.js';

// ---- 对象 ----------------------------------------------------------------------------------------------------
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;
const EMPLOYEE = MODULE_OBJECTS.employee.code;
const SETTINGS = MODULE_OBJECTS.employmentSettings.code;
const CUSTOM_FIELD = MODULE_OBJECTS.employmentCustomField.code;
const BLACKLIST = MODULE_OBJECTS.blacklist.code;
const ASSESSMENT = MODULE_OBJECTS.probationAssessment.code;

// ---- 拒绝码（reason = 现状文案）---------------------------------------------------------------------------------
const NF_EMPLOYEE = denied(404, 'NOT_FOUND', '员工不存在');
const NF_DATA = denied(404, 'NOT_FOUND', '任职数据不存在');
const NF_BUSINESS = denied(404, 'NOT_FOUND', '任职业务不存在');
const NF_RECORD = denied(404, 'NOT_FOUND', '任职记录不存在');
const NF_TRANSFER = denied(404, 'NOT_FOUND', '调动不存在');
const NF_PART_TIME = denied(404, 'NOT_FOUND', '兼职记录不存在');
const NF_PART_TIME_REQUEST = denied(404, 'NOT_FOUND', '兼职申请不存在');
const NF_LINKAGE_ITEM = denied(404, 'NOT_FOUND', '联动子项不存在');
const F_UNBOUND = denied(403, 'FORBIDDEN', '当前用户未绑定员工');
const F_NO_DEPARTMENT = denied(403, 'FORBIDDEN', '无权选择调动部门');
const NF_BLACKLIST = denied(404, 'NOT_FOUND', '黑名单记录不存在');
const NF_ASSESSMENT = denied(404, 'NOT_FOUND', '考核记录不存在');
const NF_INTENTION = denied(404, 'NOT_FOUND', '意向退休申请不存在');
const NF_HANDOVER = denied(404, 'NOT_FOUND', '离职交接申请不存在');
const F_HANDOVER_NOT_ASSIGNEE = denied(403, 'FORBIDDEN', 'EXIT_HANDOVER_NOT_ASSIGNEE');
const F_BLACKLIST = denied(403, 'FORBIDDEN', '黑名单只对有“看全部”数据权限的人员开放');
/** `job/context.uuidParam`：路径标识非 UUID → 400 VALIDATION_FAILED「对象标识必须为 UUID」。 */
const byId = { invalidId: BAD_REQUEST };

// ---- 登记名 ----------------------------------------------------------------------------------------------------
/** runWrite：命令事务内 + 返回后各一次 authorizeEmploymentResult（permission/employment-replay.ts）。 */
const EMPLOYMENT_RESULT = 'employment.result';
/** authorizeBusinessWrite：loadEmploymentBusiness 写入口径（transferTarget 例外时不带范围）+ trustedScopeBypass 的写别名。 */
const BUSINESS_WRITE = guardScope('employment.businessWrite', NF_BUSINESS);
/** managerContext：managerIdentity 不活跃 → 403 FORBIDDEN「需要经理自助身份」。 */
const MANAGER_IDENTITY = 'transfer.managerIdentity';
/** requireTransferSource：发起按钮 + 绑定规则（403）+ 源员工范围（404「员工不存在」）+ 经理团队（403）。 */
const TRANSFER_SOURCE = 'transfer.source';
/** requireScopedEmploymentObject：直接操作按写入口径（记录部门 ∧ 员工当前任职都在范围内），DEC-193。 */
const DIRECT_OPERATION = 'employment.directOperation';
/** requireLinkedEmploymentRecord：联动改写的后续记录按 DEC-177 可见即可改写，否则 404 LINKED_RECORD_OUT_OF_SCOPE（DEC-178）。 */
const LINKAGE = 'employment.linkage';

const RESPONSE = projector('employment.response', 'employment.response');
const SETTINGS_FIELDS = shape('employment.settings');
const CUSTOM_FIELD_FIELDS = shape('employment.customField');
/** BE-8b2 离职交接的三个固定回执形状（exit-handover.ts 的 exitHandoverStatus / handoverDetail / tickHandoverItem）。 */
const HANDOVER_STATUS_KEYS = ['status', 'request'] as const;
const HANDOVER_DETAIL_KEYS = [
  'id',
  'exitRequestId',
  'employeeId',
  'status',
  'endReason',
  'notLaunchedReason',
  'hint',
  'approvalInstanceId',
  'revision',
  'items',
  'mine',
] as const;
const HANDOVER_TICK_KEYS = ['item', 'mine'] as const;
const EXIT_DICTIONARY_KEYS = ['id', 'code', 'name', 'enabled', 'displayOrder', 'revision'] as const;
const PROBATION_RESULT_KEYS = EXIT_DICTIONARY_KEYS;
const RETIREMENT_IDENTITY_TYPE_KEYS = EXIT_DICTIONARY_KEYS;
/** retirement-rules.ts RetirementRuleView 的响应键。 */
const RETIREMENT_RULE_KEYS = [
  'id',
  'purpose',
  'ruleType',
  'name',
  'priority',
  'orgIds',
  'allOrgs',
  'preset',
  'includeSubordinates',
  'retirementAgeYears',
  'retirementAgeMonths',
  'expectedFunction',
  'earliestFunction',
  'latestFunction',
  'conditions',
  'enabled',
  'revision',
] as const;
/** 黑名单记录 / 列表 / 回执按黑名单对象的字段查看权平铺裁剪（blacklist-routes.ts trimBlacklist）。 */
const BLACKLIST_FIELDS = projector('employment.blacklist', 'employment.blacklist');
/** 选人员加黑：该员工须在操作人的任职数据范围内（requireEmployeeInScope，范围外与不存在同一个 404「员工不存在」）。 */
const BLACKLIST_EMPLOYEE = 'employment.blacklistEmployeeScope';
/**
 * 黑名单写入：权限链（数据操作 + 字段 / 按钮 / 看全部 / 选人员范围）在 CommandGuard.before 内按当前权限复核
 * （requireBlacklistWrite，#199），审计 blacklist.* 同事务；无组织字段，返回后只按字段查看权投影。
 */
function blacklistWrite(fields: FieldsFrom, preconditions: readonly string[], commandOnly = false) {
  return write(fields, 'employment.blacklistGuard', none('黑名单只认看全部，命令内已复核，返回后只投影'), {
    preconditions,
    ...(commandOnly ? { commandOnly } : {}),
  });
}
function blacklistPolicy(
  operation: 'view' | 'create' | 'update' | 'delete',
  buttonRef: ButtonPolicy,
  scope: ScopePolicy,
  extra: PolicyBase = {},
): RoutePolicy {
  return object({ object: BLACKLIST, operation, button: buttonRef, scope, fields: BLACKLIST_FIELDS, ...extra });
}

/** 调动发起人 → 按钮：hr → Transfer.Hr、manager → Transfer.Manager、employee → Transfer.Self（detail；access.ts ROLE_BUTTONS）。 */
const TRANSFER_INITIATORS = ['hr', 'manager', 'employee'] as const satisfies readonly TransferInitiator[];
const INITIATOR_BUTTON: ButtonPolicy = {
  from: 'mapper',
  mapper: 'transfer.initiatorButton',
  domain: TRANSFER_INITIATORS,
};

/**
 * 兼职申请的提交 / 撤回（PT-4b）：两项缺一不可 —— 与创建同一按钮 Employment.PartTimeApproval（承载对象权、范围、字段）+ 动作按钮；
 * 请求体不读，If-Match 必填。
 */
function partTimeRequestAction(actionButton: string, preconditions: readonly string[]) {
  return all(
    [
      object({
        object: EMPLOYMENT,
        operation: 'update',
        button: button(PART_TIME_BUTTONS.application, 'detail'),
        guards: [DIRECT_OPERATION],
        scope: guardScope('employment.scope', NF_PART_TIME_REQUEST),
        fields: RESPONSE,
      }),
      object({
        object: EMPLOYMENT,
        operation: 'button',
        button: button(actionButton, 'detail'),
        scope: noScope('只判按钮：申请范围已由创建按钮那一项判过'),
        fields: noFields('只决定能否执行该动作'),
      }),
    ],
    RESPONSE,
    { write: employmentCommand(preconditions), ...byId },
  );
}

// ---- 写策略 ----------------------------------------------------------------------------------------------------
/** 任职对象的写入口：字段经 requireEmploymentWrite 提取，事务内 / 返回后各一次 authorizeEmploymentResult。 */
function employmentWrite(fields: FieldsFrom, preconditions: readonly string[], extra: WriteExtra = {}) {
  return write(fields, EMPLOYMENT_RESULT, EMPLOYMENT_RESULT, { preconditions, ...extra });
}
/**
 * 命令式按钮（submit / withdraw / revoke / delete / 两个 retry）：requireEmploymentWrite 以空字段集合校验按钮与操作
 * （§3.3 commandOnly：按钮允许空集合），命令内前提逐个登记。
 */
function employmentCommand(preconditions: readonly string[]) {
  return write('body.fields+customFields', EMPLOYMENT_RESULT, EMPLOYMENT_RESULT, { commandOnly: true, preconditions });
}
/** 只读预览（POST）：不开命令事务，不写入；输入仍经 requireEmploymentWrite 按字段编辑权校验，响应经 trimEmploymentResponse 裁剪。 */
const previewWrite = write(
  'body.fields+customFields',
  none('只读预览：没有命令事务，没有提交前足迹'),
  none('只读预览：没有返回后复核，响应经 trimEmploymentResponse 裁剪'),
);
/**
 * 配置写入口：requireEmploymentWrite 把配置 DTO 顶层键交给 requireObjectWrite（授权器 CONFIG_OBJECTS 分支按字段目录判），
 * 事务内 assertRevision，审计对象类型见 auditEmployment 调用；配置对象无范围，返回后只投影。
 */
function auditedConfigWrite(auditType: string, fields: FieldsFrom = 'body') {
  return write(fields, `config.audited:${auditType}`, none('配置对象无范围，返回后只投影'), {
    preconditions: ['assertRevision'],
  });
}

// ---- 配置类（§2.4：别名 tenant.employment.configuration.write 用 all([admin(other_settings, alias), object(op)]) 保留）----
function configuration(
  objectCode: string,
  operation: 'create' | 'update',
  fields: FieldsPolicy,
  writePolicy: WritePolicy,
  extra: PolicyBase = {},
): RoutePolicy {
  return all(
    [
      admin('other_settings', { alias: 'tenant.employment.configuration.write', fields }),
      object({
        object: objectCode,
        operation,
        button: noButton(
          '配置对象无按钮：requireEmploymentWrite 只查 object.<op> + 字段目录（authorizer CONFIG_OBJECTS）',
        ),
        scope: noScope('配置对象无数据范围（readContext 对配置对象不解析 scope）'),
        fields,
      }),
    ],
    fields,
    { write: writePolicy, ...extra },
  );
}
/** 配置对象的查看：readContext('object.view')，授权器按 admin.other_settings 判定；无范围。 */
function configurationView(objectCode: string, fields: FieldsPolicy): RoutePolicy {
  return object({
    object: objectCode,
    operation: 'view',
    button: noButton('配置对象查看无按钮'),
    scope: noScope('配置对象无数据范围'),
    fields,
  });
}

/**
 * 立即执行回执的人员披露（BE-15a 第 4 轮审查 P2）：可选分支，只决定回执列出哪些员工、不参与准入、不拒绝请求——
 * visibleEmployees 先判任职记录查看权（object.view），没有时 launched / failed 两列为空；有时再按数据范围逐人过滤
 * （employment.runReceipt，与准入节点上的范围同一裁剪）。逐人条目是固定键，不含任职字段值。
 */
const RUN_RECEIPT_DISCLOSURE = object({
  object: EMPLOYMENT,
  operation: 'view',
  button: noButton('回执披露只取任职记录查看权与数据范围'),
  scope: listScope('employment.runReceipt'),
  fields: fixed(
    ['employeeId', 'ruleId', 'businessId', 'businessStatus', 'initiatorUserId', 'reason'],
    'BE-15a 第 2 轮审查 P1：立即执行回执的逐人固定键',
  ),
});

/** 退休规则立即执行回执的人员披露（BE-5c2）：同上，逐人条目是固定键（员工、规则、写入的人事字段名、失败原因），不含日期值。 */
const RETIREMENT_RUN_RECEIPT_DISCLOSURE = object({
  object: EMPLOYMENT,
  operation: 'view',
  button: noButton('回执披露只取任职记录查看权与数据范围'),
  scope: listScope('employment.runReceipt'),
  fields: fixed(['employeeId', 'ruleId', 'fields', 'reason'], 'BE-5c2：退休规则立即执行回执的逐人固定键'),
});

// ---- 经理待办固定键（§3.5；manager-routes.ts registerManagerTodos）----------------------------------------------------
/** tab=pending（默认）：approval/queries.ts listTodos（本人为待办人 assignee_user_id）。 */
const TODO_PENDING_KEYS = [
  'taskId',
  'instanceId',
  'title',
  'approvalType',
  'nodeKey',
  'nodeName',
  'isExceptionAdmin',
  'origin',
  // R2-T03 §9 合并待办：批量离职申请的批次号
  'batchId',
  'createdAt',
] as const;
/** tab=initiated：listInstances(role=initiated)（本人为 initiator_user_id）。 */
const TODO_INITIATED_KEYS = [
  'id',
  'title',
  'status',
  'approvalType',
  'businessId',
  'currentNodeKey',
  'revision',
  'createdAt',
] as const;
/** tab=processed：本人有 approve / reject / disagree / transfer 日志的实例（排除待办、抄送、自审跳过与管理员操作）。 */
const TODO_PROCESSED_KEYS = ['id', 'title', 'status', 'createdAt'] as const;
const managerTodoTab = (predicate: string, keys: readonly string[], source: string): RoutePolicy =>
  own({ predicate, fields: fixed(keys, `§3.5 固定键（${source}）`) });

// ---- 任职导入逐行策略（forward-import.ts normalizeEmploymentImport：items[*].operation ∈ create / edit）------------------
/**
 * 导入：create 行取 items[*].business（元数据 ∪ fields ∪ customFields）经 requireEmploymentWrite('create', Employment.Create)，
 * edit 行取 items[*].patch 经 requireEmploymentWrite('update', Employment.Edit) + authorizeBusinessWrite（写入口径）；
 * 任一行失败整批 4xx（整批回滚，无逐行回执）。
 */
const IMPORT_ROWS: RowsPolicy = {
  path: 'items[*]',
  operation: { from: 'body', path: 'items[*].operation', map: { create: 'create', edit: 'update' } },
  button: {
    from: 'body',
    path: 'items[*].operation',
    map: { create: button('Employment.Create', 'detail'), edit: button('Employment.Edit', 'detail') },
  },
  fields: 'body.fields+customFields',
  target: { param: 'id' },
  batch: 'atomic',
};
/** 导入预览：同一逐行分支，但不查按钮与字段权，只查范围（authorizeImport(preview=true)）。 */
const IMPORT_PREVIEW_ROWS: RowsPolicy = {
  path: 'items[*]',
  operation: { from: 'body', path: 'items[*].operation', map: { create: 'view', edit: 'view' } },
  fields: none('只读预览：逐行不查按钮与字段权（authorizeImport preview=true），只查范围'),
  target: { param: 'id' },
  batch: 'atomic',
};

// ---- R2-T03 B2b 离职办理入口（employment/exit-routes.ts）------------------------------------------------------------
/** 新建离职的按钮按办理方式：direct → Dimission、application → DimissionApproval（exit-gate.ts permissionSpec）。 */
const EXIT_CREATE_BUTTON: ButtonPolicy = {
  from: 'mapper',
  mapper: 'employment.exitButton',
  domain: ['application', 'direct'],
};
const EXIT_CREATE_PRECONDITIONS = ['lockEmploymentEmployee', 'requireExitGate', 'assertRevision'];
const EXIT_PREVIEW_KEYS = ['lastWorkDate', 'effectiveDate', 'blockers', 'ack', 'warnings'] as const;
const exitPreview = (code: string) =>
  object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button(code, 'detail'),
    scope: pointScope({ param: 'id' }, 'employment.employee', NF_DATA),
    fields: fixed(EXIT_PREVIEW_KEYS, 'R2-T03 设计 §4 preview：固定键，清单逐项按可见性与字段查看权披露'),
    write: write(
      'body',
      none('只读预览：没有命令事务，没有提交前足迹'),
      none('只读预览：清单已按可见性与字段查看权披露'),
    ),
    ...byId,
  });
/** 兼职新增预览：功能权是 object.create（§7.2），新增兼职 / 新增兼职申请两个按钮任一（requirePartTimePreviewButton）。 */
const partTimePreview = (code: string) =>
  object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button(code, 'detail'),
    scope: pointScope({ param: 'id' }, 'employment.employee', NF_DATA),
    fields: RESPONSE,
    write: previewWrite,
    ...byId,
  });
/** 新建退休的按钮按办理方式：direct → Retire、application → RetireApproval（exit-gate.ts permissionSpec，buttonsOf(kind)）。 */
const RETIREMENT_CREATE_BUTTON: ButtonPolicy = {
  from: 'mapper',
  mapper: 'employment.retirementButton',
  domain: ['application', 'direct'],
};
const exitTransition = (code: string = EXIT_BUTTONS.application) =>
  object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(code, 'detail'),
    // 状态迁移改写后续记录前按 DEC-178 复核（同通用 submit / withdraw）
    guards: [LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand(['lockEmploymentBusiness', 'assertRevision', 'assertTransition', 'requireExitGate']),
    ...byId,
  });

const ACCOUNT_SETTINGS_FIELDS = fixed(['revision', 'earlyEnabled', 'basis', 'time', 'inReview'], 'DEC-684');
const ACCOUNT_TASK_FIELDS = fixed(
  ['items', 'nextCursor', 'businessId', 'employeeId', 'status', 'reason', 'revision', 'attempts', 'recipientUserIds'],
  'DEC-684',
);
const accountTaskView = object({
  object: EMPLOYMENT,
  operation: 'view',
  button: noButton('待办查询无需业务按钮'),
  scope: guardScope('employment.scope', denied(404, 'NOT_FOUND', '账号处理任务不存在')),
  fields: ACCOUNT_TASK_FIELDS,
});

export const EMPLOYMENT_POLICIES = defineTable('employment', {
  'GET /exit-account/settings': configurationView(SETTINGS, ACCOUNT_SETTINGS_FIELDS),
  'PUT /exit-account/settings': admin('other_settings', {
    alias: 'tenant.employment.configuration.write',
    fields: ACCOUNT_SETTINGS_FIELDS,
    write: write(none('严格配置 DTO'), 'config.audited:employment_settings', none('租户配置无人员范围'), {
      preconditions: ['assertRevision'],
      ledger: 'single',
    }),
  }),
  'GET /exit-account/tasks': { ...accountTaskView, scope: listScope('employment.accountTasks') },
  'GET /exit-account/tasks/:id': { ...accountTaskView, ...byId },
  'POST /exit-account/tasks/:id/retry': admin('user_manage', {
    ...byId,
    fields: fixed(['businessId', 'status', 'revision'], 'DEC-684：账号权限回执不含员工资料'),
    write: write(none('原任务重试，空请求体'), none('账号管理能力；任务限定当前租户'), none('固定最小回执'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
      ledger: 'single',
    }),
  }),

  // ---- transfer/routes.ts registerPersonalEntry：本人调动入口 ------------------------------------------------------
  // requireTransferButton(employee) 先查 Transfer.Self；绑定员工缺失 → 403「当前用户未绑定员工」；requireTransferSource
  // (employee) 再按绑定本人为源员工判范围（范围外 404「员工不存在」）；items 固定 id / name / code / revision，不按字段权裁剪
  'GET /transfers/self': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Transfer.Self', 'detail'),
    scope: guardScope(TRANSFER_SOURCE, F_UNBOUND),
    fields: fixed(['id', 'name', 'code', 'revision'], '§3.5 固定键（transfer/routes.ts registerPersonalEntry）'),
  }),
  // 调动目录（类型 / 原因 / 表单）无范围；只有 query.initiator=employee 时经 requireTransferButton 查 Transfer.Self(detail)
  // 并把表单换成 Personal 版（其余取值 / 缺省不查按钮，附上 viewableFields / editableFields）
  'GET /transfers/catalog': object({
    object: EMPLOYMENT,
    operation: 'view',
    // 只有 initiator=employee 时校验 Transfer.Self；hr / manager / 缺省不校验按钮（mapper 决定，域 = 三种发起人）
    button: { from: 'mapper', mapper: 'transfer.catalogButton', domain: TRANSFER_INITIATORS },
    scope: noScope('调动目录是租户字典（readTransferCatalog），不查数据范围'),
    fields: projector('transfer.catalog', 'transfer.catalog'),
  }),
  // ---- transfer/manager-routes.ts：经理自助（managerContext = readPageContext(detail) + managerIdentity）----------
  // canApply / canViewReporting 只是 Transfer.Manager / Transfer.Hr 的布尔披露，不作准入；identity 恒为 department_manager
  'GET /transfers/manager': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('canApply / canViewReporting 只披露按钮判定结果，不作准入'),
    // 披露分支：两个布尔各按 Transfer.Manager / Transfer.Hr 按钮判定，不参与准入
    optional: {
      canApply: object({
        object: EMPLOYMENT,
        operation: 'button',
        button: button('Transfer.Manager', 'detail'),
        scope: noScope('只判按钮'),
        fields: noFields('只决定 canApply'),
      }),
      canViewReporting: object({
        object: EMPLOYMENT,
        operation: 'button',
        button: button('Transfer.Hr', 'detail'),
        scope: noScope('只判按钮'),
        fields: noFields('只决定 canViewReporting'),
      }),
    },
    guards: [MANAGER_IDENTITY],
    scope: noScope('只做经理身份判定（managerIdentity），不查数据范围'),
    fields: fixed(['identity', 'canApply', 'canViewReporting'], '§3.5 固定键'),
  }),
  // 候选下属（candidates=true，无 search 时 items 为空）：readManagerTeam 按负责组织 ∩ 组织范围过滤；键固定后再 ∩ Employee 字段权
  'GET /transfers/manager/employees': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Transfer.Manager', 'detail'),
    guards: [MANAGER_IDENTITY],
    scope: listScope('transfer.managerTeam'),
    fields: fixed(['id', 'name', 'code', 'revision'], '§3.5 固定键 ∩ Employee 字段权', EMPLOYEE),
  }),
  // 团队列表 / 搜索：行按 Employee（name / code / id / revision）、EmployeeInformation（email / mobilePhone）、
  // EmploymentRecord（其余）三个对象的字段权裁剪，category / leaving / probation 为协议键；managerRowLabels 只装饰已裁剪行
  'GET /transfers/manager/team': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('团队列表无按钮'),
    guards: [MANAGER_IDENTITY],
    scope: listScope('transfer.managerTeam'),
    fields: projector('transfer.managerRows', 'transfer.managerRows'),
  }),
  'GET /transfers/manager/search': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('团队搜索无按钮'),
    guards: [MANAGER_IDENTITY],
    scope: listScope('transfer.managerTeam'),
    fields: projector('transfer.managerRows', 'transfer.managerRows'),
  }),
  // 参照：:field 须在 EmploymentRecord 可见字段内且表单模式 editable / readonly（否则 403「无权查看调动参照」）；
  // query.employeeId 经 requireTransferSource(manager)（按钮 Transfer.Manager、本人 403、源范围 404、团队 403）；
  // departmentId / postId 不在负责组织内 → 403「调动参照不在可选范围」；query 非法（UUID / formId）→ 400「调动参照参数不合法」
  'GET /transfers/manager/references/:field': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Transfer.Manager', 'detail'),
    guards: [MANAGER_IDENTITY, 'transfer.referenceField', TRANSFER_SOURCE],
    scope: listScope('transfer.managerReferences'),
    fields: fixed(['id', 'name'], 'DEC-205：参照只披露 id / name'),
    invalidId: BAD_REQUEST,
  }),
  // 经理待办：tab（query，默认 pending，域 pending / initiated / processed，非法 → 400「待办分类不合法」）选择本人谓词与固定键；
  // 三个分支互斥、都不拒绝，只决定处理函数的查询分支，故 initiated / processed 登记为 optional 分支
  'GET /transfers/manager/todos': all(
    [
      object({
        object: EMPLOYMENT,
        operation: 'view',
        button: noButton('经理待办只按经理身份与本人过滤'),
        guards: [MANAGER_IDENTITY],
        scope: noScope('按 own 谓词过滤本人的审批任务 / 实例，不查任职数据范围'),
        fields: noFields('出口固定键在组合层与 optional 分支按 tab 登记'),
      }),
      managerTodoTab('approval.recipient', TODO_PENDING_KEYS, 'listTodos，tab=pending 默认分支'),
    ],
    fixed(TODO_PENDING_KEYS, '§3.5 固定键（tab=pending 默认分支）'),
    {
      optional: {
        initiated: managerTodoTab(
          'approval.initiatedOrParticipated',
          TODO_INITIATED_KEYS,
          'listInstances role=initiated',
        ),
        processed: managerTodoTab('approval.processedByMe', TODO_PROCESSED_KEYS, 'approval_instance_logs 本人操作'),
      },
    },
  ),
  // 汇报关系：另需 Transfer.Hr（managerHasHr，否则 403「需要人事身份」）；行只留 id / directManagerId / dottedManagerId 且须可见
  'GET /transfers/manager/reporting': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Transfer.Hr', 'detail'),
    guards: [MANAGER_IDENTITY],
    scope: listScope('transfer.managerTeam'),
    fields: fixed(['id', 'directManagerId', 'dottedManagerId'], '§3.5 固定键 ∩ EmploymentRecord 字段权', EMPLOYMENT),
  }),
  // ---- transfer/routes.ts registerDepartmentChoices：调动目标部门选择（§2.2 示例）--------------------------------------
  // 对象查看 AND 任一发起按钮 AND departmentId 可见（transfer.departmentField，否则 403「无权查看调动部门」）；
  // hasDataPermission=false 同样 403「无权选择调动部门」；纯经理（Transfer.Manager 且无 Transfer.Hr）走 readManagerReferences，
  // 其余 loadOrgSnapshot 按组织范围，标准表单且 unrestrictTargetDepartment 时全租户；formId 未配置 → 400
  'GET /transfers/departments': all(
    [
      object({
        object: EMPLOYMENT,
        operation: 'view',
        button: noButton('按钮在 any 分支'),
        scope: listScope('transfer.departmentChoices'),
        fields: fixed(['id', 'name', 'code'], 'DEC-057'),
      }),
      any(
        ['Transfer.Hr', 'Transfer.Manager', 'Transfer.Self'].map((code) =>
          buttonOnly(EMPLOYMENT, button(code, 'detail'), F_NO_DEPARTMENT),
        ),
      ),
    ],
    fixed(['id', 'name', 'code'], 'DEC-057'),
    { guards: ['transfer.departmentField'] },
  ),
  // ---- transfer/routes.ts：调动预览与发起 ----------------------------------------------------------------------------
  // 只读预览：normalizeTransferInput（transfer.previewInput：结构 400、本人入口只读字段 403、入口 / 表单不匹配 400）；
  // previewTransfer → requireTransferSource(initiator)（按钮 + 绑定 + 源范围）→ 有目标部门时 requireScopedEmploymentObject；
  // 响应：trimEmploymentResponse + visibleTransferForm（fieldModes 按可见 / 可编辑降级）+ allowedActions 布尔披露
  'POST /transfers/employees/:id/preview': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: INITIATOR_BUTTON,
    guards: ['transfer.direct', 'transfer.previewInput', TRANSFER_SOURCE],
    scope: guardScope('transfer.previewScope', NF_EMPLOYEE),
    fields: projector('transfer.preview', 'transfer.preview'),
    write: previewWrite,
    ...byId,
    // 表单字段模式：可编辑字段再按 object.create 的字段编辑权降为 readonly（visibleTransferForm），只影响响应
    optional: {
      fieldModes: object({
        object: EMPLOYMENT,
        operation: 'create',
        button: noButton('只按字段编辑权决定 fieldModes'),
        scope: noScope('只决定表单字段模式'),
        fields: noFields('只决定 fieldModes 的 editable / readonly'),
      }),
    },
  }),
  // 发起调动：If-Match 必填；requireTransferSource(initiator, param id) → requireTransferWrite（body.fields+customFields）→
  // previewTransfer（目标范围）→ direct 时 requireDirectTransfer（设置 409 DIRECT_TRANSFER_DISABLED / 直接调动按钮 403）→
  // preauthorizeLinkage（联动选项按差异授权，linkage.preauthorize）；命令内 createTransfer 重走锁 + 复核 + 联动保存
  'POST /transfers/employees/:id': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: INITIATOR_BUTTON,
    guards: ['employment.linkage', 'transfer.direct', 'linkage.preauthorize'],
    scope: guardScope(TRANSFER_SOURCE, NF_EMPLOYEE),
    fields: RESPONSE,
    write: employmentWrite('body.fields+customFields', [
      'lockTransferParticipants',
      'lockEmploymentEmployee',
      'assertRevision',
      'transferTargetContext',
      'requireTransferSource',
      'requireTransferWrite',
      'requireDirectTransfer',
      'requireScopedEmploymentObject',
      'authorizeLinkageWrite',
    ]),
    ...byId,
  }),
  // 他人调动申请暂存元数据读口（F-181a，DEC-511 / DEC-596）：只读调用人自己对该员工的那份暂存单（槽位按用户 × 员工），
  // 返回 { draft: 元数据 | null }，元数据（单号 / 版本 / 异动类型 / 原因 / 编制 / 表单 / 生效日）经 trimEmploymentResponse 按任职记录
  // 字段查看权投影，不含单据字段值——内容仍读 GET /businesses/:id；发起权限同暂存：requireTransferSource(hr)（Transfer.Hr
  // 按钮 + 源员工范围 404「员工不存在」）
  'GET /transfers/employees/:id/draft': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Transfer.Hr', 'detail'),
    scope: guardScope(TRANSFER_SOURCE, NF_EMPLOYEE),
    fields: RESPONSE,
    ...byId,
  }),
  // 清除暂存（F-181a）：与 DELETE /businesses/:id 同一条删除授权链——object.delete + Employment.Delete + 写入口径范围（
  // requireBusinessWriteScope，404「任职业务不存在」）+ 同单来源 transferBusinessContext；If-Match = 暂存单 revision，路径
  // 带暂存单号（槽位已指向别的单 409 DRAFT_REPLACED，版本不符 409 REVISION_CONFLICT，没有暂存 404）；命令内 CommandGuard.before
  // 按当前授权重验；锁员工 → 锁暂存单 → 草稿删除内核（transitionEmployment delete）
  'DELETE /transfers/employees/:id/draft/:businessId': object({
    object: EMPLOYMENT,
    operation: 'delete',
    button: button('Employment.Delete', 'detail'),
    guards: [TRANSFER_SOURCE, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'transferBusinessContext',
      'requireManagerBusinessSource',
      'lockEmploymentBusiness',
      'assertRevision',
      'assertTransition',
      'assertNoPendingApplication',
      'requireLinkedEmploymentRecord',
    ]),
    ...byId,
  }),
  // ---- transfer/linkage/routes.ts：联动 -----------------------------------------------------------------------------
  // 联动详情：loadEmploymentBusiness（DEC-177 可见）且 kind=transfer，否则 404「调动不存在」；合同部分按 EmploymentContract
  // 查看权 + 合同范围（contractVisible）决定显示 / 隐藏，归投影器，不是准入 AND（§2.4）
  'GET /transfers/:id/linkage': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('联动详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.business', NF_TRANSFER),
    fields: projector('transfer.linkage', 'transfer.linkage'),
    ...byId,
    // 合同变更子项按合同查看权 + 合同范围 + 合同字段披露（readTransferLinkage 的 visibility.contract），不拒绝请求
    optional: {
      contractItems: object({
        object: CONTRACT_OBJECT,
        operation: 'view',
        button: noButton('只按合同查看权'),
        scope: listScope('contracts.scope'),
        fields: noFields('只决定合同子项是否披露'),
      }),
    },
  }),
  // 修改联动：If-Match 必填；normalizeLinkage 400；调动可见且 kind=transfer，否则 404「调动不存在」；requireLinkageSource
  // （DEC-194：employee 单据 400，其余按单据 initiator 重走 requireTransferSource）；preauthorizeLinkage 按新旧差异授权任职字段 /
  // 下属经理字段 / 组织角色 / 合同变更（options 为 null 时不提取字段）；命令内 updateTransferLinkage 再判一次；
  // 命令事务内由调动同单写统一 guard（same-order-guard.ts，CommandGuard.before）按当前范围重验可见与 requireLinkageSource，重放 / 回查同走
  'PUT /transfers/:id/linkage': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: INITIATOR_BUTTON,
    guards: ['employment.linkage', 'linkage.preauthorize', 'transfer.source', 'linkage.source'],
    scope: pointScope({ param: 'id' }, 'employment.business', NF_TRANSFER),
    fields: RESPONSE,
    write: employmentWrite({ guard: 'linkage.preauthorize' }, [
      'lockTransferParticipants',
      'lockEmploymentBusiness',
      'assertRevision',
      'requireLinkageSource',
      'assertLinkageMutable',
      'authorizeLinkageWrite',
    ]),
    ...byId,
  }),
  // 重试失败子项：空体（带 content-type 时须为 {}）；requireEmploymentWrite('update', {}, RetryActivation)；authorizeRetry：
  // 子项不存在或所属调动不可见 → 404「联动子项不存在」，下属字段 / 组织角色按当前权限；命令内 retryLinkageItem 再判 + DEC-178
  'POST /transfers/linkage-items/:id/retry': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.RetryActivation', 'detail'),
    guards: [LINKAGE],
    scope: guardScope('linkage.retry', NF_LINKAGE_ITEM),
    fields: RESPONSE,
    write: employmentCommand([
      'lockTransferParticipants',
      'assertRevision',
      'authorizeSubordinateField',
      'authorizeOrgRole',
      'requireLinkedEmploymentRecord',
    ]),
    ...byId,
  }),
  // 「变更的合同」候选：任职查看 AND 合同查看（requirePermission object.view EmploymentContract）；逐行 checkScope 按合同范围
  // （含创建人）过滤，范围外的行静默跳过；number 不可见时 name 为 null；不查 :id 员工的任职范围
  'GET /transfers/employees/:id/contracts': all(
    [
      object({
        object: EMPLOYMENT,
        operation: 'view',
        button: noButton('候选合同无按钮'),
        scope: noScope('候选合同只按合同范围逐行过滤，不查 :id 员工的任职范围'),
        fields: noFields('出口在组合层登记'),
      }),
      object({
        object: CONTRACT_OBJECT,
        operation: 'view',
        button: noButton('候选合同无按钮'),
        scope: listScope('contracts.employeeVisibility'),
        fields: noFields('出口在组合层登记'),
      }),
    ],
    projector('transfer.contractChoices', 'transfer.contractChoices'),
    { guards: ['contracts.employeeContractChoices'], ...byId },
  ),
  // ---- transfer/routes.ts registerTransferConfiguration：调动配置 ---------------------------------------------------
  'GET /transfers/settings': configurationView(SETTINGS, SETTINGS_FIELDS),
  // body 严格为 { unrestrictTargetDepartment, autoPopulate }（400）；审计 transfer.settings.update / transfer_settings
  'PUT /transfers/settings': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('transfer_settings'),
  ),
  // 只有 configurationContext(write) 的管理员别名，不经 requireEmploymentWrite（差异 4）；formId 长度 1–100 否则 400；
  // 审计 transfer.form.save / transfer_form；响应经 trimEmploymentResponse（EmploymentSettings 对象）
  'PUT /transfers/forms/:formId': admin('other_settings', {
    alias: 'tenant.employment.configuration.write',
    fields: shape('transfer.form'),
    write: write(
      none('表单配置不是任职字段，不经 requireEmploymentWrite'),
      'config.audited:transfer_form',
      none('配置对象无范围'),
      {
        preconditions: ['assertRevision'],
      },
    ),
    invalidId: BAD_REQUEST,
  }),
  // ---- employment/routes.ts registerEmployees：员工主档 --------------------------------------------------------------
  // If-Match 必填（createEmployee 断言 revision 0）；body 严格 { code, name, loginEmail? }；requireEmploymentWrite('create',
  // { code, name }, Employee.Create@list)；requireEmploymentScope(ctx) 只认看全部（DEC-121，否则 404「任职数据不存在」）；
  // provisionEmployeeUser 与建档同事务（DEC-128）
  'POST /employees': object({
    object: EMPLOYEE,
    operation: 'create',
    button: button('Employee.Create', 'list'),
    scope: seeAll(NF_DATA),
    fields: RESPONSE,
    write: write(
      'body',
      'employment.employeeCreate',
      { generic: { targets: 'id', locator: 'employment.employee' } },
      { controls: ['loginEmail'], preconditions: ['assertRevision'] },
    ),
  }),
  // 员工列表（page list）：按 employeeStatus / entryStatus 筛选须可见（employment.viewableFilters，否则 403「筛选字段不可查看」）；
  // listEmployees 的 employmentScopePredicate = scopeSql（人员 / 当前部门 / 创建人）；hasDataPermission 协议键
  'GET /employees': object({
    object: EMPLOYEE,
    operation: 'view',
    button: noButton('列表无按钮'),
    guards: ['employment.viewableFilters'],
    scope: listScope('module.scopeSql'),
    fields: projector('employment.response', 'employment.employeeList'),
  }),
  // 员工详情：readPageContext(detail, resource=id)：人员范围 → 404「任职数据不存在」，看全部再查 tenant.employment.read 别名；
  // getEmployee 带范围取不到 → 404「员工不存在」（差异 6）
  'GET /employees/:id': object({
    object: EMPLOYEE,
    operation: 'view',
    button: noButton('详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.employee', NF_DATA),
    fields: RESPONSE,
    ...byId,
  }),
  // 新建任职业务：If-Match 必填；resource=id 人员范围 404「任职数据不存在」+ 看全部的 tenant.employment.write 别名；
  // loginEmail 只在入职类业务（否则 400）；requireEmploymentWrite('create', body 去掉 loginEmail, Employment.Create)；
  // 调动类 requireTransferSource(hr) + direct 时 requireDirectTransfer；带 departmentId 时 requireEmploymentScope(人员 + 部门)；
  // 命令内调动类重锁 + 复核，createEmploymentBusiness 内 requireScopedEmploymentObject，直接生效的向后更新按 DEC-178；
  // kind=regularization 交 probation-routes.ts createRegularizationViaBusinesses → regularization.ts 单一入口
  // （试用结果必填 400 PROBATION_RESULT_REQUIRED / 字典启用项、生效日可不填取 F-205 默认，权限与范围同上）
  'POST /employees/:id/businesses': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button('Employment.Create', 'detail'),
    guards: [TRANSFER_SOURCE, 'transfer.direct', LINKAGE],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    write: employmentWrite(
      'body.fields+customFields',
      [
        'lockTransferParticipants',
        'lockEmploymentEmployee',
        'assertRevision',
        'requireTransferSource',
        'requireDirectTransfer',
        'requireScopedEmploymentObject',
        'requireLinkedEmploymentRecord',
      ],
      {
        controls: ['loginEmail', 'pendingEntry', 'probation', 'probationMonths', 'probationEndDate', 'probationResult'],
      },
    ),
    ...byId,
  }),
  // ---- employment/routes.ts registerEmployeeRecords / registerInheritancePreview --------------------------------
  // 任职记录链：readPageContext(list) + requirePermission(tenant.employment.read, resource=id)；员工不存在 → 404「员工不存在」；
  // listEmploymentRecords 按 DEC-177 可见谓词分页；范围内一条都不可见 → 404「员工不存在」（employment.noVisibleRecords）
  'GET /employees/:id/records': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('记录链列表无按钮'),
    guards: ['employment.noVisibleRecords'],
    scope: listScope('employment.visibility'),
    fields: RESPONSE,
    ...byId,
  }),
  // 继承预览：resource=id 人员范围 404「任职数据不存在」；getEmployee 带范围 404「员工不存在」；prepareInheritance 后才查按钮
  // Employment.Preview(detail)；再按继承出的部门 requireEmploymentScope（employment.inheritanceDepartment，404「任职数据不存在」）
  'POST /employees/:id/preview': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Employment.Preview', 'detail'),
    guards: ['employment.inheritanceDepartment'],
    scope: pointScope({ param: 'id' }, 'employment.employee', NF_DATA),
    fields: RESPONSE,
    write: previewWrite,
    ...byId,
  }),
  // ---- employment/routes.ts registerBusinesses：业务 / 记录读取与修改 ------------------------------------------------
  // 业务详情：transferBusinessContext(read)（调动单：HR 按钮 / 本人 / 经理身份决定是否按经理团队复核，纯经理非团队成员 403 / 404；
  // 标准表单放宽时给 transferTarget 例外）→ loadEmploymentBusiness（DEC-177，有例外时不带范围）→ 404「任职业务不存在」→
  // requirePermission(tenant.employment.read, resource=employeeId)
  'GET /businesses/:id': object({
    guards: ['transfer.source'],
    object: EMPLOYMENT,
    operation: 'view',
    // 调动单详情经 transferBusinessContext → requireTransferSource（按单据 initiator 校验发起按钮）
    button: INITIATOR_BUTTON,
    scope: pointScope({ param: 'id' }, 'employment.business', NF_BUSINESS),
    fields: RESPONSE,
    ...byId,
  }),
  // 记录详情：loadEmploymentRecord（DEC-177 可见）→ 404「任职记录不存在」→ requirePermission(tenant.employment.read, employeeId)
  'GET /records/:id': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('记录详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.record', NF_RECORD),
    fields: RESPONSE,
    ...byId,
  }),
  // 修改申请：If-Match 必填；normalizeBusinessPatch 400；transferBusinessContext(before-command)（调动单经理 / HR / 本人口径，
  // 差异 11）→ authorizeBusinessWrite（写入口径 404）→ requireEmployeeTransferBusiness（员工单只读字段 403）→
  // requireEmploymentWrite('update', patch, Employment.Edit) → 改 departmentId 时 requireScopedEmploymentObject（DEC-193）；
  // 命令内 transferBusinessContext('command') 锁后复验，updateEmploymentBusiness 只放行 draft / rejected 申请（409）
  'PATCH /businesses/:id': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [TRANSFER_SOURCE, 'employment.employeeTransferBusiness', DIRECT_OPERATION, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentWrite(
      'body.fields+customFields',
      [
        'transferBusinessContext',
        'requireManagerBusinessSource',
        'lockEmploymentBusiness',
        'assertRevision',
        'requireEmployeeTransferBusiness',
        'requireScopedEmploymentObject',
      ],
      { controls: ['pendingTransferAck', 'confirmed'] },
    ),
    ...byId,
  }),
  // ---- employment/routes.ts registerBusinessTransitions（router.on）：命令式按钮 ---------------------------------------
  // 四条共用：If-Match 必填；transferBusinessContext(before-command)（差异 11）→ requireEmploymentWrite(update | delete, {}, 按钮)
  // → authorizeBusinessWrite（写入口径 404「任职业务不存在」+ 看全部的 tenant.employment.write 别名）；命令内锁后复验 +
  // transitionEmployment（assertTransition 409）+ 审批钩子；拒绝明细经 discloseDeletionBlock 按范围与字段权披露
  // （投影器 employment.deletionBlock：DEC-126 在途申请只给件数、循环汇报路径须全部可见）
  // 提交：空体（带 content-type 时须为 {}，否则 400）；requireEmployeeTransferBusiness 在路由与命令内各一次；
  // 命令内另有 assertTransferLinkageSubmittable（DEC-183，409）
  'POST /businesses/:id/submit': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Submit', 'detail'),
    guards: ['employment.linkage', TRANSFER_SOURCE, 'employment.employeeTransferBusiness'],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'transferBusinessContext',
      'requireManagerBusinessSource',
      'lockEmploymentBusiness',
      'assertRevision',
      'assertTransition',
      'requireEmployeeTransferBusiness',
      'assertTransferLinkageSubmittable',
    ]),
    ...byId,
  }),
  // 撤回（发起人撤回到草稿，AC-TRF-28）：不读请求体
  'POST /businesses/:id/withdraw': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Withdraw', 'detail'),
    guards: ['employment.linkage', TRANSFER_SOURCE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'transferBusinessContext',
      'requireManagerBusinessSource',
      'lockEmploymentBusiness',
      'assertRevision',
      'assertTransition',
    ]),
    ...byId,
  }),
  // 撤销（HR 作废未审批完成的申请，AC-TRF-07）：不读请求体
  'POST /businesses/:id/revoke': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Revoke', 'detail'),
    guards: ['employment.linkage', TRANSFER_SOURCE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'transferBusinessContext',
      'requireManagerBusinessSource',
      'lockEmploymentBusiness',
      'assertRevision',
      'assertTransition',
    ]),
    ...byId,
  }),
  // 删除：object.delete + Employment.Delete；命令内 DEC-126 在途申请 409、删除中间记录恢复前一条按 DEC-178 可见判定（deletion-guards）
  'DELETE /businesses/:id': object({
    object: EMPLOYMENT,
    operation: 'delete',
    button: button('Employment.Delete', 'detail'),
    guards: [TRANSFER_SOURCE, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'transferBusinessContext',
      'requireManagerBusinessSource',
      'lockEmploymentBusiness',
      'assertRevision',
      'assertTransition',
      'assertNoPendingApplication',
      'requireLinkedEmploymentRecord',
    ]),
    ...byId,
  }),
  // ---- employment/routes.ts registerActivation：待办与生效重试 --------------------------------------------------------
  // 补全待办（DEC-163）：requireTransferButton(hr) → Transfer.Hr(detail)；listCompletionTodos 的 employmentScopePredicate =
  // scopeSql（差异 5）；每项 id / employeeId / effectiveDate 经 trimEmploymentResponse，fieldCodes 按可见字段过滤
  'GET /completion-todos': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Transfer.Hr', 'detail'),
    scope: listScope('module.scopeSql'),
    fields: projector('employment.completionTodo', 'employment.completionTodo'),
  }),
  // 生效失败待办（DEC-052 / DEC-112）：listActivationTodos 的 employmentScopePredicate = scopeSql（差异 5）
  'GET /activation-todos': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    scope: listScope('module.scopeSql'),
    fields: RESPONSE,
  }),
  // ---- employment/entry-routes.ts：R2 BE-2b 入职四视图（34 EN-R1，DEC-484②）---------------------------------------------
  // view ∈ all / today / cancelled / hired（缺失或不合法 400）；readPageContext(list)：任职记录对象查看 + 列表范围，
  // listEntryView 的 employmentScopePredicate = scopeSql（人员 / 记录部门 / 创建人，范围为空什么也看不到）；
  // 每项带 probation（F-188，待入职试用期，没填过 null）、probationMonths / contractCompanyId（BE-14b2，Offer 同步带来，
  // 其他为 null）与 contractStartDate / contractEndDate（F-194，待入职合同起止日，存量 / 已办理入职为 null；
  // 控制项显式投影，权限沿用待入职列表本身的对象与字段权限，不另要求合同对象权限）；
  // cancelRemark（F-206，DEC-560）：最近一次取消动作的说明，无则 null，行可见即可见；
  // 记录字段按任职记录可见字段裁剪，姓名 / 工号按人员对象可见字段另行裁剪；hasDataPermission 协议键
  'GET /pending-entries': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    scope: listScope('module.scopeSql'),
    fields: projector('employment.response', 'employment.entryViews'),
  }),
  // ---- employment/intern-routes.ts：R2 BE-6a 实习生（B34～B38、B41、A48）-------------------------------------------------
  // 实习四视图：view / departmentId / keyword 不合法 400；按部门筛选须 departmentId 可见、按关键字须 name / code 可见（否则 403
  // 「筛选字段不可查看」）；readPageContext(list) + scopeSql 列表范围（空范围看不到任何行）；任职字段按任职记录、姓名 / 工号按
  // 人员对象可见字段裁剪；state / probation 是视图控制项，行可见即可见
  'GET /interns': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    guards: ['employment.viewableFilters'],
    scope: listScope('module.scopeSql'),
    fields: projector('employment.response', 'employment.internViews'),
    // F-283 逐行 availableActions（intern-actions.ts）：对每行跑转正 / 结束实习 / 撤回 / 撤销写入口的同一组判定，只决定响应里
    // 的动作码，不参与准入；无对应对象操作权（readContext 的 403）时该类动作不下发，其余错误照常抛出
    optional: {
      rowActions: all(
        [
          object({
            object: EMPLOYMENT,
            operation: 'create',
            button: button('Employment.Create', 'detail'),
            scope: noScope('只决定动作码：员工 / 业务范围由逐行写入口同一判定（intern-actions.ts）承担'),
            fields: noFields('只决定 availableActions 的 regularize / terminate'),
          }),
          object({
            object: EMPLOYMENT,
            operation: 'button',
            button: button(EXIT_BUTTONS.direct, 'detail'),
            scope: noScope('只判按钮：员工范围已由上一项判过'),
            fields: noFields('只决定 availableActions 的 terminate'),
          }),
          object({
            object: EMPLOYMENT,
            operation: 'update',
            button: button('Employment.Withdraw', 'detail'),
            scope: noScope('只决定动作码：员工 / 业务范围由逐行写入口同一判定（intern-actions.ts）承担'),
            fields: noFields('只决定 availableActions 的 withdraw / revoke'),
          }),
          object({
            object: EMPLOYMENT,
            operation: 'button',
            button: button('Employment.Revoke', 'detail'),
            scope: noScope('只判按钮：业务范围已由上一项判过'),
            fields: noFields('只决定 availableActions 的 revoke'),
          }),
        ],
        noFields('只决定 availableActions'),
      ),
    },
  }),
  // 新增实习生一体写入（BE-R2d4c，DEC-662）：If-Match 必填（新增 0，重聘 = 候选人员当前 revision）；body 严格（400）：kind =
  // hire（code + name + loginEmail，建档并绑定用户）| rehire（employeeId = rehire-matches 候选，不再建档），contract 必填且终止日必填、
  // 不早于入职日（400 INTERN_CONTRACT_DATE_INVALID）；用工类型固定实习（填别的 400）。权限同 POST /employees：人员对象新增权 +
  // Employee.Create + 只认看全部（DEC-121，否则 404「任职数据不存在」），叠加任职新增权 / 字段写权 + Employment.Create；
  // 命令内 internCreateGuard 三个出口重过，并复核合同对象字段创建权 + 合同“新建”按钮（入职日 ≤ 今天）。入职日 ≤ 今天同事务生成
  // 正式合同（view=interning），在未来写待入职合同（view=pendingEntry，只记终止日 / 合同公司，其余合同字段 400 INTERN_PENDING_CONTRACT_FIELDS）；
  // F-322：profile 普通字段经档案更新权，教育经子集创建权，均在命令事务复核；资料回执按当前档案查看权裁剪。
  // 任一步失败整体回滚，同命令 ID 不重复写入；没有 profile 时保持原回执。
  'POST /interns': all(
    [
      object({
        object: EMPLOYEE,
        operation: 'create',
        button: button('Employee.Create', 'list'),
        scope: seeAll(NF_DATA),
        fields: noFields('人员新增权只判对象与按钮；回执不含人员字段'),
      }),
      object({
        object: EMPLOYMENT,
        operation: 'create',
        button: button('Employment.Create', 'detail'),
        scope: guardScope('employment.scope', NF_DATA),
        fields: noFields('回执是固定形状（人员 / 业务 ID、合同摘要、视图归属），不含任职字段'),
      }),
    ],
    projector('employment.internCreateReceipt', 'employment.internCreateReceipt'),
    {
      guards: [LINKAGE, 'employment.entryContract', 'employment.internProfile'],
      write: employmentWrite(
        'body.fields+customFields',
        ['lockEmploymentEmployee', 'assertRevision', 'requireScopedEmploymentObject', 'requireInternProfileAccess'],
        { controls: ['employeeId', 'code', 'name', 'loginEmail', 'contract', 'profile'] },
      ),
      optional: {
        profile: object({
          object: 'TenantBase.EmployeeInformation',
          operation: 'view',
          button: noButton('资料回执按当前档案查看权披露'),
          scope: pointScope({ derived: 'employment.internProfile' }, 'personnel.employee', denied(404, 'NOT_FOUND')),
          fields: projector('employment.internProfile', 'personnel.employee'),
        }),
      },
      ...byId,
    },
  ),
  // 直接实习转正：If-Match 必填；body 严格（合同 / 工号 / 入职日期不受理，400）；resource=id 人员范围 404「任职数据不存在」 +
  // 看全部的写别名；requireEmploymentWrite('create', 实际写入字段, Employment.Create)；requireEmploymentScope（人员 + 目标部门）；
  // 命令内 internRegularizationGuard 按当前授权重过；非在职实习生 409 NOT_INTERN、有审批中转正申请 409
  // INTERN_REGULARIZATION_IN_PROGRESS；createEmploymentBusiness 直接落地（严格控编 409、DEC-178 联动）；非严格超编未确认 409
  // CONFIRMATION_REQUIRED（整单回滚）；试用期信息同事务写入并审计
  'POST /interns/:id/regularize': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button('Employment.Create', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    write: employmentWrite(
      'body.fields+customFields',
      ['lockEmploymentEmployee', 'assertRevision', 'requireScopedEmploymentObject', 'requireLinkedEmploymentRecord'],
      { controls: ['probation', 'probationMonths', 'probationEndDate', 'confirmed'] },
    ),
    ...byId,
  }),
  // 结束实习（BE-6b，DEC-593）：If-Match 必填；body 严格 { endDate, cancelPendingEntry?, confirmed?, pendingTransferAck? }（离职类型 / 原因
  // 等其余字段 400）；沿用直接离职的权限组合（Employment.Dimission，原站有无独立权限项未验证）+ 人员范围 404；命令内 exitCommandGuard
  // 按当前授权重过范围 / 按钮 / 字段；员工锁 → 日期不早于入职（400）→ 在职实习生（409 NOT_INTERN）→ 在途转正确认（409 CONFIRMATION_REQUIRED）
  // → 离职门禁与申请服务（直接离职、变动类型“实习结束”，免审批生效，来源 free_direct）
  'POST /interns/:id/terminate': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button(EXIT_BUTTONS.direct, 'detail'),
    guards: [LINKAGE],
    scope: pointScope({ param: 'id' }, 'employment.employee', NF_DATA),
    fields: RESPONSE,
    write: employmentWrite('body.fields+customFields', EXIT_CREATE_PRECONDITIONS, {
      controls: ['endDate', 'cancelPendingEntry', 'confirmed', 'pendingTransferAck'],
    }),
    ...byId,
  }),
  // ---- employment/part-time/routes.ts：R2 BE-7 PT-3b / PT-5 兼职新增与读取入口（R2-T05 §4.1 / §6.1 / §7.2；六视图自 PT-5 开放）----
  // 预览（只读 POST）：readContext(object.create, resource=id) 人员范围 404；body 严格（400）；实际写入字段的创建权；
  // Employment.PartTime / PartTimeApproval 任一（都无 403）；兼职部门 requireEmploymentScope（404）；与新增同一套校验后带出默认值
  'POST /employees/:id/part-times/preview': any(
    [partTimePreview(PART_TIME_BUTTONS.direct), partTimePreview(PART_TIME_BUTTONS.application)],
    byId,
  ),
  // 直接新增：不要求 If-Match（新建对象）；body 严格；requireEmploymentWrite('create', 实际写入字段, Employment.PartTime)；人员 + 兼职
  // 部门 requireEmploymentScope；命令内 partTimeCreateGuard 三个出口按当前授权重过；isDepartmentHead / addedSubordinateIds 自 PT-7 开放
  // （字段写权沿用 body.fields 判定，不新增授权项；联动人员 / 组织写范围的复核登记 employment.linkage，DEC-178）：
  // 保存时校验联动人员，开始日 ≤ 今天同事务执行，未来开始写待执行事件；不触发向后更新（AC-FWD-11）
  'POST /employees/:id/part-times': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button(PART_TIME_BUTTONS.direct, 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    write: employmentWrite(
      'body.fields+customFields',
      [
        'lockEmploymentEmployee',
        'assertPartTimeWithinCycle',
        'assertExclusiveTypeFree',
        'requireScopedEmploymentObject',
      ],
      { controls: ['partTimeType', 'startDate', 'endDate'] },
    ),
    ...byId,
  }),
  // 编辑兼职（PT-3c，§5.1 + 直接修改结束日期）：readContext(object.update, If-Match 必填)；body 严格（400）；requirePartTimeWriteAccess：
  // 目标存在与兼职部门（改部门时含新部门）requireScopedEmploymentObject（写入口径 404「兼职记录不存在」）→ 对象更新权 + 实际改动字段
  // 的写权 + Employment.PartTimeEdit（403）；命令内 partTimeWriteGuard 三个出口重过；命令内 editPartTime 锁 + 版本 + 周期边界 + E-4 +
  // 部门可用性与引用；开始日期 / 任职类型改值、结束日置空 → 400；isDepartmentHead / addedSubordinateIds 自 PT-7 开放，
  // 只对本次新出现的联动校验并办理；不触发向后更新（AC-FWD-11）
  'PATCH /part-times/:recordId': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(PART_TIME_BUTTONS.edit, 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: guardScope('employment.scope', NF_PART_TIME),
    fields: RESPONSE,
    write: employmentWrite(
      'body.fields+customFields',
      ['lockEmploymentBusiness', 'assertRevision', 'assertPartTimeWithinCycle', 'requireScopedEmploymentObject'],
      { controls: ['partTimeType', 'startDate', 'endDate'] },
    ),
    ...byId,
  }),
  // 批量结束兼职（PT-3c，§4.4）：不要求 If-Match（带了 400，逐条 revision 锁内比对）；normalizeBatchEnd 400（1～200 条、不重复）；
  // requirePartTimeWriteAccess 一次（逐条范围 404 整批、对象更新权 + endDate 字段写权 + Employment.PartTimeBatchEnd 403）；
  // 命令内 batchEndPartTimes 按员工 → 记录取锁，整批同事务，一条对象操作日志；响应 { total, succeeded, failed, items }
  'POST /part-times/batch-end': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(PART_TIME_BUTTONS.batchEnd, 'list'),
    guards: [DIRECT_OPERATION],
    scope: guardScope('employment.scope', NF_PART_TIME),
    fields: RESPONSE,
    rows: {
      path: 'items[*]',
      fields: none('字段取自共享的 body.endDate，不逐行提取'),
      target: { body: 'items[*].recordId' },
      batch: 'atomic',
    },
    write: employmentWrite('body', ['lockEmploymentBusiness', 'assertRevision', 'requireScopedEmploymentObject'], {
      ledger: 'single',
    }),
  }),
  // ---- employment/part-time/request-routes.ts：R2 BE-7 PT-4b / PT-4c 兼职申请入口（R2-T05 §4.1 / §7.2）----
  // 新建（草稿，或 submit = true 建完直接提交）：requestType = add ——
  // readContext(object.create)；body 严格（400）；requirePartTimeCreateAccess：员工主职 + 兼职部门范围（404）→
  // 对象创建权 + 实际写入字段（含 requestRemark）的创建权 + Employment.PartTimeApproval（403）；建并提交另要 Employment.Submit（条件分支，
  // 探针默认体不带 submit）；命令内 partTimeCreateGuard 三个出口重过；isDepartmentHead / addedSubordinateIds 自 PT-7 开放，
  // 只对本次新出现的联动校验并办理；没有匹配的流程 / 首节点无审批人 → 整单回滚（DEC-017 / 054）。
  // requestType = extend / end（PT-4c）同路径另走 createDateRequestRoute：readContext(object.update)；
  // requirePartTimeWriteAccess（同
  // 编辑兼职）：目标兼职与其兼职部门写入口径范围（404「兼职记录不存在」）→ 对象更新权 + endDate / requestRemark 字段写权 +
  // Employment.PartTimeExtend / PartTimeEnd（403），建并提交另要 Employment.Submit；命令内 partTimeWriteGuard 重过；锁内 E-1～E-6 /
  // T-1～T-4 由 createDateRequest 判。分支键 requestType 登记为域 employment.partTimeRequestType（操作与发起按钮按它取值）
  'POST /part-time-requests': object({
    object: EMPLOYMENT,
    operation: { from: 'body', path: 'requestType', map: { add: 'create', extend: 'update', end: 'update' } },
    button: {
      from: 'body',
      path: 'requestType',
      map: {
        add: button(PART_TIME_BUTTONS.application, 'detail'),
        extend: button(PART_TIME_BUTTONS.extend, 'detail'),
        end: button(PART_TIME_BUTTONS.end, 'detail'),
      },
    },
    guards: [DIRECT_OPERATION],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    write: employmentWrite(
      'body.fields+customFields',
      [
        'lockEmploymentEmployee',
        'assertPartTimeWithinCycle',
        'assertExclusiveTypeFree',
        'requireScopedEmploymentObject',
      ],
      { controls: ['requestType', 'employeeId', 'partTimeType', 'startDate', 'endDate', 'submit'] },
    ),
  }),
  // 修改草稿 / 驳回中的申请：If-Match = 申请头 revision（缺 400、不符 409）；body 严格（400）；requirePartTimeRequestAccess：申请存在
  // （404「兼职申请不存在」）→ 员工主职与申请部门（改部门时含新部门）requireScopedEmploymentObject（404）→ 对象更新权 + 实际改动字段
  // 的写权 + Employment.PartTimeApproval（403）；命令内 partTimeRequestGuard 重过；锁内状态（409 PART_TIME_REQUEST_STATE_INVALID）、
  // D-1～D-10 与周期边界由 updateRequest（新增 D-1～D-10；延长 E-1～E-6 / 结束 T-1～T-4） 判，越界当次拒绝不留版本；联动两字段同新建（保存并校验，不执行）
  'PATCH /part-time-requests/:id': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(PART_TIME_BUTTONS.application, 'detail'),
    guards: [DIRECT_OPERATION],
    scope: guardScope('employment.scope', NF_PART_TIME_REQUEST),
    fields: RESPONSE,
    write: employmentWrite(
      'body.fields+customFields',
      ['lockPartTimeRequest', 'assertRevision', 'assertPartTimeWithinCycle', 'requireScopedEmploymentObject'],
      { controls: ['partTimeType', 'startDate', 'endDate'] },
    ),
    ...byId,
  }),
  // 提交 / 撤回：If-Match 必填，不读请求体；与创建同一按钮 + Employment.Submit / Withdraw；只允许原发起人（锁内 403
  // PART_TIME_NOT_INITIATOR）；提交含驳回后重提，按最新版本重跑 D-1～D-10 与周期边界，并交审批中心匹配流程（DEC-017）
  'POST /part-time-requests/:id/submit': partTimeRequestAction('Employment.Submit', [
    'lockPartTimeRequest',
    'assertRevision',
    'assertInitiator',
    'assertPartTimeWithinCycle',
  ]),
  'POST /part-time-requests/:id/withdraw': partTimeRequestAction('Employment.Withdraw', [
    'lockPartTimeRequest',
    'assertRevision',
    'assertInitiator',
  ]),
  // HR 撤销：只要 Employment.Revoke（不要求创建按钮），不限发起人；作废未办结的申请，在途实例一并取消
  'POST /part-time-requests/:id/revoke': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Revoke', 'detail'),
    guards: [DIRECT_OPERATION],
    scope: guardScope('employment.scope', NF_PART_TIME_REQUEST),
    fields: RESPONSE,
    write: employmentCommand(['lockPartTimeRequest', 'assertRevision', 'assertAction']),
    ...byId,
  }),
  // 删除草稿 / 驳回中的申请（保留快照）：object.delete + 创建按钮 + Employment.Delete
  'DELETE /part-time-requests/:id': all(
    [
      object({
        object: EMPLOYMENT,
        operation: 'delete',
        button: button(PART_TIME_BUTTONS.application, 'detail'),
        guards: [DIRECT_OPERATION],
        scope: guardScope('employment.scope', NF_PART_TIME_REQUEST),
        fields: RESPONSE,
      }),
      object({
        object: EMPLOYMENT,
        operation: 'button',
        button: button('Employment.Delete', 'detail'),
        scope: noScope('只判按钮：申请范围已由创建按钮那一项判过'),
        fields: noFields('只决定能否删除申请'),
      }),
    ],
    RESPONSE,
    {
      write: employmentCommand(['lockPartTimeRequest', 'assertRevision', 'assertAction']),
      ...byId,
    },
  ),
  // 申请详情（含主职信息 / 员工信息分组）：loadPartTimeRequestDetail（DEC-177 可见：申请部门 ∪ 员工当前主职部门）→ 404「兼职申请不存在」→
  // tenant.employment.read（resource=员工）；主职分组只在操作人看得到该主职记录时给出，三组各按所属对象的字段查看权裁剪
  'GET /part-time-requests/:id': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('申请详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.partTimeRequest', NF_PART_TIME_REQUEST),
    fields: projector('employment.response', 'employment.partTimeRequest'),
    ...byId,
    // F-268 逐单 availableActions（part-time/request-actions.ts）：对改 / 提交 / 删除 / 撤回 / 撤销各跑写入口的同一个
    // requirePartTimeRequestAccess（对象操作权 + 申请类型按钮 + 写入口径范围），只决定响应里的动作码，不参与准入
    optional: {
      requestActions: all(
        [
          object({
            object: EMPLOYMENT,
            operation: 'update',
            button: button(PART_TIME_BUTTONS.application, 'detail'),
            scope: noScope('只决定动作码：申请范围由写入口同一判定 requirePartTimeRequestAccess 承担'),
            fields: noFields('只决定 availableActions 的 edit / submit / withdraw'),
          }),
          object({
            object: EMPLOYMENT,
            operation: 'delete',
            button: button('Employment.Delete', 'detail'),
            scope: noScope('只决定动作码：申请范围由写入口同一判定 requirePartTimeRequestAccess 承担'),
            fields: noFields('只决定 availableActions 的 delete'),
          }),
          object({
            object: EMPLOYMENT,
            operation: 'button',
            button: button('Employment.Revoke', 'detail'),
            scope: noScope('只判按钮：申请范围已由上面两项判过'),
            fields: noFields('只决定 availableActions 的 revoke'),
          }),
        ],
        noFields('只决定 availableActions'),
      ),
    },
  }),
  // 兼职六视图（B25～B30，R2-T05 §6.1）：view ∈ ongoing / expiring / not_started / ended / all / in_approval（缺失或不合法 400，
  // 不回退到 all）；days（1～365，默认 30）/ keyword / departmentId（含下级，可 includeChildren=false）/ serviceType /
  // startFrom / startTo / endFrom / endTo / directManagerId 严格校验 400；readPageContext(list)，筛选用到的字段不可查看
  // 403「筛选字段不可查看」；分页前 employmentVisibilitySql（DEC-177 两项并集）过滤，范围为空 → 空集，total 与本页同一份结果；
  // 任职字段按任职记录、姓名 / 工号按人员对象可见字段裁剪（无权缺席）
  'GET /part-times': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    guards: ['employment.viewableFilters'],
    scope: listScope('employment.visibility'),
    fields: projector('employment.response', 'employment.partTimeViews'),
  }),
  // 员工页签：readPageContext(detail) + tenant.employment.read；按 DEC-177 可见谓词分页，一条都不可见且员工不在范围内 → 404「员工不存在」
  'GET /employees/:id/part-times': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('员工页签无按钮'),
    scope: listScope('employment.visibility'),
    fields: RESPONSE,
    ...byId,
  }),
  // 兼职详情（当前字段 + 期限链 + 申请历史）：loadPartTime（DEC-177 可见）→ 404「兼职记录不存在」→ tenant.employment.read（resource=员工）；
  // 期限链随结束日期字段权，申请历史逐条按 §6.2 可见并经 trimEmploymentResponse 裁剪
  'GET /part-times/:recordId': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('兼职详情无按钮'),
    scope: pointScope({ param: 'recordId' }, 'employment.partTime', NF_PART_TIME),
    fields: RESPONSE,
    invalidId: BAD_REQUEST,
  }),
  // 重聘判定（只读；POST 以免证件号进 URL）：body 严格 { idType, idNumber }（400）；Employee 新增权 + Employee.Create@list；
  // requireEmploymentScope(ctx) 只认看全部（DEC-121，否则 404）；多人命中 409 REHIRE_MATCH_AMBIGUOUS；带出项按三个对象的可见字段裁剪
  'POST /rehire-matches': object({
    object: EMPLOYEE,
    operation: 'create',
    button: button('Employee.Create', 'list'),
    scope: seeAll(NF_DATA),
    fields: projector('employment.response', 'employment.rehireMatch'),
    write: write(
      'body',
      none('只读判定：没有命令事务，没有提交前足迹'),
      none('只读判定：没有返回后复核，带出项按可见字段裁剪'),
      { commandOnly: true },
    ),
  }),
  // 重试生效：If-Match 必填；空体；requireEmploymentWrite('update', {}, RetryActivation)；authorizeBusinessWrite（写入口径）；
  // 命令内 retryActivation 内联校验 revision（409 REVISION_CONFLICT）、未生效 / 未失败 / 未到期 / 前序失败（409）
  'POST /businesses/:id/activation/retry': object({
    guards: ['employment.linkage'],
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.RetryActivation', 'detail'),
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand(['lockTransferParticipants', 'lockEmploymentEmployee', 'retryActivation']),
    ...byId,
  }),
  // ---- employment/routes.ts registerForwardUpdates：向后更新预览、直接编辑、导入 ------------------------------------------
  // 新增预览：resource=id 人员范围 404「任职数据不存在」；normalizeEmploymentInput 400；Employment.Preview(detail)；
  // previewEmploymentForwardUpdate 内 requireEmploymentScope（员工、输入部门、继承出的部门）→ 404「任职数据不存在」；
  // forwardUpdateEmployment(dryRun) 对后续记录按 DEC-178 可见判定（LINKED_RECORD_OUT_OF_SCOPE）
  'POST /employees/:id/forward-update-preview': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Employment.Preview', 'detail'),
    guards: [LINKAGE],
    scope: guardScope('employment.forwardPreview', NF_DATA),
    fields: RESPONSE,
    write: previewWrite,
    ...byId,
  }),
  // 编辑预览：normalizeBusinessPatch 400；loadEmploymentBusiness（DEC-177）404「任职业务不存在」→ tenant.employment.read 别名 →
  // Employment.Preview(detail)；loadEmploymentRecord 带范围取不到 → 409「只能预览有效任职记录的编辑」；editedValues 内
  // requireScopedEmploymentObject（差异 7）；dryRun 向后更新按 DEC-178
  'POST /records/:id/forward-update-preview': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Employment.Preview', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: pointScope({ param: 'id' }, 'employment.business', NF_BUSINESS),
    fields: RESPONSE,
    write: previewWrite,
    ...byId,
  }),
  // 导入预览：readPageContext(list, resource=id)（人员范围 404「任职数据不存在」）；normalizeEmploymentImport 400；
  // Employment.Preview(detail)；authorizeImport(preview)：create 行查输入部门范围、edit 行 authorizeBusinessWrite（写入口径，
  // 看全部用户另查 tenant.employment.write 别名）+ requireEmployeeTransferBusiness + 改部门范围；不包装失败导入日志（现状）
  'POST /employees/:id/import/forward-update-preview': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Employment.Preview', 'detail'),
    guards: [
      'employment.businessWrite',
      'transfer.source',
      'transfer.direct',
      DIRECT_OPERATION,
      'employment.employeeTransferBusiness',
      LINKAGE,
    ],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    rows: IMPORT_PREVIEW_ROWS,
    write: previewWrite,
    ...byId,
  }),
  // 直接编辑记录：If-Match 必填；normalizeBusinessPatch 400；authorizeBusinessWrite（写入口径 404）→ requireEmploymentWrite
  // ('update', patch, Employment.Edit) → 改 departmentId 时 requireScopedEmploymentObject；命令内 editEmploymentRecord 锁 +
  // 版本 + editedValues 再判新旧部门（DEC-193）+ 向后更新（DEC-178）
  'PATCH /records/:id': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentWrite('body.fields+customFields', [
      'lockTransferBusiness',
      'lockEmploymentBusiness',
      'assertRevision',
      'requireScopedEmploymentObject',
      'requireLinkedEmploymentRecord',
    ]),
    ...byId,
  }),
  // 任职导入（单人，§3.6）：readContext('object.view', If-Match 必填, resource=id)（人员范围 404「任职数据不存在」+ 看全部的
  // tenant.employment.read 别名）；withFailedImportLog 包住 normalizeEmploymentImport（400）、Employment.Import@list（403）、
  // requireImportTransferAccess（批内调动 → requireTransferSource(hr) / 直接调动 → requireDirectTransfer）与逐行授权
  // （IMPORT_ROWS）；命令内 importWithTransferAuthorization 锁 + 复核 + 整批提交 + 任务级操作日志；items 不是数组 → total 0 不记
  'POST /employees/:id/import': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: button('Employment.Import', 'list'),
    guards: [
      'employment.businessWrite',
      'transfer.source',
      'transfer.direct',
      'employment.importTransferAccess',
      DIRECT_OPERATION,
      'employment.employeeTransferBusiness',
      LINKAGE,
    ],
    scope: guardScope('employment.scope', NF_DATA),
    fields: projector('employment.response', 'employment.importResult'),
    rows: IMPORT_ROWS,
    write: employmentWrite(
      { rows: 'items[*]' },
      [
        'lockImportParticipants',
        'lockEmploymentEmployee',
        'assertRevision',
        'requireImportTransferAccess',
        'validateImportRevisions',
        'requireScopedEmploymentObject',
        'requireLinkedEmploymentRecord',
      ],
      { ledger: 'single' },
    ),
    failureAudit: {
      kind: 'import',
      rows: 'items',
      objectType: 'employment-record',
      anchors: 'audit.rawImportRows',
      resolveAnchors: 'employment.failedImportAnchors',
      scopeEmployee: { param: 'id' },
    },
    ...byId,
  }),
  // ---- employment/routes.ts registerBatchEdit（R1-T16 / AC-AUD-03）---------------------------------------------------
  // 不要求 If-Match（items[*].revision 逐条比对）；normalizeBatchEdit 400（1～100 条、不重复）；requireEmploymentWrite('update',
  // body.patch, Employment.Edit) 一次；逐条 authorizeBusinessWrite（写入口径 404）+ 改部门时 requireScopedEmploymentObject；
  // 命令内逐条 editEmploymentRecord 整单同事务；响应 { total, succeeded, failed, items }（协议键）
  'POST /records/batch-edit': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    rows: {
      path: 'items[*]',
      fields: none('字段取自共享的 body.patch（fields + customFields），不逐行提取'),
      target: { body: 'items[*].id' },
      batch: 'atomic',
    },
    write: employmentWrite(
      'body.fields+customFields',
      [
        'recordOwners',
        'lockEmploymentBusiness',
        'assertRevision',
        'requireScopedEmploymentObject',
        'requireLinkedEmploymentRecord',
      ],
      { ledger: 'single' },
    ),
  }),
  // ---- employment/routes.ts registerSettings / registerCustomFields：任职配置 ----------------------------------------
  'GET /settings': configurationView(SETTINGS, SETTINGS_FIELDS),
  // body 严格 { allowDirectTransfer }（400）；审计 employment.settings.update / employment_settings
  'PUT /settings': configuration(SETTINGS, 'update', SETTINGS_FIELDS, auditedConfigWrite('employment_settings')),
  // R2 BE-2b 入职生成邮箱规则（34 EN-R12）：规则整份挂在任职设置对象的 entryEmailRules 字段上；GET 返回 { revision, entryEmailRules }；
  // PUT body 严格 { entryEmailRules }（≤ 20 条、名称不重复、组织存在、后缀合法，400）；If-Match 为当前版本号（409）；
  // 审计 employment.entry_email_rules.update / employment_settings
  'GET /entry-email-rules': configurationView(SETTINGS, SETTINGS_FIELDS),
  'PUT /entry-email-rules': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('employment_settings'),
  ),
  // body 严格 { name, valueType, objectType }（400）；If-Match 须为 0（createCustomField 断言）；每类型上限 200 → 503；
  // 审计 employment.custom_field.create / employment_custom_field
  'POST /custom-fields': configuration(
    CUSTOM_FIELD,
    'create',
    CUSTOM_FIELD_FIELDS,
    auditedConfigWrite('employment_custom_field'),
  ),
  // objectType 查询非法 → 400；hasDataPermission 恒 true（配置对象无范围）
  'GET /custom-fields': configurationView(CUSTOM_FIELD, CUSTOM_FIELD_FIELDS),
  // 管理员别名先于 uuidParam（非 UUID → 400）；body 严格 { inherit }（400）；字段不存在 → 404「自定义字段不存在」；
  // 审计 employment.custom_field.inheritance / employment_custom_field
  'PUT /custom-fields/:id/inheritance': configuration(
    CUSTOM_FIELD,
    'update',
    CUSTOM_FIELD_FIELDS,
    auditedConfigWrite('employment_custom_field'),
    byId,
  ),
  // ---- employment/entry-routes.ts：R2 BE-2a 待入职状态动作（34 EN-R8 / R9 / R10 / R14）---------------------------------
  // 办理入职：If-Match = 业务 revision；body 严格 { probation, contract? }（400；contract = 合同字段白名单，BE-2b，同事务调
  // generateContractForBusiness，合同权限 / 范围按合同对象重验，失败整笔回滚；
  // 字段创建权 + 合同“新建”按钮 + 合同数据范围由 CommandGuard.before 在命令事务内复核，首次 / 重放 / 回查三个出口都覆盖）；
  // readContext('object.update') + Employment.Edit（命令式，
  // 空字段集合）+ authorizeBusinessWrite（写入口径 404「任职业务不存在」）；办理入职同事务清除待入职合同（F-194，正式合同仍只按
  // 请求里的 contract 生成一份，不带 contract 则不生成）；命令内 lockPendingEntry（调动参与者 → 员工 → 业务头，
  // 范围 DEC-193）→ 只有待入职可办 409 NOT_PENDING_ENTRY / 已取消 409 ENTRY_CANCELLED → DEC-138 / 139 入职日 × 部门校验（400）
  'POST /pending-entries/:id/complete': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE, 'employment.entryContract'],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'lockTransferBusiness',
      'lockEmploymentBusiness',
      'assertRevision',
      'requireScopedEmploymentObject',
      'requireLinkedEmploymentRecord',
    ]),
    ...byId,
  }),
  // 取消入职：body 严格 { reason?（5 项枚举）, remark? }（400）；重复取消 409 ENTRY_STATUS_UNCHANGED；审计 employment.record.status
  'POST /pending-entries/:id/cancel': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'lockTransferBusiness',
      'lockEmploymentBusiness',
      'assertRevision',
      'requireScopedEmploymentObject',
    ]),
    ...byId,
  }),
  // 改期入职：body 严格 { effectiveDate（必填）, remark? }（400）；requireEmploymentWrite 按 { effectiveDate } 校验字段写权限
  // （无该字段写权限 403，不落库）；先删原待入职、再按新日期、原业务类型与字段重建（同事务，记录 ID 变更）；
  // 后面还有任职记录 / 在途申请 → 删除一步拒绝，整笔回滚；入职日 × 部门校验同添加（DEC-138 / 139）；
  // F-194：同事务把待入职合同起始日改成新日期（合同随新记录搬运），响应在业务之外加 contractNotice { startDate, endDate }
  // （存量待入职没有合同则为 null），合同联动写字段级审计（前后值）
  'POST /pending-entries/:id/postpone': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentWrite(
      'body',
      [
        'lockTransferBusiness',
        'lockEmploymentBusiness',
        'assertRevision',
        'requireScopedEmploymentObject',
        'requireLinkedEmploymentRecord',
        'assertNoPendingApplication',
        'lockEmploymentEmployee',
      ],
      { controls: ['remark'] },
    ),
    ...byId,
  }),
  // 编辑待入职（F-188，R2e8 行内“编辑”）：body 严格 { effectiveDate（必填，允许过去日期）, probation（必填布尔）,
  // employType?（internal / intern，R2e9）}（400）；
  // 同改期按 { effectiveDate, employType? } 校验字段写权限（无权限 403，不落库），probation 是控制项不进字段协议；
  // 只有待入职可编辑 409 NOT_PENDING_ENTRY；日期变了 = 删除原记录并按新日期重建、保持原入职状态（正常 / 延期 / 取消不变）、
  // 试用期搬到新记录；日期与雇佣关系都没变只更新试用期（记录 ID 不变，revision +1）；雇佣关系变了同样替换记录；不联动 Offer / 信息采集；
  // 待入职合同起止日不变（F-194，换日期时原样搬到新记录），响应不带 contractNotice
  'PATCH /pending-entries/:id': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentWrite(
      'body',
      [
        'lockTransferBusiness',
        'lockEmploymentBusiness',
        'assertRevision',
        'requireScopedEmploymentObject',
        'requireLinkedEmploymentRecord',
        'assertNoPendingApplication',
        'lockEmploymentEmployee',
      ],
      { controls: ['probation'] },
    ),
    ...byId,
  }),
  // 生成邮箱（EN-R12）：If-Match = 业务 revision；body 严格 {}（400）；readContext('object.update') + Employment.Edit（命令式）+
  // authorizeBusinessWrite；命令内 lockPendingEntry（范围 DEC-193；非待入职 409 NOT_PENDING_ENTRY、已取消 409 ENTRY_CANCELLED）；
  // 只读规则与人员 / 账号邮箱，成功、失败、跳过、无规则都写审计 employment.entry.email_generate，不回写人员档案；
  // 回执是固定形状（status / email / reason / ruleId / ruleName），  // 用显式投影 emailReceipt 而不是通用任职字段裁剪（否则 email 被裁空）
  'POST /pending-entries/:id/generate-email': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION],
    scope: BUSINESS_WRITE,
    fields: projector('employment.response', 'employment.emailReceipt'),
    write: employmentCommand([
      'lockTransferBusiness',
      'lockEmploymentBusiness',
      'assertRevision',
      'requireScopedEmploymentObject',
    ]),
    ...byId,
  }),
  // 删除待入职（不可恢复）：object.delete + Employment.Delete；只有待入职可删 409 NOT_PENDING_ENTRY；删除内核同
  // DELETE /businesses/:id（transitionEmployment delete，在途申请 409）；同事务清除待入职合同（F-194，留前值审计）
  'DELETE /pending-entries/:id': object({
    object: EMPLOYMENT,
    operation: 'delete',
    button: button('Employment.Delete', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentCommand([
      'lockTransferBusiness',
      'lockEmploymentBusiness',
      'assertRevision',
      'requireScopedEmploymentObject',
      'assertNoPendingApplication',
      'requireLinkedEmploymentRecord',
    ]),
    ...byId,
  }),
  // ---- employment/exit-routes.ts：R2-T03 B2b 离职办理入口（设计 §4 / §4A / §9.1；命令内复核 exitCommandGuard）--------
  // 预览：readContext(object.view, resource=id) 人员范围 404「任职数据不存在」；body 严格 { lastWorkDate }（400）；
  // Dimission / DimissionApproval 任一（两项都无 403）；只读，清单逐项按 DEC-177 可见 + 字段查看权披露
  'POST /exits/employees/:id/preview': any(
    [exitPreview(EXIT_BUTTONS.direct), exitPreview(EXIT_BUTTONS.application)],
    byId,
  ),
  // 新建：If-Match 必填；resource=id 人员范围 404；body 不接受 kind（400）；按 mode 取按钮（direct → Dimission、
  // application → DimissionApproval），不要求 Employment.Create；字段 = 任职载荷 + exit 区块；带 departmentId 时
  // requireEmploymentScope；命令内员工锁 → 门禁（§4A：未办结离职 / 字典 / §8A / §8B / §8 令牌）→ 申请服务
  'POST /exits/employees/:id': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: EXIT_CREATE_BUTTON,
    guards: [LINKAGE],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    write: employmentWrite('body.fields+customFields', EXIT_CREATE_PRECONDITIONS, { controls: ['exit'] }),
    ...byId,
  }),
  // 批量申请：items 1～100（400）；逐人范围 / DimissionApproval / 字段在命令内复核（exitBatchGuard），不通过的人与
  // 业务前置条件一起作为逐条原因：任一人不满足 → 整批 409 EXIT_BATCH_REJECTED、无任何写入；每人建申请并提交
  'POST /exits/batch': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button(EXIT_BUTTONS.application, 'detail'),
    guards: [LINKAGE],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    rows: {
      path: 'items[*]',
      fields: 'body',
      target: { body: 'items[*].employeeId' },
      batch: 'atomic',
    },
    write: employmentWrite('body', [...EXIT_CREATE_PRECONDITIONS, 'assertTransition'], { controls: ['exit'] }),
  }),
  // F-140b1：If-Match 必填；body = 离职扩展字段 + 计划日期 + 确认控制项；范围外与不存在均 404。
  // DimissionEdit，审批中的单另需 adminIntervene（B-65a）；已生效日期仍拒绝。
  'PATCH /exits/:id': all(
    [
      object({
        object: EMPLOYMENT,
        operation: 'update',
        button: button(EXIT_BUTTONS.edit, 'detail'),
        guards: [LINKAGE],
        scope: BUSINESS_WRITE,
        fields: RESPONSE,
      }),
      object({
        object: APPROVAL_INSTANCE_OBJECT,
        operation: 'button',
        button: button('adminIntervene', 'detail'),
        scope: noScope('只判按钮：单据处于 in_review 时才要求（与审批编辑同约束）'),
        fields: noFields('只决定能否编辑审批中的离职单'),
      }),
    ],
    RESPONSE,
    {
      write: employmentWrite('body', ['lockEmploymentBusiness', 'assertRevision', 'requireExitGate'], {
        controls: ['pendingTransferAck', 'confirmed'],
      }),
      ...byId,
    },
  ),
  // 提交 / 撤回：If-Match 必填；写入口径 404，不是离职单 404；DimissionApproval（hr 发起，不要求 Employment.Submit /
  // Withdraw）；提交只接受 { pendingTransferAck }、只允许原发起人（403 EXIT_SUBMIT_INITIATOR_ONLY）；命令内状态迁移 + 审批钩子
  'POST /exits/:id/submit': exitTransition(),
  'POST /exits/:id/withdraw': exitTransition(),
  // ---- employment/retirement-routes.ts：R2-T04 BE-5a 退休办理入口（设计 §12.1；与离职同一门禁，按钮取 Retire*）------------
  // 预览 / 新建 / 编辑 / 提交 / 撤回：权限链、范围、命令内复核（exitCommandGuard / exitEditGuard）与 exits 对应入口一致，
  // 差异只有按钮（Employment.Retire / RetireApproval / RetireEdit）与退休专有字段（离职专用字段 400 RETIREMENT_FIELD_NOT_ALLOWED）；
  // 预览另返回创建时将冻结的预计退休日期与派生的退休类型
  'POST /retirements/employees/:id/preview': any(
    [exitPreview(RETIREMENT_BUTTONS.direct), exitPreview(RETIREMENT_BUTTONS.application)],
    byId,
  ),
  'POST /retirements/employees/:id': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: RETIREMENT_CREATE_BUTTON,
    guards: [LINKAGE, 'employment.rehire'],
    scope: guardScope('employment.scope', NF_DATA),
    fields: RESPONSE,
    write: employmentWrite('body.fields+customFields', EXIT_CREATE_PRECONDITIONS, { controls: ['exit'] }),
    ...byId,
  }),
  'PATCH /retirements/:id': all(
    [
      object({
        object: EMPLOYMENT,
        operation: 'update',
        button: button(RETIREMENT_BUTTONS.edit, 'detail'),
        guards: [LINKAGE],
        scope: BUSINESS_WRITE,
        fields: RESPONSE,
      }),
      object({
        object: APPROVAL_INSTANCE_OBJECT,
        operation: 'button',
        button: button('adminIntervene', 'detail'),
        scope: noScope('只判按钮：单据处于 in_review 时才要求（与审批编辑同约束）'),
        fields: noFields('只决定能否编辑审批中的退休单'),
      }),
    ],
    RESPONSE,
    {
      write: employmentWrite('body', ['lockEmploymentBusiness', 'assertRevision', 'requireExitGate']),
      ...byId,
    },
  ),
  'POST /retirements/:id/submit': exitTransition(RETIREMENT_BUTTONS.application),
  'POST /retirements/:id/withdraw': exitTransition(RETIREMENT_BUTTONS.application),
  // ---- employment/retirement-routes.ts：R2-T04 BE-5a′ 撤销退休（设计 §6 / §12.1；与撤销离职同一个 cancelExit，按钮取 RetireCancel）----
  // 权限链、范围、命令内复核（exitCommandGuard）、回执裁剪与 exits 对应入口一致；路径的业务类型与单据 kind 不一致一律 404
  'POST /retirements/:id/cancel': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(RETIREMENT_BUTTONS.cancel, 'detail'),
    guards: [LINKAGE],
    scope: BUSINESS_WRITE,
    fields: projector('employment.response', 'employment.exitCancelReceipt'),
    write: employmentCommand(['lockEmploymentBusiness', 'assertRevision', 'requireExitGate']),
    ...byId,
  }),
  'POST /retirements/:id/restore': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(RETIREMENT_BUTTONS.cancel, 'detail'),
    scope: BUSINESS_WRITE,
    fields: fixed(['error'], '固定拒绝：409 EXIT_RESTORE_NOT_SUPPORTED，没有业务响应'),
    write: write('body', none('只读拒绝：没有命令事务，没有提交前足迹'), none('只读拒绝：没有业务响应')),
    ...byId,
  }),
  'PATCH /retirements/cancellations/:id': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(RETIREMENT_BUTTONS.cancel, 'detail'),
    scope: guardScope('employment.exitCancellation', NF_BUSINESS),
    fields: projector('employment.response', 'employment.exitCancellation'),
    write: employmentCommand(['requireEmployeeInScope', 'assertRevision']),
    ...byId,
  }),
  // ---- employment/exit-routes.ts：R2-T03 B4 撤销离职（设计 §7.1 / §7.3 / §9.1；命令内复核 exitCommandGuard）-------------------
  // 撤销：If-Match 必填；readContext(object.update) → DimissionCancel（命令式）→ authorizeBusinessWrite（范围外 404）→ 非离职单 404；
  // body 严格 { reason, confirmed? }，reason 缺失 / 空白 400；命令内员工闭包 → 业务头 → 组织 → 编制 → 审批实例，approved / effective
  // 过 §6B（停用交集 409 EMPLOYMENT_DEPARTMENT_DISABLED，超编 409 CONFIRMATION_REQUIRED）；回执固定形状，业务头按任职字段权裁剪，
  // 撤销清单目标按各自对象可见性裁剪（不可见只计 hiddenCount）
  'POST /exits/:id/cancel': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(EXIT_BUTTONS.cancel, 'detail'),
    guards: [LINKAGE],
    scope: BUSINESS_WRITE,
    fields: projector('employment.response', 'employment.exitCancelReceipt'),
    write: employmentCommand(['lockEmploymentBusiness', 'assertRevision', 'requireExitGate']),
    ...byId,
  }),
  // restore：授权先于不支持（B-57）——功能权 / DimissionCancel / 范围外 404 之后一律 409 EXIT_RESTORE_NOT_SUPPORTED，无命令事务
  'POST /exits/:id/restore': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(EXIT_BUTTONS.cancel, 'detail'),
    scope: BUSINESS_WRITE,
    fields: fixed(['error'], '固定拒绝：409 EXIT_RESTORE_NOT_SUPPORTED，没有业务响应'),
    write: write('body', none('只读拒绝：没有命令事务，没有提交前足迹'), none('只读拒绝：没有业务响应')),
    ...byId,
  }),
  // 修改撤销原因（DM-R5）：If-Match = 撤销记录 revision；DimissionCancel + 所属员工范围（范围外 / 不存在 404）；
  // body 严格 { reason }（400）；只有 reason 可改，审计 exit.cancellation.update
  'PATCH /exits/cancellations/:id': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(EXIT_BUTTONS.cancel, 'detail'),
    scope: guardScope('employment.exitCancellation', NF_BUSINESS),
    fields: projector('employment.response', 'employment.exitCancellation'),
    write: employmentCommand(['requireEmployeeInScope', 'assertRevision']),
    ...byId,
  }),
  // ---- employment/exit-routes.ts：R2-T03 B5 离职视图与详情（设计 §3.2 / §9.1）---------------------------------------------
  // 视图：view ∈ in_progress / completed / all / cancellations（缺失或不合法 400）；筛选 departmentId（含下级，可 includeChildren=false）/
  // keyword / lastWorkDateFrom / lastWorkDateTo / exitTypeCode / reasonCode / whereaboutsCode / status（仅离职中 / 全部）/
  // initiation 严格校验 400；readPageContext(list)，筛选用到的字段不可查看 403「筛选字段不可查看」；分页前 employmentVisibilitySql
  // （DEC-177）过滤，total 与本页同一语句；任职字段按任职记录、姓名 / 工号按人员对象可见字段裁剪（无权缺席），activation /
  // cancellation 是控制项，行可见即可见
  'GET /exits': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    guards: ['employment.viewableFilters'],
    scope: listScope('employment.visibility'),
    fields: projector('employment.response', 'employment.exitViews'),
  }),
  // 详情：readPageContext(detail)；loadEmploymentBusiness（DEC-177）看不见 / 不存在 / 非离职单同一个 404「任职业务不存在」；
  // requirePermission(tenant.employment.read, resource=employeeId)；效果台账只给汇总件数（无目标 ID）
  'GET /exits/:id': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.business', NF_BUSINESS),
    fields: projector('employment.response', 'employment.exitDetail'),
    ...byId,
  }),
  // ---- employment/retirement-view-routes.ts：R2-T04 BE-5d1 退休五视图与详情（设计 §10、§12.1）-----------------------------
  // 视图：view ∈ upcoming / overdue / processing / completed / all / cancelled（缺失或不合法 400）；
  // cancelled = 撤销的退休（F-277，沿用离职撤销视图，不按 asOf）；asOf 缺省租户今天（不合法 400）；
  // upcomingDays 1～365 整数（缺省读 retirement.upcoming_days，不合法 400）；readPageContext(list)，
  // 分页前 employmentVisibilitySql（DEC-177）过滤，total 与本页同一语句；
  // 任职字段按任职记录、姓名 / 工号 / 预计退休日期及弹性上下限按人员对象可见字段裁剪（无权缺席）
  'GET /retirements': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    scope: listScope('employment.visibility'),
    fields: projector('employment.response', 'employment.retirementViews'),
  }),
  // 详情：readPageContext(detail)；loadEmploymentBusiness（DEC-177）看不见 / 不存在 / 非退休单同一个 404「任职业务不存在」
  'GET /retirements/:id': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.business', NF_BUSINESS),
    fields: projector('employment.response', 'employment.retirementDetail'),
    ...byId,
  }),
  // ---- employment/exit-routes.ts：R2-T03 离职三个字典（设计 §2.1 / §4 / §9.1）-----------------------------------------
  // :dict ∉ types / reasons / whereabouts → 400；enabled 查询非法 → 400；字典无组织字段，不按范围裁剪，返回固定键
  'GET /exits/dictionaries/:dict': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('字典读取无按钮（表单下拉、列表显示名称）'),
    scope: noScope('离职字典是租户配置，无组织 / 人员字段（设计 §9.1 字典行）'),
    fields: fixed(EXIT_DICTIONARY_KEYS, 'R2-T03 设计 §2.1：字典项固定键，配置对象不做字段裁剪'),
    ...byId,
  }),
  // body 严格 { code, name, enabled?, displayOrder? }（400）；If-Match 须为 0；编码重复（不分大小写）→ 409
  // EXIT_DICTIONARY_CODE_TAKEN；审计 exit_dictionary.save / exit_dictionary
  'POST /exits/dictionaries/:dict': configuration(
    SETTINGS,
    'create',
    SETTINGS_FIELDS,
    auditedConfigWrite('exit_dictionary'),
    byId,
  ),
  // 管理员别名先于 :dict / uuidParam 校验（400）；body 严格 { code?, name?, enabled?, displayOrder? }，改编码 → 400
  // EXIT_DICTIONARY_CODE_IMMUTABLE；项不存在 → 404「离职字典项不存在」；审计 exit_dictionary.save / exit_dictionary
  'PUT /exits/dictionaries/:dict/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('exit_dictionary'),
    byId,
  ),
  // ---- employment/probation-routes.ts：R2 BE-3 试用期与转正（29 §2.1 / §2.3，差距表 B1 / B3～B8）----------------------------
  // 四个视图：view ∈ expiring / in_review / all / regularized（缺失或不合法 400；其余筛选 employeeId / keyword /
  // departmentId / postId / expectedEndFrom / expectedEndTo 严格校验 400）；readPageContext(list)，listProbationView 的
  // employmentScopePredicate = scopeSql（人员 / 当前主职部门 / 创建人，范围为空什么也看不到）；行字段按任职记录可见字段裁剪，试用期 / 转正信息是控制项
  // 显式放回（同入职视图），姓名 / 工号按人员对象可见字段另行裁剪；hasDataPermission 协议键
  'GET /probation-views': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    scope: listScope('module.scopeSql'),
    fields: projector('employment.response', 'employment.probationViews'),
  }),
  // 试用人员详情（B6）：readPageContext(detail, resource=id) 人员范围 → 404「任职数据不存在」；不在职 404；
  // 记录行按 DEC-177 可见谓词（employmentVisibilitySql）列出并按任职字段权裁剪，转正日期投影（PB-R13）与试用信息是控制项
  'GET /employees/:id/probation': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.employee', NF_DATA),
    fields: projector('employment.response', 'employment.probationDetail'),
    ...byId,
  }),
  // 调整试用信息（B6，PB-R9～R12）：If-Match = 员工 revision；body 严格 { hasProbation, startDate?, months?(1～6),
  // expectedEndDate?, regularizationDate? }（400）；readContext('object.update', resource=id) 人员范围 404「任职数据不存在」+
  // Employment.Edit（命令式，试用期是控制项不进字段协议）；命令内 lockEmploymentEmployee（409 REVISION_CONFLICT）→ 互斥
  // （转正申请审批中 409 PROBATION_PROCESS_IN_REVIEW）→ PB-R11 / PB-R10（未生效转正记录 409
  // PROBATION_REGULARIZATION_NOT_EFFECTIVE）/ PB-R12（400）→ 追加试用期版本；是否有试用期变化时
  // switchProbationStatus 改开启记录及其后同周期记录的人员状态（requireScopedEmploymentObject，向后按 DEC-178 联动）；
  // CommandGuard.before 在命令事务内复核对象编辑权、按钮与员工范围；回执是试用信息固定形状
  'PUT /employees/:id/probation': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: guardScope('employment.scope', NF_DATA),
    fields: projector('employment.probationDetail', 'employment.probationDetail'),
    write: employmentWrite(
      'body.fields+customFields',
      [
        'lockEmploymentEmployee',
        'assertRevision',
        'assertProbationProcessesIdle',
        'lockEmploymentBusiness',
        'requireScopedEmploymentObject',
        'requireLinkedEmploymentRecord',
      ],
      {
        commandOnly: true,
        controls: ['hasProbation', 'startDate', 'months', 'expectedEndDate', 'regularizationDate'],
      },
    ),
    ...byId,
  }),
  // 单个 / 批量转正（B7 / B8，PB-R8）：不要求 If-Match（items[*].revision 逐人比对员工 revision）；body 严格
  // { mode, effectiveDate?, probationResult, items[1～100] }，同一员工重复 400；试用结果须为字典启用项（400）；
  // requireEmploymentWrite('create', { kind, mode, effectiveDate? }, Employment.Create)；命令内逐人保存点：员工范围
  // （requireEmployeeInScope 404）→ 转正日期（统一填写或 F-205 默认，缺预计结束日 400）→ createEmploymentBusiness（直接转正
  // 互斥 409、生效即向后传播正式）→ 申请则 transitionEmployment(submit) + 审批中心发起；单人失败只记在本人回执
  'POST /regularizations': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button('Employment.Create', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: guardScope('employment.scope', NF_DATA),
    fields: projector('employment.regularizationReceipt', 'employment.regularizationReceipt'),
    rows: {
      path: 'items[*]',
      fields: none('字段取自共享的 { kind, mode, effectiveDate }，不逐行提取'),
      target: { body: 'items[*].employeeId' },
      batch: 'receipt',
    },
    write: employmentWrite(
      'body',
      [
        'requireEmployeeInScope',
        'lockEmploymentEmployee',
        'assertRevision',
        'assertProbationProcessesIdle',
        'requireScopedEmploymentObject',
        'requireLinkedEmploymentRecord',
      ],
      { controls: ['probationResult', 'items'] },
    ),
  }),
  // 转正改期（PB-R13，DEC-589）：If-Match = 转正单 revision；body 严格 { effectiveDate }（400）；requireEmploymentWrite 按
  // { effectiveDate } 校验字段写权限 + Employment.Edit；requireBusinessWriteScope（写入口径 404「任职业务不存在」）；命令内
  // lockEmploymentBusiness（409 REVISION_CONFLICT）→ 非转正单 / 非已生效或审批通过 409 → 周期外 400
  // REGULARIZATION_DATE_OUT_OF_CYCLE → 区间内离职 / 转正 / 入职类 409 REGULARIZATION_RESCHEDULE_BLOCKED（列出冲突）→
  // 追加人工改期载荷版本、重建时间轴（validateTransferReposition 复核插入点），区间内记录按 DEC-178 联动重算人员状态；
  // CommandGuard.before（pendingActionGuard 同口径）在命令事务内复核
  'POST /businesses/:id/regularization-date': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button('Employment.Edit', 'detail'),
    guards: [DIRECT_OPERATION, LINKAGE],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentWrite('body', [
      'lockEmploymentBusiness',
      'assertRevision',
      'requireScopedEmploymentObject',
      'requireLinkedEmploymentRecord',
    ]),
    ...byId,
  }),
  // 试用结果字典（B7）：读取对持任职记录查看权者开放（转正表单下拉）；enabled 查询非法 → 400；无组织字段，不按范围裁剪
  // F-321：类别可空，配置对象沿用；读字典不受人员范围限制。
  'GET /employment-forms': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('用工形式表单下拉无按钮'),
    scope: noScope('用工形式是租户配置，无组织 / 人员字段'),
    fields: fixed(
      [
        'items',
        'categories',
        'id',
        'code',
        'name',
        'category',
        'displayOrder',
        'effectiveDate',
        'expiryDate',
        'enabled',
        'remark',
        'revision',
      ],
      'F-321：字典固定键',
    ),
  }),
  'POST /employment-forms': configuration(SETTINGS, 'create', SETTINGS_FIELDS, auditedConfigWrite('employment_form')),
  'PUT /employment-forms/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('employment_form'),
    byId,
  ),
  'GET /probation-results': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('字典读取无按钮（表单下拉、显示名称）'),
    scope: noScope('试用结果字典是租户配置，无组织 / 人员字段'),
    fields: fixed(PROBATION_RESULT_KEYS, 'BE-3：字典项固定键，配置对象不做字段裁剪'),
  }),
  // body 严格 { code, name, enabled?, displayOrder? }（400）；If-Match 须为 0；编码重复（不分大小写）→ 409
  // PROBATION_RESULT_CODE_TAKEN；审计 probation_result.save / probation_result
  'POST /probation-results': configuration(SETTINGS, 'create', SETTINGS_FIELDS, auditedConfigWrite('probation_result')),
  // 管理员别名先于 uuidParam 校验（400）；body 严格 { code?, name?, enabled?, displayOrder? }，改编码 → 400
  // PROBATION_RESULT_CODE_IMMUTABLE；项不存在 → 404「试用结果不存在」；审计 probation_result.save / probation_result
  'PUT /probation-results/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('probation_result'),
    byId,
  ),
  // ---- employment/blacklist-routes.ts：R2 BE-8a 黑名单（B68，差距表“补证结论 R2f”、DEC-569）----------------------------
  // 无组织字段，数据范围只认看全部：无看全部 → 200 items: []、hasDataPermission false；按敏感字段筛选须可查看（403）；
  // status / reason / source / pageSize 非法 → 400
  'GET /blacklist': blacklistPolicy('view', noButton('列表只按查看权与看全部过滤'), seeAll(EMPTY_LIST)),
  // If-Match 须为 0；body 严格（选人员时不能手填身份字段）→ 400；同一人员 / 证件号已在名单 409 BLACKLIST_DUPLICATE；
  // 员工不存在或不在任职范围 404「员工不存在」；审计 blacklist.create
  'POST /blacklist': blacklistPolicy('create', button('create', 'list'), seeAll(F_BLACKLIST), {
    guards: [BLACKLIST_EMPLOYEE],
    write: blacklistWrite('body', ['assertRevision', 'assertNotDuplicated']),
  }),
  // body 严格 { reason?, expiryDate?, note? }；已移出 409 BLACKLIST_REMOVED；审计 blacklist.update
  'PUT /blacklist/:id': blacklistPolicy('update', button('update', 'list_row'), seeAll(NF_BLACKLIST), {
    write: blacklistWrite('body', ['assertRevision', 'requireActive']),
    ...byId,
  }),
  // 工具栏 / 行内移出共用：body { items: [{ id, revision }] } 1～100 条整批；审计 blacklist.remove
  'POST /blacklist/remove': blacklistPolicy('update', button('remove', 'list'), seeAll(NF_BLACKLIST), {
    write: blacklistWrite('body', ['assertRevision', 'requireActive'], true),
  }),
  // 删除整行（审计 blacklist.delete 留快照）：body 同移出
  'POST /blacklist/delete': blacklistPolicy('delete', button('delete', 'list'), seeAll(NF_BLACKLIST), {
    write: blacklistWrite('body', ['assertRevision'], true),
  }),
  // 离职自动加黑规则：任职设置配置对象（审计 blacklist_rule.*）；条件只认“离职次数 ≥ N”，期限只认永久 / 离职当月
  'GET /blacklist-rules': configurationView(SETTINGS, SETTINGS_FIELDS),
  'POST /blacklist-rules': configuration(SETTINGS, 'create', SETTINGS_FIELDS, auditedConfigWrite('blacklist_rule')),
  'PUT /blacklist-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('blacklist_rule'),
    byId,
  ),
  // 配置对象没有删除操作：沿用 update（空字段集合）
  'DELETE /blacklist-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    write('body', 'config.audited:blacklist_rule', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // ---- employment/exit-handover-routes.ts：R2 BE-8b1 离职交接事项设置（B64，DEC-266③）----------------------------------
  // 同自动加黑规则：任职设置配置对象（审计 exit_handover_item.*）；字段只有类别 / 序号 / 待办类别 / 待办事项 / 办理表单 / 备注
  'GET /exit-handover-items': configurationView(SETTINGS, SETTINGS_FIELDS),
  'POST /exit-handover-items': configuration(
    SETTINGS,
    'create',
    SETTINGS_FIELDS,
    auditedConfigWrite('exit_handover_item'),
  ),
  'PUT /exit-handover-items/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('exit_handover_item'),
    byId,
  ),
  // 配置对象没有删除操作：沿用 update（空字段集合）
  'DELETE /exit-handover-items/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    write('body', 'config.audited:exit_handover_item', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // ---- employment/auto-regularization-routes.ts：R2 BE-15a 自动转正规则与立即执行（B57，DEC-533② / DEC-539）--------------
  // 同自动加黑规则：任职设置配置对象；body 严格（到期前天数 0～999 整数，否则 400 AUTO_RULE_DAYS_INVALID“请设置0至999的整数”；
  // 名称 / 适用组织 / 业务处理规则 / 发起人类型必填，试用结果须为字典启用项）；审计 auto_regularization_rule.*
  'GET /auto-regularization-rules': configurationView(SETTINGS, SETTINGS_FIELDS),
  'POST /auto-regularization-rules': configuration(
    SETTINGS,
    'create',
    SETTINGS_FIELDS,
    auditedConfigWrite('auto_regularization_rule'),
  ),
  'PUT /auto-regularization-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('auto_regularization_rule'),
    byId,
  ),
  // 复制：If-Match 0，另建一条（名称加“（复制）”、默认停用）；源规则不存在 404
  'POST /auto-regularization-rules/:id/copy': configuration(
    SETTINGS,
    'create',
    SETTINGS_FIELDS,
    write('body', 'config.audited:auto_regularization_rule', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // 单条启停（DEC-533②，复刻增加）：body 严格 { enabled }；审计 auto_regularization_rule.enable / disable
  'PUT /auto-regularization-rules/:id/enabled': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('auto_regularization_rule'),
    byId,
  ),
  'DELETE /auto-regularization-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    write('body', 'config.audited:auto_regularization_rule', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // 立即执行（DEC-539①）：body 严格 { cursor? }（上次回执的 nextCursor，非 UUID 400）；
  // 总开关关闭 409 AUTO_REGULARIZATION_DISABLED；按规则适用组织扫描（系统批次提前执行，
  // 不叠加操作人数据范围），逐人保存点经 BE-3 转正入口发起，审计 employment.auto_regularization.launch；回执固定形状
  'POST /auto-regularization/run': all(
    [
      admin('other_settings', { alias: 'tenant.employment.configuration.write', fields: SETTINGS_FIELDS }),
      object({
        object: SETTINGS,
        operation: 'update',
        button: noButton('配置对象无按钮：requireEmploymentWrite 只查 object.update（命令式空字段集合）'),
        // 逐人经 BE-3 转正入口发起：联动校验在 createEmploymentBusiness 里照常调用（系统批次不带数据范围）
        guards: [LINKAGE],
        // 准入只认配置写（配置对象无数据范围），办理按规则适用组织（系统批次，DEC-539①）；
        // 这里的范围是回执的人员披露：按操作人当前任职范围逐人过滤（visibleEmployees，首次与重放同一出口，第 2 轮审查 P1）
        scope: listScope('employment.runReceipt'),
        fields: SETTINGS_FIELDS,
      }),
    ],
    SETTINGS_FIELDS,
    {
      optional: { receiptDisclosure: RUN_RECEIPT_DISCLOSURE },
      write: write(
        'body',
        'config.audited:auto_regularization_run',
        none('配置对象无范围，回执只含员工 / 规则 / 业务 ID'),
        { commandOnly: true, preconditions: ['assertRevision'] },
      ),
    },
  ),
  // 立即执行（R2-T04 §9.2，BE-5c2）：?purpose= 必填（expected_date / flexible_range），body 严格 { cursor? }（上次回执的 next，
  // 随机句柄，绑定租户 × 操作人 × 用途 × 业务日，其余 400 RETIREMENT_RUN_CURSOR_INVALID）；对应自动计算开关关闭 400
  // RETIREMENT_AUTO_DISABLED；一次最多一页，按规则适用组织扫描（系统批次提前执行，不叠加操作人数据范围），经人事写端口写入
  // （审计 personnel.retirement_rule，actor = 系统）；回执逐人固定键，按操作人当前任职范围裁剪（首次与重放同一出口）
  'POST /retirement-rules/run': all(
    [
      admin('other_settings', { alias: 'tenant.employment.configuration.write', fields: SETTINGS_FIELDS }),
      object({
        object: SETTINGS,
        operation: 'update',
        button: noButton('配置对象无按钮：requireEmploymentWrite 只查 object.update（命令式空字段集合）'),
        // 准入只认配置写（配置对象无数据范围），办理按规则适用组织；这里的范围是回执的人员披露
        scope: listScope('employment.runReceipt'),
        fields: SETTINGS_FIELDS,
      }),
    ],
    SETTINGS_FIELDS,
    {
      optional: { receiptDisclosure: RETIREMENT_RUN_RECEIPT_DISCLOSURE },
      write: write('body', 'config.audited:retirement_rule_run', none('配置对象无范围，回执只含员工 / 规则 ID'), {
        commandOnly: true,
        preconditions: ['assertRevision'],
      }),
    },
  ),
  // ---- employment/retirement-rule-routes.ts：R2 BE-5c1a / 5c1b 预计退休日期与弹性范围规则、个人身份字典（R2-T04 §9.1，DEC-640 / 641）----
  // 同自动转正规则：任职设置配置对象；GET ?purpose= 缺省 expected_date，可选 flexible_range，其他取值 400；body 严格
  // （purpose：expected_date / flexible_range；ruleType：fixed_age 仅预计日期，退休年龄 30～80 岁、月数 0～11 / builtin 选用内置法定函数，
  // 弹性范围只能 builtin；条件为性别 / 国籍 / 雇佣关系（必填）/ 个人身份固定槽位，每槽至多一条、操作符只有 in，个人身份取值须为字典启用编码）；
  // 预置法定规则 PUT / DELETE 409 RETIREMENT_RULE_PRESET，可启停、可复制；PUT 不能改用途与类型；审计 retirement_rule.save / delete / enabled
  // F-269：读 = 任职记录查看权（设计 §12.1），同字典 GET；写仍是配置写。规则是租户配置，无组织 / 人员字段，不按范围裁剪
  'GET /retirement-rules': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('规则读取无按钮'),
    scope: noScope('退休规则是租户配置，无组织 / 人员字段'),
    fields: fixed(RETIREMENT_RULE_KEYS, 'R2-T04 §9.1：规则固定键，配置对象不做字段裁剪'),
  }),
  'POST /retirement-rules': configuration(SETTINGS, 'create', SETTINGS_FIELDS, auditedConfigWrite('retirement_rule')),
  'PUT /retirement-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('retirement_rule'),
    byId,
  ),
  // 复制：If-Match 0，另建一条（名称加“（复制）”、默认停用）；源规则不存在 404
  'POST /retirement-rules/:id/copy': configuration(
    SETTINGS,
    'create',
    SETTINGS_FIELDS,
    write('body', 'config.audited:retirement_rule', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // 单条启停：body 严格 { enabled }；审计 retirement_rule.enabled
  'PUT /retirement-rules/:id/enabled': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('retirement_rule'),
    byId,
  ),
  'DELETE /retirement-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    write('body', 'config.audited:retirement_rule', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // 个人身份字典（DEC-640③）只读：读取对持任职记录查看权者开放（人事表单下拉）；无 POST / PUT；无组织字段，不按范围裁剪
  'GET /retirement-identity-types': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('字典读取无按钮（表单下拉、显示名称）'),
    scope: noScope('个人身份字典是租户配置，无组织 / 人员字段'),
    fields: fixed(RETIREMENT_IDENTITY_TYPE_KEYS, 'R2-T04 §2.4：字典项固定键，配置对象不做字段裁剪'),
  }),
  // ---- employment/auto-assessment-routes.ts：R2 BE-15b2 自动发起试用期考核规则与立即执行（B58，DEC-533② / DEC-539）--------------
  // 同自动转正规则：任职设置配置对象；body 严格（入职后天数 1～999 整数，否则 400 AUTO_RULE_DAYS_INVALID“请设置1至999的整数”；
  // 考核名称 / 类型 / 适用组织 / 发起人类型必填，附加人员条件与失败通知按未知字段 400）；审计 auto_assessment_rule.*
  'GET /auto-assessment-rules': configurationView(SETTINGS, SETTINGS_FIELDS),
  'POST /auto-assessment-rules': configuration(
    SETTINGS,
    'create',
    SETTINGS_FIELDS,
    auditedConfigWrite('auto_assessment_rule'),
  ),
  'PUT /auto-assessment-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('auto_assessment_rule'),
    byId,
  ),
  // 复制：If-Match 0，另建一条（名称加“（复制）”、默认停用）；源规则不存在 404
  'POST /auto-assessment-rules/:id/copy': configuration(
    SETTINGS,
    'create',
    SETTINGS_FIELDS,
    write('body', 'config.audited:auto_assessment_rule', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // 单条启停（DEC-533②，复刻增加）：body 严格 { enabled }；审计 auto_assessment_rule.enable / disable
  'PUT /auto-assessment-rules/:id/enabled': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    auditedConfigWrite('auto_assessment_rule'),
    byId,
  ),
  'DELETE /auto-assessment-rules/:id': configuration(
    SETTINGS,
    'update',
    SETTINGS_FIELDS,
    write('body', 'config.audited:auto_assessment_rule', none('配置对象无范围，返回后只投影'), {
      commandOnly: true,
      preconditions: ['assertRevision'],
    }),
    byId,
  ),
  // 立即执行（DEC-539①）：body 严格 { cursor? }（上次回执的 nextCursor，非 UUID 400）；
  // 总开关关闭 409 AUTO_ASSESSMENT_DISABLED；按规则适用组织扫描（系统批次提前执行，
  // 不叠加操作人数据范围），逐人保存点经 BE-15b1 考核发起入口发起，审计 employment.auto_assessment.launch；回执固定形状
  'POST /auto-assessment/run': all(
    [
      admin('other_settings', { alias: 'tenant.employment.configuration.write', fields: SETTINGS_FIELDS }),
      object({
        object: SETTINGS,
        operation: 'update',
        button: noButton('配置对象无按钮：requireEmploymentWrite 只查 object.update（命令式空字段集合）'),
        // 逐人经 BE-15b1 考核发起入口发起：PB-R9 互斥在 launchAssessment 里照常判定（系统批次不带数据范围）
        // 准入只认配置写（配置对象无数据范围），办理按规则适用组织（系统批次，DEC-539①）；
        // 这里的范围是回执的人员披露：按操作人当前任职范围逐人过滤（visibleEmployees，首次与重放同一出口，第 2 轮审查 P1）
        scope: listScope('employment.runReceipt'),
        fields: SETTINGS_FIELDS,
      }),
    ],
    SETTINGS_FIELDS,
    {
      optional: { receiptDisclosure: RUN_RECEIPT_DISCLOSURE },
      write: write(
        'body',
        'config.audited:auto_assessment_run',
        none('配置对象无范围，回执只含员工 / 规则 / 考核 ID'),
        { commandOnly: true, preconditions: ['assertRevision'] },
      ),
    },
  ),
  // ---- employment/assessment-routes.ts：R2 BE-15b1 试用中考核 / 转正考核（B2，29 PB-R3～R6）------------------------------
  // 考核对象 TenantBase.ProbationAssessment：数据操作 + 详情级按钮 Assessment.Create / Assessment.Edit，范围按考核对象员工
  // （人员 / 部门维度，部门取创建时的主职部门快照）。列表按 scopeSql 过滤，筛选参数严格校验（未知参数 / 非法取值 400）
  'GET /probation-assessments': object({
    object: ASSESSMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    scope: listScope('module.scopeSql'),
    fields: projector('employment.response', 'employment.assessment'),
  }),
  // 详情：考核不存在或考核对象不在范围内同一个 404「考核记录不存在」（范围外不暴露存在性）
  'GET /probation-assessments/:id': object({
    object: ASSESSMENT,
    operation: 'view',
    button: noButton('详情无按钮'),
    scope: guardScope('employment.assessmentScope', NF_ASSESSMENT),
    fields: projector('employment.response', 'employment.assessment'),
    ...byId,
  }),
  // 选人批量发起（PB-R3）：body 严格 { assessmentType, assessmentName, assessmentDate, items[1～100]: { employeeId, revision } }；
  // 逐人保存点：员工范围 404 → 员工锁与 revision 比对 409 → 试用中校验 409 ASSESSMENT_NOT_PROBATION → PB-R9 互斥 409 →
  // 建考核并发起审批（没有匹配的流程 / 首节点审批人为空整人回滚）；回执固定形状，单人失败只记在他的回执里
  'POST /probation-assessments': object({
    object: ASSESSMENT,
    operation: 'create',
    button: button('Assessment.Create', 'detail'),
    guards: [DIRECT_OPERATION],
    scope: guardScope('employment.scope', NF_DATA),
    fields: projector('employment.assessmentReceipt', 'employment.assessmentReceipt'),
    rows: {
      path: 'items[*]',
      fields: none('字段取自共享的 { assessmentType, assessmentName, assessmentDate }，不逐行提取'),
      target: { body: 'items[*].employeeId' },
      batch: 'receipt',
    },
    write: write('body', 'assessment.create', none('回执只含逐人状态与考核 ID，创建与审批发起同事务'), {
      preconditions: ['requireEmployeeInScope', 'lockEmploymentEmployee', 'assertProbationProcessesIdle'],
      controls: ['items'],
    }),
  }),
  // 审批通过后修改（PB-R6）：If-Match = 考核 revision；body 严格 { assessmentName?, assessmentDate?, selfEvaluation?,
  // managerRating?, regularizationOpinion?, regularizationDate? } 至少一项（400）；只有审批通过的考核可改（审批中 409
  // ASSESSMENT_IN_APPROVAL，其他状态 409 ASSESSMENT_NOT_EDITABLE）；提前 / 延期转正缺转正日期 400；只改考核记录，不补生成
  'PATCH /probation-assessments/:id': object({
    object: ASSESSMENT,
    operation: 'update',
    button: button('Assessment.Edit', 'detail'),
    scope: guardScope('employment.assessmentScope', NF_ASSESSMENT),
    fields: projector('employment.response', 'employment.assessment'),
    write: write('body', 'assessment.update', none('返回后按考核对象字段查看权投影'), {
      preconditions: ['requireEmployeeInScope', 'assertAssessmentRevision'],
    }),
    ...byId,
  }),
  // ---- employment/exit-handover-routes.ts：R2 BE-8b2 离职交接执行（B64，DM-R13 / DM-R14，DEC-632）----------------------------
  // 离职详情上的交接状态与事项：权限与范围同 GET /exits/:id（DEC-177，看不见 / 不存在 / 非离职单同一个 404「任职业务不存在」）；
  // 没有交接申请 = status not_started（含档案直接离职，R2c）
  'GET /exits/:id/handover': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('详情无按钮'),
    scope: pointScope({ param: 'id' }, 'employment.business', NF_BUSINESS),
    fields: fixed(HANDOVER_STATUS_KEYS, 'DEC-632 交接状态与事项固定键，事项内容来自交接事项设置快照'),
    ...byId,
  }),
  // 交接申请详情：参与人（发起人员工本人 / 该审批实例上有任务的审批人）可读，不要求任职对象权限（审批人不一定有）；
  // 非参与人与不存在同一个 404「离职交接申请不存在」；items[].editable 标出查看人当前可办理的事项
  'GET /exit-handover-requests/:id': relation({
    relation: 'exitHandover.participant',
    target: { param: 'id' },
    denied: NF_HANDOVER,
    fields: fixed(HANDOVER_DETAIL_KEYS, 'DEC-632 交接申请详情固定键'),
    ...byId,
  }),
  // 勾选 / 取消勾选“办理完成”自动保存：If-Match = 事项 revision；body 严格 { done }（400）；非参与人 404；交接已结束 409
  // EXIT_HANDOVER_NOT_IN_PROGRESS；查看人没有当前待办 403 EXIT_HANDOVER_NOT_ASSIGNEE；事项不属当前节点 403
  // EXIT_HANDOVER_ITEM_NOT_OWNED；revision 不一致 409；值未变不写。审计 exit_handover.item_done
  'PUT /exit-handover-requests/:id/items/:itemId': relation({
    relation: 'exitHandover.assignee',
    target: { param: 'id' },
    denied: F_HANDOVER_NOT_ASSIGNEE,
    fields: fixed(HANDOVER_TICK_KEYS, 'DEC-632 办理回执固定键'),
    write: commandWrite('exitHandover.tick', none('固定形状回执，不是任职对象'), {
      preconditions: ['lockHandoverRequest', 'assertRevision'],
    }),
    ...byId,
  }),
  // ---- employment/retirement-intention-routes.ts：R2-T04 BE-5d2 意向退休日期申请（设计 §11 / §12.1）-------------------------
  // 授权复用任职记录对象：数据操作 + 详情级按钮 Employment.RetireIntention + 字段权（intendedDate / reason）。读用 DEC-177 可见口径
  // （员工当前部门或申请快照部门任一在范围内；使用用户维度取本表发起人），写用申请行自己的三个坐标（快照部门 / 员工 / 发起人，
  // DEC-193），不用 employmentVisibilitySql、也不查任职业务创建人。范围外与不存在同一个 404「意向退休申请不存在」
  // 创建：If-Match = 员工 revision；readContext 不带员工 ID（员工主档创建人不是本单坐标），命令内持员工锁后用即将写入的快照部门 / 员工 / 本单发起人判写范围；
  // 员工须当前在职（409 RETIREMENT_INTENTION_NOT_EMPLOYED）、同员工无未办结申请（409 RETIREMENT_INTENTION_IN_PROGRESS）、
  // 日期晚于今天（400 RETIREMENT_INTENTION_NOT_FUTURE）、有弹性上下限时落在其内（400 RETIREMENT_INTENTION_OUT_OF_RANGE）
  'POST /retirement-intentions/employees/:id': object({
    object: EMPLOYMENT,
    operation: 'create',
    button: button(RETIREMENT_INTENTION_BUTTON, 'detail'),
    // 范围 = 即将写入的快照部门 / 员工 / 本单发起人三坐标（§11.1，creatorId = ctx.userId），不用员工主档创建人；范围外 404
    scope: guardScope('employment.intentionWrite', NF_INTENTION),
    fields: RESPONSE,
    write: employmentWrite('body', [
      'lockEmploymentEmployee',
      'assertRevision',
      'requireIntentionWriteScope',
      'assertIntentionCreatable',
    ]),
    ...byId,
  }),
  // 修改：If-Match = 申请 revision；只有草稿 / 已驳回可改（审批中 409 RETIREMENT_INTENTION_IN_APPROVAL，已办结 409
  // RETIREMENT_INTENTION_NOT_EDITABLE）；body 严格 { intendedDate?, reason? } 至少一项；日期按当前预计退休日期与弹性范围重校验
  'PATCH /retirement-intentions/:id': object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(RETIREMENT_INTENTION_BUTTON, 'detail'),
    scope: guardScope('employment.intentionWrite', NF_INTENTION),
    fields: RESPONSE,
    write: employmentWrite('body', ['lockIntention', 'assertRevision', 'assertIntentionEditable']),
    ...byId,
  }),
  // 提交（含驳回后重提，沿用原实例）/ 撤回：If-Match = 申请 revision；请求体不接受任何字段（400）；提交只允许原发起人（403
  // RETIREMENT_INTENTION_INITIATOR_ONLY）并重判在职与日期，没有匹配的流程 / 首节点无审批人整单回滚；撤回草稿 / 审批中 / 已驳回 → 已撤回
  'POST /retirement-intentions/:id/submit': intentionAction(),
  'POST /retirement-intentions/:id/withdraw': intentionAction(),
  // 列表：筛选严格校验（employeeId / status）；DEC-177 可见口径在分页前过滤，total 与本页同一范围
  'GET /retirement-intentions': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('列表无按钮'),
    scope: listScope('employment.intentionVisibility'),
    fields: RESPONSE,
  }),
  // 详情：看不见与不存在同一个 404「意向退休申请不存在」
  'GET /retirement-intentions/:id': object({
    object: EMPLOYMENT,
    operation: 'view',
    button: noButton('详情无按钮'),
    scope: guardScope('employment.intentionVisibility', NF_INTENTION),
    fields: RESPONSE,
    ...byId,
  }),
});

/** 意向申请的提交 / 撤回：同一按钮 Employment.RetireIntention（命令式，空字段集合），写范围 = 申请行三个坐标。 */
function intentionAction() {
  return object({
    object: EMPLOYMENT,
    operation: 'update',
    button: button(RETIREMENT_INTENTION_BUTTON, 'detail'),
    scope: guardScope('employment.intentionWrite', NF_INTENTION),
    fields: RESPONSE,
    write: employmentCommand(['lockIntention', 'assertRevision', 'assertIntentionStateAllowsAction']),
    ...byId,
  });
}
