export { pgErrorCode } from './pg-error.js';
export { createPgDb, createPgliteDb, type Db, type DbHandle, migrationsFolder } from './client.js';
export {
  type AuditEntry,
  findPlatformCommandResult,
  IdempotencyConflictError,
  type PlatformCommandContext,
  type PlatformCommandMeta,
  RevisionConflictError,
  runPlatformCommand,
} from './platform-command.js';
export {
  createTenant,
  createUser,
  getTenant,
  getUser,
  grantMembership,
  grantMembershipIn,
  grantPlatformOperator,
  insertTenant,
  isActivePlatformOperator,
  type MembershipChange,
  type MembershipRegistration,
  type MembershipRevocation,
  type MembershipRevokeHook,
  type NewTenant,
  type PlatformOperatorChange,
  registerMembershipRevokeHook,
  revokeMembership,
  revokePlatformOperator,
  setTenantStatus,
  setUserStatus,
  type SystemSettingInput,
  type TenantStatusChange,
  tenantValues,
  upsertSystemSetting,
  type UserStatusChange,
} from './platform-ops.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
export { APP_ROLE, isUuid, type Tx, withPlatform, withTenant } from './tenant-context.js';
// 查询构造器统一从这里取，保证整个工作区只用同一份 drizzle-orm 实例
export { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
export {
  type AttachmentReport,
  type AttachmentStore,
  type BackupAttachment,
  BackupIntegrityError,
  type BackupIntegrityReason,
  type BackupManifest,
  type BackupOptions,
  type BackupRow,
  backupChecksum,
  exportTenantBackup,
  type ImportReport,
  importTenantBackup,
  type IsolationReport,
  migrationVersion,
  type MigrationVersion,
  openBackup,
  platformAudit,
  sealBackup,
  type TenantBackup,
  tenantTables,
  verifyAttachments,
  verifyTenantIsolation,
} from './tenant-backup.js';
