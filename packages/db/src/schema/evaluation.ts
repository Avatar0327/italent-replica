/**
 * R3-T02 人才评定配置（应用 TEvaluation；docs/02_业务建模/24；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §3.2）。
 * - B1a：活动类型 `ev_activity_types`。活动类型没有组织字段（字典，DEC-121 口径：看全部 ∪ 创建人），无“同步任职记录”
 *   （DEC-025）；`sync_qualification` 缺省 false（不自动写任职资格子集，C2-8 发布时按它判定）。
 * - 后续子 PR（B1b、B3～B6、C1-4、C2）在本文件追加各自的表，迁移各带一个（拆分方案第 2 节）。
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const tracked = () => ({
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
const displayOrder = () => integer('display_order').notNull().default(0);
const enabled = () => boolean('enabled').notNull().default(true);

/** 活动类型 ActivityType：名称、启用、顺序号、是否同步任职资格子集（设计 §3.2）。名称租户内唯一，顺序号不要求唯一（Q-M0-152 / #171，照原站）。 */
export const evActivityTypes = pgTable(
  'ev_activity_types',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    displayOrder: displayOrder(),
    enabled: enabled(),
    syncQualification: boolean('sync_qualification').notNull().default(false),
    ...tracked(),
  },
  (t) => [
    unique('ev_activity_types_tenant_id').on(t.tenantId, t.id),
    unique('ev_activity_types_name').on(t.tenantId, t.name),
    index('ev_activity_types_order').on(t.tenantId, t.displayOrder),
  ],
);

/**
 * 活动周期 ActivityCycle：评定窗口期，用于统计（规格 24 §3）。名称租户内唯一（DEC-380①，Q-M0-170）；表单只有名称、没有描述；
 * 没有组织字段（字典，DEC-121 口径）。
 */
export const evCycles = pgTable(
  'ev_cycles',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [unique('ev_cycles_tenant_id').on(t.tenantId, t.id), unique('ev_cycles_name').on(t.tenantId, t.name)],
);

/**
 * 通用评分项 GeneralScoreItem：任职资格标准之外的评分项（现场表现、业绩等），首版只做评分（设计 §3.2）。
 * 名称租户内唯一（DEC-380②，Q-M0-171）；描述（评价标准）可空、≤500 字。
 */
export const evGeneralItems = pgTable(
  'ev_general_items',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [
    unique('ev_general_items_tenant_id').on(t.tenantId, t.id),
    unique('ev_general_items_name').on(t.tenantId, t.name),
  ],
);

export type SyncQueueState = 'pending' | 'done' | 'skipped' | 'failed';

/**
 * 任职事件同步队列（R3-T02 C1-4，设计 §4.3）：每个（任职事件, 处理器）一行，由 employment_outbox 上的
 * AFTER INSERT 触发器在写任职的同一事务内插入（迁移里的 ev_enqueue_qualification_sync），事件与队列行同时提交或回滚。
 * 消费者按状态取数（pending / failed 且到了 next_attempt_at），没有时间游标，所以迟提交的事件下一轮自然被取到。
 * 判重键 UNIQUE(tenant_id, handler, dedupe_key)：qualification_sync 的 dedupe_key = outbox 事件 ID，重复入队只一行。
 * handler 是文本而不是枚举：C2-1b 追加 evaluation_leave 时只改触发器函数，不改本表。
 */
export const evSyncQueue = pgTable(
  'ev_sync_queue',
  {
    id: id(),
    tenantId: tenantId(),
    handler: text('handler').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    outboxId: uuid('outbox_id'),
    employeeId: uuid('employee_id').notNull(),
    recordId: uuid('record_id').notNull(),
    state: text('state').$type<SyncQueueState>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('ev_sync_queue_dedupe').on(t.tenantId, t.handler, t.dedupeKey),
    index('ev_sync_queue_pickup').on(t.tenantId, t.handler, t.state, t.nextAttemptAt),
    index('ev_sync_queue_record').on(t.tenantId, t.recordId),
    check('ev_sync_queue_state', sql`${t.state} IN ('pending', 'done', 'skipped', 'failed')`),
    check('ev_sync_queue_attempts', sql`${t.attempts} >= 0`),
  ],
);
