/**
 * 人事分析 - 人事流程看板（docs/02_业务建模/35 B51，R2 BE-13c）：审批类别、组件目录与时段常量。
 * 口径只在 apps/api 的 analytics/hr-process-dashboard.ts 一处实现；这里只放不含 IO 的稳定标识。
 * 授权对象 TenantBase.HrProcessDashboard 在 permission/module-actions.ts 登记（授权项“人事分析 - 人事流程看板 查看”）。
 */
export const HR_PROCESS_DASHBOARD_OBJECT = 'TenantBase.HrProcessDashboard';

/** 审批类别：6 类核心流程 + 其他（B51 “只统计 6 类核心流程”）。值也是 approval_instances.approval_category 的取值。 */
export const APPROVAL_CATEGORIES = ['offer', 'entry', 'regularization', 'transfer', 'exit', 'contract', 'other'] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];
export const CORE_APPROVAL_CATEGORIES: readonly ApprovalCategory[] = APPROVAL_CATEGORIES.filter((c) => c !== 'other');
export const APPROVAL_CATEGORY_NAMES: Readonly<Record<ApprovalCategory, string>> = {
  offer: 'Offer',
  entry: '入职',
  regularization: '转正',
  transfer: '调动',
  exit: '离职',
  contract: '合同',
  other: '其他',
};

/**
 * 审批类型 → 审批类别。退休、兼职、员工信息等不在 6 类之列，归“其他”（B51 只点名 6 类；退休是否并入离职未取证，取保守口径）。
 */
export function approvalCategoryOf(approvalType: string): ApprovalCategory {
  if (approvalType === 'offer' || approvalType === 'offer_batch') return 'offer';
  if (approvalType === 'hire') return 'entry';
  if (approvalType === 'regularization' || approvalType === 'intern_regularization') return 'regularization';
  if (approvalType === 'transfer') return 'transfer';
  if (approvalType === 'leave') return 'exit';
  if (approvalType.startsWith('contract_')) return 'contract';
  return 'other';
}

/** 看板级筛选“流程发起时间”的默认相对时段：近 30 天 = [asOf − 29, asOf]。 */
export const HR_PROCESS_DEFAULT_DAYS = 30;
/** 在途等待分段的两个阈值（7.2.03 主值超 3 天、副值超 7 天）。 */
export const HR_PROCESS_WAIT_DAYS = [3, 7] as const;

/** 明细行的主体：审批实例、审批任务、业务单据（任职业务 / 合同申请 / Offer）。 */
export type HrProcessSubject = 'instance' | 'task' | 'business';

export const HR_PROCESS_COMPONENTS = [
  // ① 在途流程监控（7.2.01～05）
  { no: '7.2.01', code: 'inFlightCount', name: '在途流程数', module: 'inFlight', subject: 'instance' },
  { no: '7.2.02', code: 'inFlightAbnormal', name: '在途异常流程数', module: 'inFlight', subject: 'instance' },
  { no: '7.2.03', code: 'inFlightWaiting', name: '在途等待超过 3 天', module: 'inFlight', subject: 'instance' },
  { no: '7.2.04', code: 'inFlightByApprover', name: '在途流程按审批人分布', module: 'inFlight', subject: 'instance' },
  { no: '7.2.05', code: 'inFlightList', name: '在途流程明细列表', module: 'inFlight', subject: 'instance' },
  // ② 流程时效分析（7.2.06～10）
  { no: '7.2.06', code: 'durationByWeek', name: '已通过流程平均耗时', module: 'timeliness', subject: 'instance' },
  { no: '7.2.07', code: 'durationByCategory', name: '各流程平均耗时', module: 'timeliness', subject: 'instance' },
  { no: '7.2.08', code: 'taskDurationByNode', name: '各节点平均耗时', module: 'timeliness', subject: 'task' },
  { no: '7.2.09', code: 'taskDurationByApprover', name: '各审批人平均耗时', module: 'timeliness', subject: 'task' },
  { no: '7.2.10', code: 'durationByOrg', name: '各部门流程平均耗时', module: 'timeliness', subject: 'instance' },
  // ③ 流程质量分析（7.2.11～19）
  { no: '7.2.11', code: 'nonCompliantByWeek', name: '不合规流程占比', module: 'quality', subject: 'instance' },
  { no: '7.2.12', code: 'lateSubmitByCategory', name: '晚提交流程数', module: 'quality', subject: 'instance' },
  { no: '7.2.13', code: 'lateSubmitByInitiator', name: '晚提交按发起人排名', module: 'quality', subject: 'instance' },
  { no: '7.2.14', code: 'lateApprovalByCategory', name: '晚审批流程数', module: 'quality', subject: 'instance' },
  { no: '7.2.15', code: 'lateApprovalByApprover', name: '晚审批按审批人排名', module: 'quality', subject: 'task' },
  { no: '7.2.16', code: 'submitLag', name: '发起时间 − 业务日期 平均天数', module: 'quality', subject: 'instance' },
  { no: '7.2.17', code: 'submitLagByCategory', name: '发起时间 − 业务日期（按类别）', module: 'quality', subject: 'instance' },
  { no: '7.2.18', code: 'approveLag', name: '审批完成时间 − 业务日期 平均天数', module: 'quality', subject: 'instance' },
  { no: '7.2.19', code: 'approveLagByCategory', name: '审批完成时间 − 业务日期（按类别）', module: 'quality', subject: 'instance' },
  // ④ 流程应用情况（7.1.20～24）：业务单据的审批占比
  { no: '7.1.20', code: 'offerApprovalRate', name: '入职 Offer 审批占比', module: 'usage', subject: 'business' },
  { no: '7.1.21', code: 'transferApprovalRate', name: '调动审批占比', module: 'usage', subject: 'business' },
  { no: '7.1.22', code: 'exitApprovalRate', name: '离职审批占比', module: 'usage', subject: 'business' },
  { no: '7.1.23', code: 'regularizationApprovalRate', name: '转正审批占比', module: 'usage', subject: 'business' },
  { no: '7.1.24', code: 'contractApprovalRate', name: '合同审批占比', module: 'usage', subject: 'business' },
] as const;

export type HrProcessComponent = (typeof HR_PROCESS_COMPONENTS)[number];
export type HrProcessComponentCode = HrProcessComponent['code'];
