import type { ModuleDeclared } from '../../module-declared.js';

/** hr-analysis 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const HR_ANALYSIS_DECLARED: ModuleDeclared = {
  /** 员工档案对象与人事分析对象两个准入节点（all 组合），列表与导出同一份 */
  multiCarrierAdmission: ['GET /api/tenant/hr-analysis/roster', 'GET /api/tenant/hr-analysis/roster/export'],
};
