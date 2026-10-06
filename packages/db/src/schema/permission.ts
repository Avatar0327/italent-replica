/**
 * 权限模型（R1-T01；REQ-PRM-001、REQ-PRM-003；docs/02_业务建模/06 §2、§7）。全部是租户级表（RLS，见迁移）。
 * 只放功能权限：身份、身份 × 应用、身份对象权限（字段 / 按钮 / 数据操作）、用户授权、企业管理员、许可。
 * 数据范围（管理单元）按（用户 × 应用）另建表（R1-T02，DEC-043）；这里任何一张表都不含范围列（功能与数据分表）。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './tenancy.js';

/**
 * 与 @italent/domain 的 ADMIN_ROLES / BUTTON_LEVELS 相同（drizzle-kit 生成迁移时解析不了工作区源码导出，
 * 故在此重复；一致性由 apps/api/src/modules/permission/schema-sync.test.ts 守护）。
 */
export const ADMIN_ROLE_VALUES = [
  'tenant_admin',
  'system_admin',
  'employee_admin',
  'user_admin',
  'permission_admin',
  'matrix_admin',
  'audit_admin',
  'billing_admin',
] as const;
export const BUTTON_LEVEL_VALUES = ['list', 'list_row', 'detail', 'app_page'] as const;
const sqlList = (values: readonly string[]) => sql.raw(`(${values.map((v) => `'${v}'`).join(', ')})`);

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const utc = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

/** L3 业务身份。standard 由平台下发（R1-T17），custom 由租户的身份管理员新建（L1 身份定义）。 */
export const permissionProfiles = pgTable(
  'permission_profiles',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    source: text('source').$type<'standard' | 'custom'>().notNull().default('custom'),
    // 授予该身份消耗的许可类型（PA用户 / 核心人力用户 / 数字人才用户…）；为空则不消耗（REQ-PRM-003）
    licenseType: text('license_type'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('permission_profiles_tenant_code').on(t.tenantId, t.code),
    // 供子表做（租户, 身份）复合外键，保证子行与身份同租户
    unique('permission_profiles_tenant_id').on(t.tenantId, t.id),
    check('permission_profiles_source_valid', sql`${t.source} IN ('standard', 'custom')`),
  ],
);

/** 身份 × 应用：一个身份可横跨多个应用（如部门负责人横跨 31 个应用，06 §1.2）。 */
export const permissionProfileApps = pgTable(
  'permission_profile_apps',
  {
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    appCode: text('app_code').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.appCode] }),
    profileFk('permission_profile_apps_profile', t.tenantId, t.profileId),
  ],
);

/** 身份对象清单 + 数据操作权限（新增 / 编辑 / 删除）。 */
export const permissionProfileObjects = pgTable(
  'permission_profile_objects',
  {
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    objectCode: text('object_code').notNull(),
    canCreate: boolean('can_create').notNull(),
    canUpdate: boolean('can_update').notNull(),
    canDelete: boolean('can_delete').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.profileId, t.objectCode] }),
    profileFk('permission_profile_objects_profile', t.tenantId, t.profileId),
  ],
);

/** 字段权限：查看 / 编辑，对列表和表单同时生效。 */
export const permissionProfileFields = pgTable(
  'permission_profile_fields',
  {
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    objectCode: text('object_code').notNull(),
    fieldCode: text('field_code').notNull(),
    canView: boolean('can_view').notNull(),
    canEdit: boolean('can_edit').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.objectCode, t.fieldCode] }),
    objectFk('permission_profile_fields_object', t),
  ],
);

/** 功能权限：按钮编码 × 级别，有行即已勾选。 */
export const permissionProfileButtons = pgTable(
  'permission_profile_buttons',
  {
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    objectCode: text('object_code').notNull(),
    buttonCode: text('button_code').notNull(),
    level: text('level').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.objectCode, t.buttonCode, t.level] }),
    objectFk('permission_profile_buttons_object', t),
    check('permission_profile_buttons_level_valid', sql`${t.level} IN ${sqlList(BUTTON_LEVEL_VALUES)}`),
  ],
);

export const GRANT_STATUSES = ['active', 'revoked'] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

/**
 * 用户授权：一条 = 一个用户 × 一个身份（06 §1.1）。撤销只改状态（留痕），不删行。
 * source=auto 是自助身份 / 动态授权自动物化的授权（DEC-020），不允许手工撤销。
 */
export const permissionGrants = pgTable(
  'permission_grants',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    profileId: uuid('profile_id').notNull(),
    source: text('source').$type<'manual' | 'auto'>().notNull().default('manual'),
    status: text('status').$type<GrantStatus>().notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    grantedBy: uuid('granted_by').references(() => users.id),
    revokedBy: uuid('revoked_by').references(() => users.id),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    profileFk('permission_grants_profile', t.tenantId, t.profileId),
    unique('permission_grants_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('permission_grants_active_user_profile')
      .on(t.tenantId, t.userId, t.profileId)
      .where(sql`${t.status} = 'active'`),
    check('permission_grants_source_valid', sql`${t.source} IN ('manual', 'auto')`),
    check('permission_grants_status_valid', sql`${t.status} IN ('active', 'revoked')`),
  ],
);

