import type { ModuleDeclared } from '../../module-declared.js';

const BASE = '/api/tenant/onboarding/integration/task-pool';

export const ONBOARDING_DECLARED: ModuleDeclared = {
  multiCarrierAdmission: [`POST ${BASE}`, `PATCH ${BASE}/:id`, `DELETE ${BASE}/:id`],
  sameStatusInvalidId: [`PATCH ${BASE}/:id`],
};
