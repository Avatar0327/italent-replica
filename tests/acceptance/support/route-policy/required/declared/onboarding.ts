import type { ModuleDeclared } from '../../module-declared.js';

const BASE = '/api/tenant/onboarding/integration/task-pool';

const SCHEMES = '/api/tenant/onboarding/integration/schemes';

/** onboarding 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const ONBOARDING_DECLARED: ModuleDeclared = {
  multiCarrierAdmission: [
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
