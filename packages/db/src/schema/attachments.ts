/**
 * F-479 S1 通用附件（docs/08_设计/F-479_通用附件能力_设计.md §2.1）。
 * 元数据一文件一行、不物理删除；字节单独放 attachment_blobs（bytea，与元数据同库同事务）。
 * 三张表（加 outbox）全部 ENABLE + FORCE RLS，策略与不可改列触发器在迁移 SQL 里手写。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { tenantMemberships, tenants } from './tenancy.js';
import { bytea } from './types.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const at = (name: string) => timestamp(name, { withTimezone: true });

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const attachmentFiles = pgTable(
  'attachment_files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: tenantId(),
    purpose: text('purpose').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    ownerEmployeeId: uuid('owner_employee_id').notNull(),
    status: text('status').notNull().default('registered'),
    businessType: text('business_type'),
    businessId: uuid('business_id'),
    sealedAt: at('sealed_at'),
    filename: text('filename').notNull(),
    declaredType: text('declared_type').notNull(),
    contentType: text('content_type'),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    expiresAt: at('expires_at'),
    revision: integer('revision').notNull().default(1),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
    uploadedAt: at('uploaded_at'),
    cleanupAt: at('cleanup_at'),
    purgedAt: at('purged_at'),
  },
  (t) => [
    unique('attachment_files_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'attachment_files_owner_member_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'attachment_files_owner_employee_fk',
      columns: [t.tenantId, t.ownerEmployeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    index('attachment_files_owner').on(t.tenantId, t.ownerUserId, t.purpose, t.status),
    index('attachment_files_business').on(t.tenantId, t.businessType, t.businessId),
    index('attachment_files_expiry').on(t.tenantId, t.status, t.expiresAt),
    index('attachment_files_cleanup').on(t.tenantId, t.status, t.cleanupAt),
    check(
      'attachment_files_status',
      sql`${t.status} IN ('registered','uploaded','bound','detached','pending_cleanup','purged')`,
    ),
    check('attachment_files_purpose', sql`${t.purpose} IN ('exit.handwritten_application')`),
    check('attachment_files_size', sql`${t.byteSize} BETWEEN 1 AND ${sql.raw(String(ATTACHMENT_MAX_BYTES))}`),
    check('attachment_files_hash', sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
    check(
      'attachment_files_mime',
      sql`${t.contentType} IS NULL OR ${t.contentType} IN ('image/jpeg','image/png','image/gif','image/bmp')`,
    ),
    check(
      'attachment_files_bound_business',
      sql`${t.status} NOT IN ('bound','detached') OR (${t.businessType} IS NOT NULL AND ${t.businessId} IS NOT NULL)`,
    ),
    check('attachment_files_revision', sql`${t.revision} > 0`),
  ],
);

export const attachmentBlobs = pgTable(
  'attachment_blobs',
  {
    tenantId: tenantId(),
    fileId: uuid('file_id').notNull(),
    bytes: bytea('bytes').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.fileId] }),
    foreignKey({
      name: 'attachment_blobs_file_fk',
      columns: [t.tenantId, t.fileId],
      foreignColumns: [attachmentFiles.tenantId, attachmentFiles.id],
    }),
    check('attachment_blobs_size', sql`octet_length(${t.bytes}) <= ${sql.raw(String(ATTACHMENT_MAX_BYTES))}`),
  ],
);

/** 清理尝试记录（AGENTS §10 定时任务：按“对象 + 周期”幂等，失败记次数与原因）；S1 只建表，S3 写入。 */
export const attachmentCleanupAttempts = pgTable(
  'attachment_cleanup_attempts',
  {
    tenantId: tenantId(),
    fileId: uuid('file_id').notNull(),
    kind: text('kind').notNull(),
    period: text('period').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    reason: text('reason'),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.fileId, t.kind] }),
    foreignKey({
      name: 'attachment_cleanup_file_fk',
      columns: [t.tenantId, t.fileId],
      foreignColumns: [attachmentFiles.tenantId, attachmentFiles.id],
    }),
    check('attachment_cleanup_kind', sql`${t.kind} IN ('expire','purge')`),
    check('attachment_cleanup_status', sql`${t.status} IN ('succeeded','failed')`),
    check('attachment_cleanup_attempts_nonneg', sql`${t.attempts} >= 0`),
  ],
);

/** 领域事件 outbox（AGENTS §10 事件：与命令同事务写入，消费者按游标拉取；形态照 account_avatar_outbox）。 */
export const attachmentOutbox = pgTable(
  'attachment_outbox',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: tenantId(),
    fileId: uuid('file_id').notNull(),
    commandId: text('command_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'attachment_outbox_file_fk',
      columns: [t.tenantId, t.fileId],
      foreignColumns: [attachmentFiles.tenantId, attachmentFiles.id],
    }),
    uniqueIndex('attachment_outbox_command').on(t.tenantId, t.commandId, t.eventType, t.fileId),
    index('attachment_outbox_cursor').on(t.tenantId, t.createdAt, t.id),
    check('attachment_outbox_state', sql`${t.state} IN ('pending','sent','failed','unknown')`),
  ],
);
