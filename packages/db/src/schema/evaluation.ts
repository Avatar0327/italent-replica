/**
 * R3-T02 人才评定配置（应用 TEvaluation；docs/02_业务建模/24；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §3.2）。
 * - B1a：活动类型 `ev_activity_types`。活动类型没有组织字段（字典，DEC-121 口径：看全部 ∪ 创建人），无“同步任职记录”
 *   （DEC-025）；`sync_qualification` 缺省 false（不自动写任职资格子集，C2-8 发布时按它判定）。
 * - 后续子 PR（B1b、B3～B6、C1-4、C2）在本文件追加各自的表，迁移各带一个（拆分方案第 2 节）。
 */
import { boolean, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
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
