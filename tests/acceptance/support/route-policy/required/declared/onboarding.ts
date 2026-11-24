import type { ModuleDeclared } from '../../module-declared.js';

/** onboarding 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const ONBOARDING_DECLARED: ModuleDeclared = {
  multiCarrierAdmission: [
    'GET /api/tenant/onboarding/integration/task-pool',
    'GET /api/tenant/onboarding/integration/task-pool/categories',
    'GET /api/tenant/onboarding/integration/task-pool/:id',
    'POST /api/tenant/onboarding/integration/task-pool',
    'PATCH /api/tenant/onboarding/integration/task-pool/:id',
    'DELETE /api/tenant/onboarding/integration/task-pool/:id',
  ],
  sameStatusInvalidId: ['PATCH /api/tenant/onboarding/integration/task-pool/:id'],
};
