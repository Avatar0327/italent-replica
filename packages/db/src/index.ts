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
  type MembershipChange,
  type MembershipRevocation,
  type MembershipRevokeHook,
  type NewTenant,
  registerMembershipRevokeHook,
  revokeMembership,
  setTenantStatus,
  setUserStatus,
  type SystemSettingInput,
  type TenantStatusChange,
  upsertSystemSetting,
  type UserStatusChange,
} from './platform-ops.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
export { APP_ROLE, isUuid, type Tx, withPlatform, withTenant } from './tenant-context.js';
// 查询构造器统一从这里取，保证整个工作区只用同一份 drizzle-orm 实例
export { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
