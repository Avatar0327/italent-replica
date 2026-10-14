import type { ModuleDeclared } from '../../module-declared.js';

/** succession 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const SUCCESSION_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: [
    'POST /api/tenant/succession/calc-runs/:id/retry',
    'POST /api/tenant/succession/sync',
    'POST /api/tenant/succession/sync-batches/:id/retry',
    'POST /api/tenant/succession/sync-batches/:id/abort',
  ],
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'PUT /api/tenant/succession/health-levels/:id',
    'PUT /api/tenant/succession/health-results/:orgId',
    'PUT /api/tenant/succession/populations/:id',
    'PUT /api/tenant/succession/records/:id',
    'PUT /api/tenant/succession/risk-levels/:id',
    'PUT /api/tenant/succession/risk-results/:positionId',
  ],
};
