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
export { createPlatformRouter } from './modules/platform/routes.js';
export { provisionTenant, type ProvisionInput, type ProvisionResult } from './modules/platform/provisioning.js';
export { changeTenantLifecycle, issueLicense } from './modules/platform/operations.js';
export {
  type OpenInput,
  type OpenResult,
  openRestoredTenant,
  type ReconciliationReport,
  type RestoreInput,
  type RestoreReport,
  restoreTenant,
} from './modules/platform/restore.js';
// R1-T16 审计日志：保留期定时清理（平台路径）与失败命令审计的兜底通道
export {
  type AuditRetentionResult,
  type AuditRetentionRun,
  type AuditRetentionRunInput,
  type AuditRetentionScheduler,
  runAuditRetention,
  startAuditRetentionScheduler,
} from './audit/retention.js';
export { type AuditFallbackRecord, setAuditFallbackSink } from './audit/failures.js';
// R3-T03：Lastest360Cent 的 360 数据源（盘点、继任等使用方按查看人范围预读）
export { loadSurvey360Port, type Survey360PortInput } from './modules/survey360/port.js';
// R3-T05 设计 §5.4：任职状态钩子端口（继任离职自动结束、R3-T06 自动出池在装配时按名称登记）
export {
  type EmployeeStatusHookContext,
  type EmployeeStatusHooks,
  type EmploymentRecordEvent,
  registerEmployeeStatusHooks,
} from './modules/employment/status-hooks.js';
// R3-T05 设计 §4.6：继任定时任务（server.ts 启动；任务随 PR-A / PR-B 登记）
export {
  type SuccessionJob,
  type SuccessionJobKind,
  type SuccessionScheduler,
  startSuccessionScheduler,
} from './modules/succession/scheduler.js';
