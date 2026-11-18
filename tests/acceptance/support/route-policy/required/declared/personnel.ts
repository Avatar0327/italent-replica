import type { ModuleDeclared } from '../../module-declared.js';

/** personnel 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const PERSONNEL_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点（F-361② 子集附件登记 / 上传） */
  sameStatusInvalidId: [
    'POST /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments',
    'POST /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments/:fileId/upload',
  ],
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: ['GET /api/tenant/personnel/employees/:employeeId/subsets/:kind'],
  /** 声明里的 map 型动态选择器位置“端点 × 位置”（AC-PRM-FW-02 选择器绑定） */
  selectorSites: [
    ['DELETE /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments/:fileId', 'object'],
    ['GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id/attachments/:fileId/content', 'object'],
    ['POST /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments', 'object'],
    ['POST /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments/:fileId/upload', 'object'],
    ['DELETE /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id', 'object'],
    ['GET /api/tenant/personnel/employees/:employeeId/subsets/:kind', 'of[0].object'],
    ['GET /api/tenant/personnel/employees/:employeeId/subsets/:kind', 'of[1].object'],
    ['GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id', 'object'],
    ['GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id/history', 'object'],
    ['GET /api/tenant/personnel/subsets/:kind', 'object'],
    ['PATCH /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id', 'object'],
    ['POST /api/tenant/personnel/employees/:employeeId/subsets/:kind', 'object'],
  ],
  /** 输入来源表（branch-inputs.ts）里有登记的端点 */
  branchInputEndpoints: [
    'DELETE /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments/:fileId',
    'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id/attachments/:fileId/content',
    'POST /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments',
    'POST /api/tenant/personnel/employees/:employeeId/subsets/:kind/attachments/:fileId/upload',
    'DELETE /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id',
    'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind',
    'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id',
    'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id/history',
    'GET /api/tenant/personnel/subsets/:kind',
    'PATCH /api/tenant/personnel/employees/:employeeId/subsets/:kind/:id',
    'POST /api/tenant/personnel/employees/:employeeId/subsets/:kind',
  ],
};
