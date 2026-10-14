import type { ModuleDeclared } from '../../module-declared.js';

/** employment 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const EMPLOYMENT_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: [
    'GET /api/tenant/employment/transfers/employees/:id/contracts',
    'POST /api/tenant/employment/custom-fields',
    'PUT /api/tenant/employment/custom-fields/:id/inheritance',
    'PUT /api/tenant/employment/settings',
    'PUT /api/tenant/employment/transfers/settings',
  ],
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'PATCH /api/tenant/employment/businesses/:id',
    'PATCH /api/tenant/employment/records/:id',
    'POST /api/tenant/employment/employees/:id/businesses',
    'POST /api/tenant/employment/employees/:id/forward-update-preview',
    'POST /api/tenant/employment/employees/:id/import',
    'POST /api/tenant/employment/employees/:id/import/forward-update-preview',
    'POST /api/tenant/employment/employees/:id/preview',
    'POST /api/tenant/employment/records/:id/forward-update-preview',
    'POST /api/tenant/employment/transfers/employees/:id',
    'POST /api/tenant/employment/transfers/employees/:id/preview',
    'PUT /api/tenant/employment/custom-fields/:id/inheritance',
  ],
  /** 声明里的 map 型动态选择器位置“端点 × 位置”（AC-PRM-FW-02 选择器绑定） */
  selectorSites: [
    ['POST /api/tenant/employment/employees/:id/import', 'rows.button'],
    ['POST /api/tenant/employment/employees/:id/import', 'rows.operation'],
    ['POST /api/tenant/employment/employees/:id/import/forward-update-preview', 'rows.operation'],
  ],
  /** 输入来源表（branch-inputs.ts）里有登记的端点 */
  branchInputEndpoints: [
    'POST /api/tenant/employment/employees/:id/import',
    'POST /api/tenant/employment/employees/:id/import/forward-update-preview',
  ],
};
