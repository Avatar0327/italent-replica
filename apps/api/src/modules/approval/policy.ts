/**
 * 审批中心路由的现状声明（F-039 PR-A；附录 A「/api/tenant/approval」32 条：流程 8 / 租户配置 2 / 仿真 2 / 读取 7 /
 * 任务动作 8 / 实例动作 5）。子应用挂在 /api/tenant/approval，键用本地路径（routes.ts 的注册实参）。
 *
 * 现状链路（routes.ts）：流程配置只认流程管理员能力 admin.process_matrix（requireProcessButton，DEC-102）；查看 / 仿真是
 * 「流程管理员 或 流程对象 object.view」（requireProcessView）；「我的」三张列表只按接收人过滤（listTodos / listNotifications /
 * listInstances，不查身份权限）；详情与历史由 assertCanOpen 判参与关系（发起人 / 审批人 / 被抄送人 / 范围内管理员），
 * detailView 按节点表单 ∩ 字段查看权 ∩ DEC-122 员工字段裁剪；管理员转交 / 干预 / 日志只校验 ApprovalInstance 的按钮
 * （三个按钮都没有 requires，不加数据操作）再按任职 / 合同数据范围限定实例（adminScope）；任务与实例动作经 command() →
 * runCommand，关系与业务前提在 execute 内；盲审 Outcome 403 已提交并入台账（§3.3）。
 *
 * 与附录 A 的差异（按现状代码修正）：
 * - GET /admin-logs：附录 A「projector approval.adminLogs（APPROVAL_FLOW_FIELDS）」；代码 queries.ts listAdminLogs（102–110 行）
 *   只映射固定键并原样透出 detail，没有投影器——APPROVAL_FLOW_FIELDS 在 audit/visibility.ts 供审计查询用，与本路由无关，
 *   故登记 fixed。
 * - GET /instances「businessId 非法 400」：routes.ts 424–426 行用 z.enum / z.uuid 的 parse 直接抛裸 ZodError，handleError
 *   （errors.ts 69–76 行）对非 AppError 一律 500 INTERNAL_ERROR，不是 400 → 不登记 invalidId，登记 knownGap。
 * - 关系判定的位置：任务动作的「当前审批人」（actions.ts openTask 71 行）、retrieve（node-actions.ts 69 行）、urge / withdraw
 *   的「发起人」（actions.ts openOwn 598 行）都在 runCommand 的 execute 内执行，不是路由前置；只有 resubmit 的发起人判定
 *   （requireResubmitRight，access.ts 150 行）在路由前置。relation 只登记判定与拒绝码，不改变位置。
 * - POST /instances/:id/urge、/withdraw：附录 A 的 relation 拒绝码无 reason；代码 details.reason = APPROVAL_NOT_INITIATOR，
 *   照登；withdraw 的守卫 requireWithdrawRight（路由前置）先于发起人判定执行。
 * - POST /instances/:id/resubmit 的 employment 分支：附录 A 写在守卫描述里的「employment 拒绝」实际发生在命令内适配器
 *   （adapters.ts 323 行，409 CONFLICT / APPROVAL_RESUBMIT_VIA_BUSINESS），requireResubmitRight 对该分支只查发起人。
 * - 附录 A 对象列的「record approval.taskObject」登记为 optional.taskObject（operation view）：relation 类型没有 object 槽，
 *   且该判定不构成准入——字段查看权不足走盲审 Outcome 403（已提交），编辑权在 write.fields 守卫 approval.fieldRights 内按
 *   body.fields 非空时 requireObjectWrite(update) 判定（routes.ts fieldRights 461–471 行）。
 * - 两条仿真 POST 附录 A 无写足迹；按「写路由必有 write」登记三项 none（只读仿真：不开命令事务、不落库、不进台账）。
 * - preconditions 按代码补齐：cc 也调 assertOpen；disagree 多一项 votesInTransition（会签前加签人不能点不同意）；add-sign
 *   的 blindReview / assertNotSelf 仅 type === 'after'；approve 的编辑类前提仅 body.fields 非空时执行。
 */
