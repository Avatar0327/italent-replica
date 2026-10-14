/** 17 头像补充 / DEC-327：账号头像独立于人员证件照，租户内按用户维护。 */
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantMemberships } from './tenancy.js';

const owner = () => ({ tenantId: uuid('tenant_id').notNull(), userId: uuid('user_id').notNull() });
const utc = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const accountAvatarSettings = pgTable(
  'account_avatar_settings',
  {
    ...owner(),
    revision: integer('revision').notNull().default(1),
    updatedAt: utc(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
      name: 'account_avatar_member_fk',
    }),
    check('account_avatar_revision_positive', sql`${t.revision}>0`),
  ],
);

export const accountAvatarAttachments = pgTable(
  'account_avatar_attachments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ...owner(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('registered'),
    contentBase64: text('content_base64'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: utc(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [accountAvatarSettings.tenantId, accountAvatarSettings.userId],
      name: 'account_avatar_attachment_owner_fk',
    }),
    uniqueIndex('account_avatar_current')
      .on(t.tenantId, t.userId)
      .where(sql`${t.status}='uploaded'`),
    index('account_avatar_cleanup').on(t.tenantId, t.status),
    check('account_avatar_status', sql`${t.status} IN ('registered','uploaded','pending_cleanup')`),
    // TODO(需取证 #126)：原站限制待补；派发授权本轮复用 F-038 的静态图片与 5 MiB 上限。
    check('account_avatar_size', sql`${t.byteSize}>0 AND ${t.byteSize}<=5242880`),
    check('account_avatar_hash', sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
    check('account_avatar_mime', sql`${t.contentType} IN ('image/jpeg','image/png','image/gif','image/bmp')`),
    check('account_avatar_uploaded', sql`${t.status}<>'uploaded' OR ${t.contentBase64} IS NOT NULL`),
  ],
);

export const accountAvatarOutbox = pgTable(
  'account_avatar_outbox',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ...owner(),
    commandId: text('command_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [accountAvatarSettings.tenantId, accountAvatarSettings.userId],
      name: 'account_avatar_outbox_owner_fk',
    }),
    uniqueIndex('account_avatar_outbox_command').on(t.tenantId, t.commandId),
    index('account_avatar_outbox_cursor').on(t.tenantId, t.createdAt, t.id),
    check('account_avatar_outbox_state', sql`${t.state} IN ('pending','sent','failed','unknown')`),
  ],
);
