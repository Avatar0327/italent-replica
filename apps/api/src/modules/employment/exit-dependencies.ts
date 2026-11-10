/**
 * 离职 / 退休视图的字段依赖表：纯常量，运行时只依赖 exit-list-order（叶子）。
 * 单独成模块（F-476 P4，CI run 42758115092）：exit-queries 经任职上下文处在“审批引擎 ↔ 任职”的导入环上，
 * retirement-views 的顶层表（BILL_SORT、RETIREMENT_RESPONSE_DEPENDENCIES）在模块求值时就读这些值；
 * 从 exit-queries 取时，以环上别的模块为入口加载，exit-queries 可能还没求值完，读到 undefined。
 * 放在叶子模块里，任何加载顺序下都先于使用者初始化；exit-queries 原样转出这些名字，调用方不变。
 */
import { exitListOrder } from './exit-list-order.js';
import type { ExitView } from './exit-queries.js';

// ---- 字段依赖表（§9.1；#409 第 4～6 轮，DEC-431①）----------------------------------------------------------------
//
// 三类“依赖某个字段”的输出统一登记在这里，裁剪、筛选检查、排序回退都只读这几张表，不在各处单独判断：
//   1. 响应路径（EXIT_RESPONSE_DEPENDENCIES）：**默认拒绝**——响应里的每一个路径（顶层键、嵌套键、数组、数组元素、
//      容器）都必须在表里登记，没登记的一律不输出（无论是标量、空数组、空对象还是 null）；始终可见的路径也要显式登记为
//      field: null 并写明理由（“无需字段权”），不存在“没登记就放行”。登记的字段是任职记录字段目录里的编码
//      （MODULE_OBJECTS.employmentRecord，含 EXIT_REQUEST_SYSTEM_FIELDS；姓名 / 工号属人员对象）；由某个字段派生的值
//      （显示名、case、原定日期）跟随它的字段。容器登记整体依赖时先判整体权，无权整个键缺席（不留空壳）。
//   2. 筛选（EXIT_FILTER_DEPENDENCIES，在 exit-queries，依赖 ExitViewFilter）：按它筛选等于探测它的值，须先能看到依赖的字段。
//   3. 排序（EXIT_SORT_DEPENDENCIES）：排序键依赖的字段；看不到时改用 id 排序。
// 视图归属（离职中 / 已完成 / 撤销）由视图名这一显式查询参数决定，是业务入口本身（设计 §3.2），不另按状态字段权拦截。

export type Dependency =
  { readonly field: string; readonly object?: 'employee' } | { readonly field: null; readonly why: string };

const independent = (why: string): Dependency => ({ field: null, why });
export const on = (field: string): Dependency => ({ field });
const CONTAINER = independent('容器本身不含值，其中每个叶子在表里各有登记的规则');

/** 键名就是任职记录字段编码的顶层叶子（逐个列出）。 */
const OWN_FIELDS = [
  'id',
  'employeeId',
  'departmentId',
  'positionId',
  'lastWorkDate',
  'effectiveDate',
  'exitTypeCode',
  'reasonCode',
  'whereaboutsCode',
  'status',
  'mode',
  'initiator',
  'initiatorUserId',
  'batchId',
  'revision',
  'createdAt',
  'handoverEmployeeId',
  'addToBlacklist',
  'blacklistExpiryDate',
  'blacklistReason',
  'blacklistNote',
  'compensationAmount',
  'nonCompeteAmount',
  'lastPayDate',
  'socialInsuranceEndMonth',
  'annualLeaveSettled',
  'taxPeriod',
  'taxYear',
  'employerName',
  'actualLeaveDate',
  'dutyTransferTiming',
  'preReleaseDate',
] as const;