import {
  APPROVAL_INSTANCE_OBJECT,
  APPROVAL_PROCESS_OBJECT,
  CONTRACT_OBJECT,
  MODULE_OBJECTS,
  SUBSETS,
} from '@italent/domain';
import {
  defineTable,
  type FieldsFrom,
  type FieldsPolicy,
  type ObjectSelector,
  type PolicyBase,
  type RoutePolicy,
} from '../../route-policy/index.js';
import {
  admin,
  allFields,
  any,
  BAD_REQUEST,
  button,
  commandWrite,
  denied,
  fixed,
  listScope,
  noButton,
  noFields,
  none,
  noScope,
  NOT_FOUND,
  object,
  own,
  pointScope,
  projector,
  relation,
  shape,
  write,
} from '../../route-policy/presets.js';

// ---- 拒绝码与通用形状 ---------------------------------------------------------------------------------------------
/** `job/context.uuidParam`：路径标识非 UUID → 400 VALIDATION_FAILED（approval/routes.ts 再做小写规范化）。 */
const byId = { invalidId: BAD_REQUEST };
/** actions.ts openTask：任务不是分配给本人 → 403 FORBIDDEN / APPROVAL_NOT_ASSIGNEE（node-actions.ts retrieveTask 同码）。 */
const NOT_ASSIGNEE = denied(403, 'FORBIDDEN', 'APPROVAL_NOT_ASSIGNEE');
/** actions.ts openOwn / access.ts requireResubmitRight：不是发起人 → 403 FORBIDDEN / APPROVAL_NOT_INITIATOR。 */
const NOT_INITIATOR = denied(403, 'FORBIDDEN', 'APPROVAL_NOT_INITIATOR');
/** actions.ts adminAct：实例不在管理员的实例范围内 → 404 NOT_FOUND / APPROVAL_NOT_FOUND「审批实例不存在」。 */
const ADMIN_NOT_FOUND = denied(404, 'NOT_FOUND', 'APPROVAL_NOT_FOUND');
/** disclosure.ts assertCanOpen：非参与人 → 404 NOT_FOUND「审批实例不存在」（裸 AppError，details 无 reason）。 */
const CANNOT_OPEN = NOT_FOUND;
/** 详情投影（disclosure.ts detailView / visibleTasks / projectLog：DEC-057 / 104 / 115 / 122 / 195；日志字段名数组）。 */
const DETAIL = projector('approval.detail', 'approval.detail');
/** 流程管理员整对象可见（trimProcess，DEC-102）。 */
const PROCESS_ALL = allFields('DEC-102');
/** 200 时 respondOutcome → respondDetail(instanceId)：按 assertCanOpen 重读并投影详情。 */
const REOPEN = { generic: { targets: 'instanceId', locator: 'approval.canOpen' } } as const;
/** 管理员动作 200 时同样重读详情；重读的打开关系由管理员范围覆盖。 */
const ADMIN_REOPEN = { generic: { targets: 'instanceId', locator: 'approval.instanceAdminScope' } } as const;

// ---- 流程定义（DEC-102）---------------------------------------------------------------------------------------------
/** requireProcessView：流程管理员，或身份对象权限可查看流程对象（object.view）；出口字段按通过的分支取。 */
function processView(adminFields: FieldsPolicy, objectFields: FieldsPolicy, extra: PolicyBase = {}): RoutePolicy {
  return any(
    [
      admin('process_matrix', { fields: adminFields }),
      object({
        object: APPROVAL_PROCESS_OBJECT,
        operation: 'view',
        button: noButton('流程对象只有查看权（requirePermission object.view）'),
        scope: noScope('流程定义是租户全局配置'),
        fields: objectFields,
      }),
    ],
    extra,
  );
}
const PROCESS_SHAPE = shape('approval.process');
const DICTIONARY = noFields('APPROVAL_TYPES 枚举字典，不是业务对象字段');
const SIMULATION = noFields('仿真路径与虚拟输入（清单 7），不是持久对象字段');
/** 仿真是只读 POST（readCtx，无 If-Match）：不开命令事务、不落库、不进台账。 */
const simulationWrite = write(
  none('仿真只收虚拟数据，不提取业务字段'),
  none('只读仿真：不开命令事务、不落库'),
  none('仿真结果不是持久对象，无返回后复核'),
);
/** definitions.ts audited：事务内 auditApproval(approval-process) + outbox；流程定义无范围，返回后只经 trimProcess 投影。 */
const PROCESS_CONFIG = 'approval.processConfig';
const noProcessScope = none('流程定义无范围，返回后只投影（trimProcess）');
const processConfig = write(
  none('流程定义 DTO（DEC-102 流程配置为管理员能力，无字段目录）'),
  PROCESS_CONFIG,
  noProcessScope,
);
const processCommand = commandWrite(PROCESS_CONFIG, noProcessScope);
const processAdmin = (extra: PolicyBase = {}) => admin('process_matrix', { fields: PROCESS_ALL, ...extra });

