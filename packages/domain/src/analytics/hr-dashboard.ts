/**
 * 人事看板 23 项指标的目录（docs/02_业务建模/35 §2.1，R2-T10 BE-12b）：序号、编码、名称、明细行的主体。
 * 口径只在 apps/api 的 analytics/hr-dashboard.ts 一处实现；这里只放不含 IO 的稳定标识。
 * 授权对象 TenantBase.HrDashboard 在 permission/module-actions.ts 登记（授权项“人事分析 - 人事看板 查看”）。
 */
export const HR_DASHBOARD_OBJECT = 'TenantBase.HrDashboard';

/** 明细行的主体：员工 ID、单据（任职业务）ID、合同 / 合同申请 ID、Offer ID、组织 ID。 */
export type HrDashboardSubject = 'employee' | 'business' | 'contract' | 'offer' | 'org';

export const HR_DASHBOARD_INDICATORS = [
  { no: 1, code: 'regularEmployees', name: '在职员工数（正式）', subject: 'employee' },
  { no: 2, code: 'interns', name: '实习生', subject: 'employee' },
  { no: 3, code: 'entriesThisYear', name: '本年入职', subject: 'employee' },
  { no: 4, code: 'leavesThisYear', name: '本年离职', subject: 'employee' },
  { no: 5, code: 'probationExpiring30', name: '未来 30 天试用到期', subject: 'employee' },
  { no: 6, code: 'contractExpiring30', name: '未来 30 天合同到期', subject: 'contract' },
  { no: 7, code: 'probationOverdue', name: '转正已过期', subject: 'employee' },
  { no: 8, code: 'contractOverdue', name: '合同已过期', subject: 'contract' },
  { no: 9, code: 'offerPending', name: '待发 Offer', subject: 'offer' },
  { no: 10, code: 'offerSentThisMonth', name: '本月已发 Offer', subject: 'offer' },
  { no: 11, code: 'entriesThisMonth', name: '本月已入职', subject: 'employee' },
  { no: 12, code: 'pendingEntries', name: '待入职', subject: 'employee' },
  { no: 13, code: 'regularizedThisMonth', name: '本月已转正', subject: 'employee' },
  { no: 14, code: 'leavesThisMonth', name: '本月已离职', subject: 'employee' },
  { no: 15, code: 'offerApproving', name: 'Offer 审批中', subject: 'offer' },
  { no: 16, code: 'regularizationInProgress', name: '转正中', subject: 'business' },
  { no: 17, code: 'transferInProgress', name: '调动中', subject: 'business' },
  { no: 18, code: 'exitInProgress', name: '离职中（含退休）', subject: 'business' },
  { no: 19, code: 'contractApproving', name: '合同审批中', subject: 'contract' },
  { no: 20, code: 'noDirectManager', name: '直线上级为空', subject: 'employee' },
  { no: 21, code: 'noWorkStartDate', name: '参加工作日期为空', subject: 'employee' },
  { no: 22, code: 'departmentNoHead', name: '部门负责人为空', subject: 'org' },
  { no: 23, code: 'departmentNoHrbp', name: 'HRBP 为空', subject: 'org' },
] as const;

export type HrDashboardIndicator = (typeof HR_DASHBOARD_INDICATORS)[number];
export type HrDashboardCode = HrDashboardIndicator['code'];

/** “未来 N 天”窗口（试用 / 合同到期）：[asOf, asOf + N]，含两端，与 DEC-637 A-7“即将”同口径。 */
export const HR_DASHBOARD_SOON_DAYS = 30;