/** 路径写法：顶层键 `key`、嵌套 `a.b`、数组 `a` 与其元素 `a[]`、元素内的键 `a[].b`。 */
export const EXIT_RESPONSE_DEPENDENCIES: Readonly<Record<string, Dependency>> = {
  ...Object.fromEntries(OWN_FIELDS.map((field) => [field, on(field)])),
  // 指定日期跟随转交时机的字段权（同一个设置的两半，不另开字段编码）
  dutyTransferDate: on('dutyTransferTiming'),
  name: { field: 'name', object: 'employee' },
  code: { field: 'code', object: 'employee' },
  // F-352①：逐单动作由单据状态派生，无状态查看权的人不下发（路由层按此判定，不让动作反推隐藏的状态）
  actions: on('status'),
  'actions[]': on('status'),
  // 派生显示名 / 原定日期：跟随所属字段
  plannedLastWorkDate: on('lastWorkDate'),
  exitTypeName: on('exitTypeCode'),
  reasonName: on('reasonCode'),
  whereaboutsName: on('whereaboutsCode'),
  // 附件元数据 ID：数组与元素同一字段权；空数组、未填写也是该字段的值，无权时整个键缺席
  attachmentRefs: on('attachmentRefs'),
  'attachmentRefs[]': on('attachmentRefs'),
  // 附件摘要（F-479 §3.1）：数组 / 元素 / 每个键都跟随 attachmentRefs 的字段权
  attachments: on('attachmentRefs'),
  'attachments[]': on('attachmentRefs'),
  'attachments[].id': on('attachmentRefs'),
  'attachments[].filename': on('attachmentRefs'),
  'attachments[].contentType': on('attachmentRefs'),
  'attachments[].byteSize': on('attachmentRefs'),
  'attachments[].uploadedAt': on('attachmentRefs'),
  'attachments[].missing': on('attachmentRefs'),
  // 生效失败 / 挂起标记（最近一次生效尝试）
  activation: on('activation'),
  'activation.status': on('activation'),
  'activation.reason': on('activation'),
  'activation.blockedByBusinessId': on('activation'),
  'activation.details': on('activation'),
  'activation.details.title': on('activation'),
  'activation.details.message': on('lastWorkDate'),
  'activation.details.hiddenCount': on('activation'),
  'activation.details.actions': on('activation'),
  'activation.details.actions[]': on('activation'),
  'activation.details.records': on('activation'),
  'activation.details.records[]': on('activation'),
  'activation.details.records[].docId': on('id'),
  'activation.details.records[].docNo': on('id'),
  'activation.details.records[].bizType': on('kind'),
  'activation.details.records[].effectiveDate': on('effectiveDate'),
  // 撤销信息：case 由撤销前状态决定（设计 §7.1 四种撤销情形与撤销前状态一一对应），跟随 status
  cancellation: independent('有无撤销记录由撤销视图的归属决定（视图名是显式查询参数，设计 §3.2 DM-R5）；叶子各有规则'),
  'cancellation.id': on('id'),
  'cancellation.stateBefore': on('status'),
  'cancellation.case': on('status'),
  'cancellation.revision': on('revision'),
  'cancellation.createdAt': on('createdAt'),
  'cancellation.reason': independent(
    '撤销原因文本：字段目录无独立编码，与离职原因字典的 reasonCode 无关，不派生自受控字段',
  ),
  // 详情的载荷版本（原定 / 最终日期的出处）
  versions: CONTAINER,
  'versions[]': CONTAINER,
  'versions[].versionNo': on('versionNo'),
  'versions[].createdAt': on('createdAt'),
  'versions[].effectiveDate': on('effectiveDate'),
  'versions[].plannedEffectiveDate': on('effectiveDate'),
  'versions[].lastWorkDate': on('lastWorkDate'),
  // 状态事件
  events: CONTAINER,
  'events[]': CONTAINER,
  'events[].eventNo': independent('第几次状态流转的序号，不含状态值，不派生自受控字段'),
  'events[].state': on('status'),
  'events[].createdAt': on('createdAt'),
  // 日期块（原定 / 最终）
  dates: CONTAINER,
  'dates.planned': CONTAINER,
  'dates.final': CONTAINER,
  'dates.planned.lastWorkDate': on('lastWorkDate'),
  'dates.final.lastWorkDate': on('lastWorkDate'),
  'dates.planned.effectiveDate': on('effectiveDate'),
  'dates.final.effectiveDate': on('effectiveDate'),
  // 审批实例 / 效果台账 / 职责转交：来自其他对象，只给标识或汇总件数（不带目标 ID）
  approvalInstanceId: independent('审批中心实例标识，不是任职字段，不派生自受控字段'),
  effects: CONTAINER,
  'effects[]': CONTAINER,
  'effects[].phase': independent('效果台账汇总（阶段）：来自 exit_effects，不派生自受控字段；目标对象可见性归各自模块'),
  'effects[].kind': independent('效果台账汇总（种类）：同上'),
  'effects[].count': independent('效果台账汇总（件数）：同上'),
  dutyTransfer: CONTAINER,
  'dutyTransfer.timing': on('dutyTransferTiming'),
  'dutyTransfer.date': on('dutyTransferTiming'),
  'dutyTransfer.transferred': independent('职责转交成功件数：来自 exit_effects 汇总，不派生自受控字段'),
  'dutyTransfer.failed': independent('职责转交失败件数：同上'),
};

/** 各视图默认排序的键依赖的字段（任一可见即可用设计排序）及设计排序；撤销视图按撤销记录的创建时间（createdAt）。 */
export const EXIT_SORT_DEPENDENCIES = {
  in_progress: { anyOf: ['lastWorkDate', 'effectiveDate'], ...exitListOrder('in_progress') },
  completed: { anyOf: ['lastWorkDate', 'effectiveDate'], ...exitListOrder('completed') },
  all: { anyOf: ['createdAt'], ...exitListOrder('all') },
  cancellations: { anyOf: ['createdAt'], ...exitListOrder('cancellations') },
} as const satisfies Readonly<
  Record<ExitView, { readonly anyOf: readonly string[] } & ReturnType<typeof exitListOrder>>
>;
