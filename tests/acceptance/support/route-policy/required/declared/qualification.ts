import type { ModuleDeclared } from '../../module-declared.js';

/** qualification 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const QUALIFICATION_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: [
    'GET /api/tenant/qualification/employees/:employeeId/development-channel',
    'GET /api/tenant/qualification/employees/:employeeId/development-channel/levels/:levelId',
  ],
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'PUT /api/tenant/qualification/standards/:id/channels',
    'PUT /api/tenant/qualification/targets/:id/grade-descriptions/:detailId',
  ],
  /** 声明里的 map 型动态选择器位置“端点 × 位置”（AC-PRM-FW-02 选择器绑定） */
  selectorSites: [['GET /api/tenant/qualification/candidates/owner-orgs', 'object']],
  /** 输入来源表（branch-inputs.ts）里有登记的端点 */
  branchInputEndpoints: ['GET /api/tenant/qualification/candidates/owner-orgs'],
};
