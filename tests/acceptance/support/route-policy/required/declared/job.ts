import type { ModuleDeclared } from '../../module-declared.js';

/** job 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const JOB_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: ['PATCH /api/tenant/job/:kind/:id'],
  /** 声明里的 map 型动态选择器位置“端点 × 位置”（AC-PRM-FW-02 选择器绑定） */
  selectorSites: [
    ['GET /api/tenant/job/:kind', 'object'],
    ['GET /api/tenant/job/:kind/:id', 'object'],
    ['PATCH /api/tenant/job/:kind/:id', 'object'],
    ['POST /api/tenant/job/:kind', 'object'],
    ['POST /api/tenant/job/import', 'failureAudit.objectType'],
    ['POST /api/tenant/job/import', 'object'],
  ],
  /** 输入来源表（branch-inputs.ts）里有登记的端点 */
  branchInputEndpoints: [
    'GET /api/tenant/job/:kind',
    'GET /api/tenant/job/:kind/:id',
    'PATCH /api/tenant/job/:kind/:id',
    'POST /api/tenant/job/:kind',
    'POST /api/tenant/job/import',
  ],
};
