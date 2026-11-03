import type { ModuleDeclared } from '../../module-declared.js';

/** hr-analysis 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const HR_ANALYSIS_DECLARED: ModuleDeclared = {
  /** 员工档案对象与人事分析对象两个准入节点（all 组合），列表与导出同一份 */
  multiCarrierAdmission: [
    'GET /api/tenant/hr-analysis/roster',
    'GET /api/tenant/hr-analysis/roster/export',
    // F-465a 报表数据与导出：同一条双对象准入链（报表另按编码核对合同 / 任职记录对象）
    'GET /api/tenant/hr-analysis/reports/:code',
    'GET /api/tenant/hr-analysis/reports/:code/export',
  ],
};
