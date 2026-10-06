/**
 * 多租户底座（R1-T00；REQ-TEN-001；docs/08_设计/R1-T00_多租户底座设计.md）。
 * 平台级表（无 tenant_id、无 RLS）：tenants、users、system_settings——只能经平台路径 withPlatform 访问。
 * 租户级表（带 tenant_id，ENABLE + FORCE RLS，见手写迁移 0003）：tenant_memberships、tenant_setting_overrides、
 * audit_events、command_ledger——只能经 withTenant 访问。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const utc = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const TENANT_STATUSES = ['active', 'suspended', 'restoring'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** 租户。status=restoring 表示按租户恢复后的隔离期（DEC-061），除平台方外一律拒绝访问。 */
export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    // IANA 时区名，默认 Asia/Shanghai（DEC-056）；合法性由 tenants_timezone_valid 约束
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    status: text('status').$type<TenantStatus>().notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    check('tenants_status_valid', sql`${t.status} IN ('active', 'suspended', 'restoring')`),
    // 函数 is_valid_iana_timezone 由迁移 0003 手写创建
    check('tenants_timezone_valid', sql`is_valid_iana_timezone(${t.timezone})`),
  ],
);

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** 全局身份：一个用户可属于多个租户（硬规则 7），租户内的身份与权限另建（R1-T01）。 */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull().unique(),
    displayName: text('display_name').notNull(),
    status: text('status').$type<UserStatus>().notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_status_valid', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

export const MEMBERSHIP_STATUSES = ['active', 'revoked'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** 租户内的用户类型（DEC-128，docs/02_业务建模/06 §9；原站 UserType 3 = 内部员工、2 = 外部用户）。 */
export const USER_TYPES = ['internal', 'external'] as const;
export type UserType = (typeof USER_TYPES)[number];

/**
 * 用户 × 租户成员关系 = 租户内的用户。撤销只改状态（留痕），每次请求都重新校验（AGENTS.md §10「权限」）。
 * 用户类型（DEC-128）：内部员工随人员档案 / 入职产生并绑定档案；外部用户没有档案，必须带业务身份（猎头、实施顾问等）。
 * 为空 = 平台路径授予、尚未登记类型的成员（如开通时的首位租户管理员），登记口径随 R1-T17 开通流程定。
 */
export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<MembershipStatus>().notNull().default('active'),
    userType: text('user_type').$type<UserType>(),
    businessIdentity: text('business_identity'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('tenant_memberships_tenant_user').on(t.tenantId, t.userId),
    check('tenant_memberships_status_valid', sql`${t.status} IN ('active', 'revoked')`),
    check('tenant_memberships_user_type_valid', sql`${t.userType} IN ('internal', 'external')`),
    // 外部用户必须带业务身份（显式排除 NULL：CHECK 结果为 NULL 时会放行）；内部员工与未登记成员不带
    check(
      'tenant_memberships_business_identity',
      sql`(${t.userType} = 'external' AND ${t.businessIdentity} IS NOT NULL AND btrim(${t.businessIdentity}) <> '')
    OR (${t.userType} IS DISTINCT FROM 'external' AND ${t.businessIdentity} IS NULL)`,
    ),
  ],
);

/**
 * 系统级预置配置（平台下发）。overridable=false 即“系统预置、只读”，
 * true 即“系统预置、可覆盖、可恢复”（docs/02_业务建模/11 §13.1）。
 */
export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description').notNull(),
  overridable: boolean('overridable').notNull().default(true),
  version: integer('version').notNull().default(1),
  updatedAt: utc('updated_at'),
});

