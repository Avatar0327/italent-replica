import type { ModuleDeclared } from '../../module-declared.js';

const BASE = '/api/tenant/onboarding/integration/task-pool';

export const ONBOARDING_DECLARED: ModuleDeclared = {
  multiCarrierAdmission: [
    `GET ${BASE}`,
    `GET ${BASE}/categories`,
    `GET ${BASE}/:id`,
    `POST ${BASE}`,
    `PATCH ${BASE}/:id`,
    `DELETE ${BASE}/:id`,
  ],
  sameStatusInvalidId: [`PATCH ${BASE}/:id`],
};
