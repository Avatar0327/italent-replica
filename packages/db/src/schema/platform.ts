import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { daterange } from './types.js';

/** 平台层（L1）元数据键值表，无租户维度；M0 用来验证迁移链路。 */
export const platformMeta = pgTable('platform_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * M0 示例表：验证 PG 16 基线的 `btree_gist` + `daterange` + `EXCLUDE USING gist`，
 * 即日后任职有效期“同一租户同一对象不重叠”的写法。排除约束见手写迁移 0001。
 * 真实业务表落地后可删除（迁移只增不改，删除须新迁移）。
 */
export const m0DemoValidity = pgTable('m0_demo_validity', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').notNull(),
  subjectId: uuid('subject_id').notNull(),
  validDuring: daterange('valid_during').notNull(),
});