// ---- 任务动作（§3.3 八个动作）-----------------------------------------------------------------------------------------
/** 任务所属业务快照的字段对象（adapters.ts snapshot.fieldObjectCode）：任职记录 / 合同 / 人员子集各对象。 */
const TASK_OBJECT_DOMAIN = [
  MODULE_OBJECTS.employmentRecord.code,
  CONTRACT_OBJECT,
  ...Object.values(SUBSETS).map((subset) => subset.objectCode),
];
const TASK_OBJECT: ObjectSelector = {
  from: 'record',
  locator: 'approval.taskObject',
  attribute: 'fieldObjectCode',
  domain: TASK_OBJECT_DOMAIN,
};
/** 可选分支：fieldRights 按快照对象算查看人的字段查看权（盲审），不构成准入；编辑权在 write.fields 守卫内。 */
const taskObject = {
  optional: {
    taskObject: object({
      object: TASK_OBJECT,
      operation: 'view',
      button: noButton('审批人的动作由任务分配 + 节点开关决定，不是身份按钮（approval/catalog.ts）'),
      scope: noScope('审批不产生数据范围（11 §16）'),
      fields: noFields('只向 fieldRights / 盲审提供快照对象的字段查看权'),
    }),
  },
};
/** 关系 = 当前审批人（openTask，命令内）；写足迹 commandInstance；200 时按 instanceId 重读详情。 */
function taskAction(fields: FieldsFrom, preconditions: readonly string[], extra: PolicyBase = {}): RoutePolicy {
  return relation({
    relation: 'approval.currentAssignee',
    target: { param: 'id' },
    denied: NOT_ASSIGNEE,
    fields: DETAIL,
    write: write(fields, 'approval.commandInstance', REOPEN, { preconditions }),
    ...byId,
    ...extra,
  });
}
/** 同意 / 不同意 / 驳回：body.fields 可选，字段集合与盲审可见集由 fieldRights 算（routes.ts 461–471 行）。 */
const decision = (preconditions: readonly string[]) =>
  taskAction({ guard: 'approval.fieldRights' }, preconditions, taskObject);
/** openTask（openRun + 当前审批人）→ assertOpen（revision / pending / 业务版本）；后四项仅 body.fields 非空时执行。 */
const APPROVE = [
  'openTask',
  'assertOpen',
  'assertExit',
  'blindReview',
  'assertNotSelf',
  'assertApprovalEdit',
  'assertNotAddSigner',
  'editableInput',
  'assertNotBlindAfterEdit',
];
const DISAGREE = ['openTask', 'assertOpen', 'assertExit', 'votesInTransition', 'blindReview', 'assertNotSelf'];
/** 驳回意见必填（node.rejectCommentRequired，DEC-059）是内联校验，无函数名。 */
const REJECT = ['openTask', 'assertOpen', 'assertRejectEnabled', 'blindReview', 'assertNotSelf'];
/** 节点转交开关（异常管理员例外 DEC-069）与「不能转交给自己」是内联校验；无盲审。 */
const TRANSFER = ['openTask', 'assertOpen', 'assertReviewer', 'assertNotNodeAssignee'];
/** 节点加签开关内联；parallel / before 不盲审，after 含本人同意才 blindReview + assertNotSelf（DEC-095）。 */
const ADD_SIGN = [
  'openTask',
  'assertOpen',
  'addSignAllowed',
  'assertAddSignType',
  'assertAddSigners',
  'assertNotNodeAssignee',
  'blindReview',
  'assertNotSelf',
];
/** 节点抄送开关内联；抄送对象须是有效账号（isActiveAccount）；无盲审。 */
const CC = ['openTask', 'assertOpen', 'isActiveAccount'];
/** retrieveTask 不走 openTask：openRun 后自行校验 revision / 业务版本 / 本人任务，再按 rules.retrievableTask 判定。 */
const RETRIEVE = ['openRun', 'assertRevision', 'assertBusinessUnchanged', 'retrievableTask'];
/** editMode === 'separate' 内联；assertNotBlindAfterEdit 抛错回滚（不是 Outcome）。 */
const EDIT = [
  'openTask',
  'assertOpen',
  'assertApprovalEdit',
  'assertNotAddSigner',
  'editableInput',
  'assertNotBlindAfterEdit',
];