/** 租户级覆盖。有效值 = 激活的覆盖 ?? 系统值；“恢复” = 覆盖置为非激活（REQ-TEN-001 R3）。 */
export const tenantSettingOverrides = pgTable(
  'tenant_setting_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key')
      .notNull()
      .references(() => systemSettings.key),
    value: jsonb('value').notNull(),
    // 恢复系统值时不删行，只置 false 并 revision + 1，保证 revision 单调、旧 ETag 不会误写（避免 ABA）
    active: boolean('active').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    updatedAt: utc('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

/**
 * 请求来源列（docs/02_业务建模/20 §2 数据变更日志列：来源动作、来源页面类型、来源页面、终端内核、前端版本、IP、TraceID）。
 * 由 API 层按请求取值（apps/api/src/audit/request-context.ts）；系统任务没有请求，来源动作记“定时任务”。
 */
export const auditSourceColumns = () => ({
  sourceAction: text('source_action'),
  sourcePageType: text('source_page_type'),
  sourcePage: text('source_page'),
  terminal: text('terminal'),
  clientVersion: text('client_version'),
  ip: text('ip'),
  traceId: text('trace_id'),
});

/**
 * 统一字段级数据变更日志（DEC-019；docs/02_业务建模/20 §5；R1-T16）：业务写与审计同事务写入（AGENTS.md §10「审计」），
 * 只追加（触发器禁止 UPDATE/DELETE/TRUNCATE，唯一例外是按租户保留期的定时清理，迁移 0051）。
 * before / after 是写入方给出的前后值（删除时 before 即被删记录的完整快照）；changes 是写入时算出的字段级差异，
 * 引用字段带当时解析的名称（fromText / toText）。任何写入路径（含集合 SQL）漏填的 operation / changes / 归属
 * 由迁移 0051 的 BEFORE INSERT 触发器按同一规则补齐，R1-T16 之前的历史行在迁移时回填（PR #75 第二轮 P2-3、P2-6）。
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // 系统任务写入时为空（记为“系统”）
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    // 事件时间存 UTC（timestamptz 内部即 UTC 瞬时），按租户时区显示（DEC-056）
    occurredAt: utc('occurred_at'),
    commandId: text('command_id'),
    operation: text('operation'),
    changes: jsonb('changes'),
    ...auditSourceColumns(),
    // DEC-197：查询按查看人当前的数据范围与字段权限裁剪所依据的归属（写入时由迁移 0051 的触发器按对象类型推导）：
    // 权限对象编码（字段权限）、所属人员、所属组织；配置类对象三者为空，按企业设置能力判断
    scopeObject: text('scope_object'),
    scopeEmployeeId: uuid('scope_employee_id'),
    scopeOrgId: uuid('scope_org_id'),
  },
  (t) => [
    index('audit_events_tenant_occurred').on(t.tenantId, t.occurredAt),
    // 数据范围“创建人”判定按对象回查创建事件（迁移 0019）
    index('audit_events_scope_creator_lookup').on(t.tenantId, t.objectId, t.action, t.occurredAt),
    index('audit_events_tenant_object_type').on(t.tenantId, t.objectType, t.occurredAt),
    index('audit_events_tenant_scope_object').on(t.tenantId, t.scopeObject, t.occurredAt),
    check('audit_events_operation_valid', sql`${t.operation} IN ('create', 'update', 'delete', 'other')`),
  ],
);

/** 命令台账：同一租户内同一命令 ID 同内容视为幂等重放，异内容报冲突（AGENTS.md §10「幂等」）。 */
export const commandLedger = pgTable(
  'command_ledger',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    commandId: text('command_id').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: utc('created_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.commandId] })],
);

/**
 * 平台审计：所有平台命令都写这里（R1-T17）。不带 tenant_id，故不受 RLS 约束（guard-rls 中列为豁免）；
 * 只有 app_platform 可读写，只追加（迁移 0006 触发器）。与租户相关的平台变更（开租户、改租户状态、成员关系、
 * 许可发放、备份恢复）另在该租户的 audit_events 写一份，租户管理员可见；这里用 subject_tenant_id 标出所涉租户，
 * 平台方按租户追查时不依赖租户库内的审计（按租户恢复会把租户审计带回备份时点）。
 */
export const platformAuditEvents = pgTable(
  'platform_audit_events',
  {
    id: id(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    occurredAt: utc('occurred_at'),
    commandId: text('command_id').notNull(),
    subjectTenantId: uuid('subject_tenant_id').references(() => tenants.id),
  },
  (t) => [index('platform_audit_events_subject_tenant').on(t.subjectTenantId, t.occurredAt)],
);

export const PLATFORM_OPERATOR_STATUSES = ['active', 'revoked'] as const;
export type PlatformOperatorStatus = (typeof PLATFORM_OPERATOR_STATUSES)[number];

/**
 * 平台运营身份（REQ-PLT-001 R1、R4）：只有登记在这里且有效的全局账号才能调用 /api/platform/*。
 * 与租户内权限完全分开——租户管理员不因任何租户内身份获得平台能力，平台运营也不因此成为任何租户的成员。
 * 撤销只改状态（留痕），每次请求都重新读取。
 */
export const platformOperators = pgTable(
  'platform_operators',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    status: text('status').$type<PlatformOperatorStatus>().notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [check('platform_operators_status_valid', sql`${t.status} IN ('active', 'revoked')`)],
);

/** 平台命令台账：平台写命令的幂等键全局唯一（AGENTS.md §10「幂等」）。 */
export const platformCommandLedger = pgTable('platform_command_ledger', {
  commandId: text('command_id').primaryKey(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response').notNull(),
  createdAt: utc('created_at'),
});

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type TenantSettingOverride = typeof tenantSettingOverrides.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type PlatformOperator = typeof platformOperators.$inferSelect;
