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
// R1-T08 定时生效：平台路径的运维 / 调度入口；编制单一判定入口在 R1-T09 接入前暂不检查编制（DEC-145）
export {
  type EmploymentActivationRun,
  type EmploymentActivationRunInput,
  type EmploymentActivationRunResult,
  type EmploymentActivationScheduler,
  runEmploymentActivations,
  startEmploymentActivationScheduler,
} from './modules/employment/activation-scheduler.js';
export {
  type ActivationTarget,
  type EmploymentActivationChecks,
  registerEmploymentActivationChecks,
} from './modules/employment/activation-checks.js';

export {
  generateContractForBusiness,
  changeContractForTransfer,
  handleContractsOnExit,
} from './modules/contracts/ports.js';
export { runContractJobs, startContractScheduler } from './modules/contracts/scheduler.js';
export type { ContractContext } from './modules/contracts/context.js';
export type { ContractFields, ContractCommand } from './modules/contracts/input.js';
