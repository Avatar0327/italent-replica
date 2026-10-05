export { type AppDeps, createApp } from './app.js';
export { type AuthorizationRequest, type Authorizer, defaultAuthorizer } from './authorization.js';
export { AppError, ERROR_STATUS, type ErrorBody, type ErrorCode } from './errors.js';
export {
  createDevIdentityResolver,
  denyAllIdentity,
  DEV_IDENTITY_HEADER,
  devIdentityHeaders,
  type IdentityResolver,
  identityResolverFromEnv,
} from './identity.js';
export type { TenantRouteDeps, TenantRouteModule } from './routes.js';
export { TENANT_HEADER, type TenantContext, tenantContext, type TenantEnv, tenantOf } from './tenant-context.js';
export {
  bootstrapTenantAdmin,
  createPermissionAuthorizer,
  type LicenseQuotaChange,
  type ObjectWrite,
  type PermissionAdminView,
  registerObjectDefinition,
  requireObjectWrite,
  setLicenseQuota,
} from './modules/permission/index.js';
export { createPlatformRouter } from './modules/platform/routes.js';
export { provisionTenant, type ProvisionInput, type ProvisionResult } from './modules/platform/provisioning.js';
export { changeTenantLifecycle, issueLicense } from './modules/platform/operations.js';
export {
  type AuthorizationState,
  captureAuthorizationState,
  openRestoredTenant,
  type ReconciliationReport,
  type RestoreReport,
  restoreTenant,
} from './modules/platform/restore.js';
