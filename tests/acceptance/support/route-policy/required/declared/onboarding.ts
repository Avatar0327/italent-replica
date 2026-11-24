import type { ModuleDeclared } from '../../module-declared.js';

const BASE = '/api/tenant/onboarding/integration/task-pool';

const SCHEMES = '/api/tenant/onboarding/integration/schemes';

/** onboarding 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const ONBOARDING_DECLARED: ModuleDeclared = {
  multiCarrierAdmission: [
    'GET /api/tenant/onboarding/collection-templates',
    'GET /api/tenant/onboarding/collection-templates/:id',
    'POST /api/tenant/onboarding/collection-templates',
    'PATCH /api/tenant/onboarding/collection-templates/:id',
    'DELETE /api/tenant/onboarding/collection-templates/:id',
    'GET /api/tenant/onboarding/collection-rules',
    'GET /api/tenant/onboarding/collection-rules/:id',
    'POST /api/tenant/onboarding/collection-rules',
    'PATCH /api/tenant/onboarding/collection-rules/:id',
    'DELETE /api/tenant/onboarding/collection-rules/:id',
    'GET /api/tenant/onboarding/collection-settings',
    'PUT /api/tenant/onboarding/collection-settings',
    `GET ${SCHEMES}`,
    `GET ${SCHEMES}/:id`,
    `POST ${SCHEMES}`,
    `PATCH ${SCHEMES}/:id`,
    `DELETE ${SCHEMES}/:id`,
    `GET ${BASE}`,
    `GET ${BASE}/categories`,
    `GET ${BASE}/:id`,
    `POST ${BASE}`,
    `PATCH ${BASE}/:id`,
    `DELETE ${BASE}/:id`,
  ],
  sameStatusInvalidId: [`PATCH ${BASE}/:id`, `PATCH ${SCHEMES}/:id`],
};
