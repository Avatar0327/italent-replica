import type { ModuleDeclared } from '../../module-declared.js';

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
    'GET /api/tenant/onboarding/entries/:businessId/collection',
    'POST /api/tenant/onboarding/entries/:businessId/collection/start',
    'POST /api/tenant/onboarding/entries/:businessId/collection/remind',
    'POST /api/tenant/onboarding/entries/:businessId/collection/comments',
    'POST /api/tenant/onboarding/collection/start-batch',
  ],
  sameStatusInvalidId: [
    'POST /api/tenant/onboarding/entries/:businessId/collection/start',
    'POST /api/tenant/onboarding/entries/:businessId/collection/remind',
    'POST /api/tenant/onboarding/entries/:businessId/collection/comments',
  ],
};
