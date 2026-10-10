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
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import {
  type ButtonPolicy,
  defineTable,
  type FieldsFrom,
  type FieldsPolicy,
  type PolicyBase,
  type RoutePolicy,
  type RowsPolicy,
  type WritePolicy,
} from '../../route-policy/index.js';
import {
  admin,
  all,
  any,
  BAD_REQUEST,
  button,
  buttonOnly,
  denied,
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

// ---- 拒绝码（reason = 现状文案）---------------------------------------------------------------------------------
const NF_EMPLOYEE = denied(404, 'NOT_FOUND', '员工不存在');
const NF_DATA = denied(404, 'NOT_FOUND', '任职数据不存在');
const NF_BUSINESS = denied(404, 'NOT_FOUND', '任职业务不存在');
const NF_RECORD = denied(404, 'NOT_FOUND', '任职记录不存在');
const NF_TRANSFER = denied(404, 'NOT_FOUND', '调动不存在');
const NF_LINKAGE_ITEM = denied(404, 'NOT_FOUND', '联动子项不存在');
const F_UNBOUND = denied(403, 'FORBIDDEN', '当前用户未绑定员工');
const F_NO_DEPARTMENT = denied(403, 'FORBIDDEN', '无权选择调动部门');
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

/** 调动发起人 → 按钮：hr → Transfer.Hr、manager → Transfer.Manager、employee → Transfer.Self（detail；access.ts ROLE_BUTTONS）。 */
const TRANSFER_INITIATORS = ['hr', 'manager', 'employee'] as const satisfies readonly TransferInitiator[];
const INITIATOR_BUTTON: ButtonPolicy = {
  from: 'mapper',
  mapper: 'transfer.initiatorButton',
  domain: TRANSFER_INITIATORS,
};

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

export const EMPLOYMENT_POLICIES = defineTable('employment', {
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
  // 下属经理字段 / 组织角色 / 合同变更（options 为 null 时不提取字段）；命令内 updateTransferLinkage 再判一次
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
  // 命令内调动类重锁 + 复核，createEmploymentBusiness 内 requireScopedEmploymentObject，直接生效的向后更新按 DEC-178
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
      { controls: ['loginEmail'] },
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
    guards: [TRANSFER_SOURCE, 'employment.employeeTransferBusiness', DIRECT_OPERATION],
    scope: BUSINESS_WRITE,
    fields: RESPONSE,
    write: employmentWrite('body.fields+customFields', [
      'transferBusinessContext',
      'requireManagerBusinessSource',
      'lockEmploymentBusiness',
      'assertRevision',
      'requireEmployeeTransferBusiness',
      'requireScopedEmploymentObject',
    ]),
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
});