/** L2 企业管理员记录：一个用户 × 一个管理员身份（06 §2）。 */
export const permissionAdmins = pgTable(
  'permission_admins',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    contractConfiguration: boolean('contract_configuration').notNull().default(false),
    status: text('status').$type<GrantStatus>().notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('permission_admins_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('permission_admins_active_user_role')
      .on(t.tenantId, t.userId, t.role)
      .where(sql`${t.status} = 'active'`),
    check('permission_admins_role_valid', sql`${t.role} IN ${sqlList(ADMIN_ROLE_VALUES)}`),
    check('permission_admins_status_valid', sql`${t.status} IN ('active', 'revoked')`),
  ],
);

/** 管理员记录的「可授权管理员身份」（06 §2.1；REQ-PRM-001 R2）。 */
export const permissionAdminGrantableRoles = pgTable(
  'permission_admin_grantable_roles',
  {
    tenantId: tenantId(),
    adminId: uuid('admin_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.adminId, t.role] }),
    adminFk('permission_admin_grantable_roles_admin', t),
    check('permission_admin_grantable_roles_role_valid', sql`${t.role} IN ${sqlList(ADMIN_ROLE_VALUES)}`),
  ],
);

/** 管理员记录的「可授权业务身份」（06 §2.1；REQ-PRM-001 R1）。 */
export const permissionAdminGrantableProfiles = pgTable(
  'permission_admin_grantable_profiles',
  {
    tenantId: tenantId(),
    adminId: uuid('admin_id').notNull(),
    profileId: uuid('profile_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.adminId, t.profileId] }),
    adminFk('permission_admin_grantable_profiles_admin', t),
    profileFk('permission_admin_grantable_profiles_profile', t.tenantId, t.profileId),
  ],
);

/** 许可池：每个租户每类许可的总名额（由平台发放，REQ-PRM-003 R1）。 */
export const licensePools = pgTable(
  'license_pools',
  {
    tenantId: tenantId(),
    licenseType: text('license_type').notNull(),
    quota: integer('quota').notNull(),
    revision: integer('revision').notNull().default(1),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.licenseType] }),
    check('license_pools_quota_non_negative', sql`${t.quota} >= 0`),
  ],
);

/**
 * 许可占用：一个用户在一类许可上占一个名额；再授同类身份不再消耗（W-123）。
 * 不再外键约束到许可池：余额为 0 或尚未发放时仍允许授予并记为超额（DEC-143），占用可先于发放存在。
 */
export const licenseSeats = pgTable(
  'license_seats',
  {
    tenantId: tenantId(),
    licenseType: text('license_type').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => permissionGrants.id),
    consumedAt: utc('consumed_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.licenseType, t.userId] })],
);

/**
 * 权限模块的领域事件 outbox（AGENTS.md §10「事件」）：与业务写、审计同一事务写入，消费者按游标拉取。
 * 对象编号用文本：用户 × 应用范围等对象的键是复合的（与 audit_events.object_id 一致）。
 */
export const permissionOutbox = pgTable(
  'permission_outbox',
  {
    id: id(),
    tenantId: tenantId(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    eventType: text('event_type').notNull(),
    revision: integer('revision'),
    commandId: text('command_id').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: utc('created_at'),
  },
  (t) => [
    index('permission_outbox_cursor').on(t.tenantId, t.createdAt, t.id),
    check('permission_outbox_state', sql`${t.state} IN ('pending', 'sent', 'failed', 'unknown')`),
  ],
);

function profileFk(name: string, tenant: AnyPgColumn, profile: AnyPgColumn) {
  return foreignKey({
    name,
    columns: [tenant, profile],
    foreignColumns: [permissionProfiles.tenantId, permissionProfiles.id],
  });
}

function objectFk(name: string, t: { tenantId: AnyPgColumn; profileId: AnyPgColumn; objectCode: AnyPgColumn }) {
  const target = permissionProfileObjects;
  return foreignKey({
    name,
    columns: [t.tenantId, t.profileId, t.objectCode],
    foreignColumns: [target.tenantId, target.profileId, target.objectCode],
  }).onDelete('cascade');
}

function adminFk(name: string, t: { tenantId: AnyPgColumn; adminId: AnyPgColumn }) {
  return foreignKey({
    name,
    columns: [t.tenantId, t.adminId],
    foreignColumns: [permissionAdmins.tenantId, permissionAdmins.id],
  });
}

export type PermissionProfile = typeof permissionProfiles.$inferSelect;
export type PermissionGrant = typeof permissionGrants.$inferSelect;
export type PermissionAdmin = typeof permissionAdmins.$inferSelect;
export type LicensePool = typeof licensePools.$inferSelect;
