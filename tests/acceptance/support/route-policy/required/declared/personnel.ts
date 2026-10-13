import type { ModuleDeclared } from '../../module-declared.js';

/** personnel 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const PERSONNEL_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: ['GET /api/tenant/personnel/employees/:employeeId/subsets/:kind'],
};
