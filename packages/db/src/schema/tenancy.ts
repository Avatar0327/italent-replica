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
    // IANA 时区名，默认 Asia/Shanghai（DEC-056）；合法性约束见迁移 0003 的 tenants_timezone_valid
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    status: text('status').$type<TenantStatus>().notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [check('tenants_status_valid', sql`${t.status} IN ('active', 'suspended', 'restoring')`)],
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

/** 用户 × 租户成员关系。撤销只改状态（留痕），每次请求都重新校验（AGENTS.md §10「权限」）。 */
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
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('tenant_memberships_tenant_user').on(t.tenantId, t.userId),
    check('tenant_memberships_status_valid', sql`${t.status} IN ('active', 'revoked')`),
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

/** 租户级覆盖。有效值 = 覆盖 ?? 系统值；“恢复” = 删除覆盖行（REQ-TEN-001 R3）。 */
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
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    updatedAt: utc('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

/**
 * 最小审计事件表：业务写与审计同事务写入（AGENTS.md §10「审计」），只追加（触发器禁止 UPDATE/DELETE/TRUNCATE）。
 * R1-T16 将扩展为统一字段级变更日志（DEC-019，docs/02_业务建模/20 §5：来源动作、终端、IP、TraceID、按月分区等）。
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
  },
  (t) => [index('audit_events_tenant_occurred').on(t.tenantId, t.occurredAt)],
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

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type TenantSettingOverride = typeof tenantSettingOverrides.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
