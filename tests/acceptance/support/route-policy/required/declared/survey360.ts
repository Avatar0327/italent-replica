import type { ModuleDeclared } from '../../module-declared.js';

/** survey360 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const SURVEY360_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: [
    'GET /api/tenant/survey360/people/sync-conflicts',
    'POST /api/tenant/survey360/activities/:id/objects/:objectId/appraisers/auto',
    'POST /api/tenant/survey360/people/sync',
    'POST /api/tenant/survey360/people/sync-conflicts/:id/resolve',
  ],
};