// ---- 发起人与管理员动作 ---------------------------------------------------------------------------------------------
/** 关系 = 发起人（openOwn：openRun + 发起人 + If-Match revision，命令内）；命令式按钮不提取字段。 */
function initiatorAction(preconditions: readonly string[], extra: PolicyBase = {}): RoutePolicy {
  return relation({
    relation: 'approval.initiator',
    target: { param: 'id' },
    denied: NOT_INITIATOR,
    fields: DETAIL,
    write: commandWrite('approval.commandInstance', REOPEN, { preconditions }),
    ...byId,
    ...extra,
  });
}
/** 催办：节点催办开关（urgeOpen）与 30 分钟频率限制（assertUrgeInterval）。 */
const URGE = ['openOwn', 'urgeOpen', 'assertUrgeInterval'];
/** 撤回：实例须 running / returned（内联 409 APPROVAL_CLOSED）。 */
const WITHDRAW = ['openOwn'];
/** 重提：状态须 returned（personnel_change 另可 withdrawn）内联；contract 分支事务内复查同一字段集；employment 适配器拒绝。 */
const RESUBMIT = ['openOwn', 'requireResubmitRight', 'adapter.resubmit'];
/** adminAct：范围覆盖（404）→ revision → running → 业务版本 → DEC-092 本人回避；jump 不改派任务，其余两项仅非 jump。 */
const ADMIN = [
  'openRun',
  'assertRevision',
  'assertBusinessUnchanged',
  'isOwnRequest',
  'assertReviewer',
  'assertNotNodeAssignee',
];
/** 管理员转交 / 干预：只校验按钮（无按钮 403 FORBIDDEN / APPROVAL_ADMIN_REQUIRED），不加 update 数据操作（§2.4）。 */
function adminAction(code: 'adminTransfer' | 'adminIntervene'): RoutePolicy {
  return object({
    object: APPROVAL_INSTANCE_OBJECT,
    operation: 'button',
    button: button(code, 'detail'),
    scope: pointScope({ param: 'id' }, 'approval.instanceAdminScope', ADMIN_NOT_FOUND),
    fields: DETAIL,
    write: write(
      none('adminBody（kind / taskId / toUserId / toNodeKey / reason）是动作参数，不是字段'),
      'approval.commandInstance',
      ADMIN_REOPEN,
      { preconditions: ADMIN },
    ),
    ...byId,
  });
}
/** handoverExceptionAdmin：If-Match 须为 0、原异常管理员须是成员、替代人须是有效成员；逐单 DEC-092 本人回避只计 skipped。 */
const HANDOVER = [
  'assertRevision',
  'assertTenantMember',
  'assertExceptionAdminMember',
  'isEligibleApprover',
  'ownRequestBlocker',
];

// ---- 读取 -----------------------------------------------------------------------------------------------------------
/** 详情 / 历史：assertCanOpen（发起人 / 审批人 / 被抄送人 / 范围内管理员），其余一律 404。 */
const canOpen = relation({
  relation: 'approval.canOpen',
  target: { param: 'id' },
  denied: CANNOT_OPEN,
  fields: DETAIL,
  ...byId,
});
const TODO_KEYS = [
  'taskId',
  'instanceId',
  'title',
  'approvalType',
  'nodeKey',
  'nodeName',
  'isExceptionAdmin',
  'origin',
  'createdAt',
];
const NOTIFICATION_KEYS = ['id', 'instanceId', 'taskId', 'kind', 'channel', 'template', 'status', 'createdAt'];
const INSTANCE_KEYS = [
  'id',
  'title',
  'status',
  'approvalType',
  'businessId',
  'currentNodeKey',
  'revision',
  'createdAt',
];
const ADMIN_LOG_KEYS = ['instanceId', 'event', 'nodeKey', 'actorUserId', 'adminSelfTransfer', 'detail', 'createdAt'];

export const APPROVAL_POLICIES = defineTable('approval', {
  // ---- registerProcessRoutes：流程定义（DEC-102）------------------------------------------------------------------
  'GET /types': processView(DICTIONARY, DICTIONARY),
  // status 非法值 .catch('active')，不报错
  'GET /processes': processView(PROCESS_ALL, PROCESS_SHAPE),
  'GET /processes/:id': processView(PROCESS_ALL, PROCESS_SHAPE, byId),
  'POST /processes': processAdmin({ write: processConfig }),
  'PUT /processes/:id/draft': processAdmin({ ...byId, write: processConfig }),
  'POST /processes/:id/versions': processAdmin({ ...byId, write: processCommand }),
  'POST /processes/:id/publish': processAdmin({ ...byId, write: processCommand }),
  'POST /processes/:id/discard': processAdmin({ ...byId, write: processCommand }),
  // ---- registerTenantConfigRoutes：异常管理员交接（DEC-098）与预置安装（DEC-018 / DEC-094）----------------------
  // 准入 = requireProcessButton('publish')（admin.process_matrix）；adminTransfer 按钮 + 范围只是可选分支，不做 AND：
  // adminScope 为 null 时仍指定继任者、重发流程，tasks 0 / skipped []、unlisted 计全部（handover.ts 109 / 235 行）
  'POST /exception-admins/handover': admin('process_matrix', {
    fields: projector('approval.handover', 'approval.handover'),
    optional: {
      instanceTransfer: object({
        object: APPROVAL_INSTANCE_OBJECT,
        operation: 'button',
        button: button('adminTransfer', 'detail'),
        scope: listScope('approval.adminScope'),
        fields: noFields('只向处理函数提供范围谓词（transferableInstances / unlistedCount / discloseHandover）'),
      }),
    },
    // 事务内按可选分支范围选批（handoverExceptionAdmin）；返回后 discloseHandover 按同一范围重裁 skipped / nextCursor（R4-1）
    write: write(
      none('fromUserId / toUserId / cursor 是动作参数'),
      'approval.handoverScope',
      'approval.handoverDisclosure',
      {
        ledger: 'single',
        preconditions: HANDOVER,
      },
    ),
  }),
  // 无请求体；预置清单在代码内，installPresets 逐个 createProcess → audited
  'POST /presets/install': processAdmin({
    write: write(none('无请求体，预置流程清单来自代码（DEC-018 / DEC-094）'), PROCESS_CONFIG, noProcessScope),
  }),
  // ---- registerSimulationRoutes：仿真只收虚拟数据（清单 7），requireProcessButton('simulate*') = requireProcessView ----
  'POST /processes/:id/simulate': processView(SIMULATION, SIMULATION, { ...byId, write: simulationWrite }),
  // approvalType 未知 → 400 VALIDATION_FAILED / APPROVAL_TYPE_UNKNOWN（approvalTypeOf），不是路径标识
  'POST /simulate': processView(SIMULATION, SIMULATION, { write: simulationWrite }),
  // ---- registerReadRoutes：本人数据与详情 -------------------------------------------------------------------------
  'GET /todos': own({ predicate: 'approval.recipient', fields: fixed(TODO_KEYS, 'F-039 §3.5 固定键 listTodos') }),
  'GET /notifications': own({
    predicate: 'approval.recipient',
    fields: fixed(NOTIFICATION_KEYS, 'F-039 §3.5 固定键 listNotifications'),
  }),
  // role 域 initiated（发起人）/ participated（任一非 self_skip 任务的审批人或被抄送人）；businessId 可选过滤
  'GET /instances': own({
    predicate: 'approval.initiatedOrParticipated',
    fields: fixed(INSTANCE_KEYS, 'F-039 §3.5 固定键 listInstances'),
    knownGap: {
      scenario: 'role / businessId 查询参数非法：z.parse 抛裸 ZodError，handleError 兜底 500 INTERNAL_ERROR，应为 400',
      issue: '待开',
    },
  }),
  // 详情按钮逐个公布（viewerOf 两个 adminScope，N8）；tasks 为展示窗口，logs 受 DEC-104 / 115 记录隐藏
  'GET /instances/:id': canOpen,
  // 历史分页（DEC-101 / X-19）：items 经 visibleTasks / projectLog，recordsHidden 同详情
  'GET /instances/:id/tasks': canOpen,
  'GET /instances/:id/logs': canOpen,
  // adminScope(['adminLogs']) 为 null → 403 FORBIDDEN / APPROVAL_ADMIN_REQUIRED；adminSelfTransfer 筛选（DEC-070）
  'GET /admin-logs': object({
    object: APPROVAL_INSTANCE_OBJECT,
    operation: 'button',
    button: button('adminLogs', 'list'),
    scope: listScope('approval.adminScope'),
    fields: fixed(ADMIN_LOG_KEYS, 'DEC-070 listAdminLogs 固定键（detail 原样透出，无投影器）'),
  }),
  // ---- registerTaskRoutes：八个任务动作（§3.3）；If-Match 必填（writeCtx → revision），盲审 Outcome 403 已提交 ------
  'POST /tasks/:id/approve': decision(APPROVE),
  'POST /tasks/:id/disagree': decision(DISAGREE),
  'POST /tasks/:id/reject': decision(REJECT),
  'POST /tasks/:id/transfer': taskAction(none('toUserId / comment 是动作参数'), TRANSFER),
  // fieldRights(taskId, undefined)：不提取编辑字段，只算盲审可见集（后加签含本人同意，DEC-095）
  'POST /tasks/:id/add-sign': taskAction({ guard: 'approval.fieldRights' }, ADD_SIGN, taskObject),
  'POST /tasks/:id/cc': taskAction(none('userIds / comment 是动作参数'), CC),
  // 本人已同意的任务（retrieveTask：assignee ≠ 本人 → 403 APPROVAL_NOT_ASSIGNEE；不可撤回 → 409 APPROVAL_NOT_RETRIEVABLE）
  'POST /tasks/:id/retrieve': relation({
    relation: 'approval.retrievable',
    target: { param: 'id' },
    denied: NOT_ASSIGNEE,
    fields: DETAIL,
    write: commandWrite('approval.commandInstance', REOPEN, { preconditions: RETRIEVE }),
    ...byId,
  }),
  // body.fields 必填（zod），空对象在命令内 editableInput → 403 APPROVAL_FIELD_NOT_EDITABLE
  'POST /tasks/:id/edit': taskAction({ guard: 'approval.fieldRights' }, EDIT, taskObject),
  // ---- registerInstanceRoutes：发起人与管理员动作 ----------------------------------------------------------------------
  // requireResubmitRight 路由前置（发起人 403 / contract：按钮 + 范围 + requestWriteFields + corrections 字段权 /
  // personnel_change：自助按钮 + 本人绑定 403 APPROVAL_NOT_SELF）；无 content-type 时 body 视为 {}
  'POST /instances/:id/resubmit': relation({
    relation: 'approval.initiator',
    target: { param: 'id' },
    denied: NOT_INITIATOR,
    guards: ['approval.resubmitRight'],
    fields: DETAIL,
    write: write({ guard: 'approval.resubmitRight' }, 'approval.commandInstance', REOPEN, { preconditions: RESUBMIT }),
    ...byId,
  }),
  'POST /instances/:id/urge': initiatorAction(URGE),
  // requireWithdrawRight 路由前置：employment / contract 须仍持撤回按钮 + 编辑权 + 范围（403 APPROVAL_SCOPE_DENIED）；
  // personnel_change 须仍持自助申请按钮；发起人判定随后在命令内 openOwn
  'POST /instances/:id/withdraw': initiatorAction(WITHDRAW, { guards: ['approval.withdrawRight'] }),
  'POST /instances/:id/admin-transfer': adminAction('adminTransfer'),
  // kind 缺省 reassign；jump 不需要 taskId / toUserId；干预或转给自己须填 reason（400 APPROVAL_REASON_REQUIRED）
  'POST /instances/:id/admin-intervene': adminAction('adminIntervene'),
});
