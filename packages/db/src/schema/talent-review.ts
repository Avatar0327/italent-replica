/**
 * R3-T04 人才盘点（docs/08_设计/R3-T04_人才盘点_设计.md §2；REQ-TR-001）。各 PR 在本文件追加表：
 * PR-A 只建准备度共享字典（DEC-301①）。表前缀 talent_review_，准备度字典例外：它是 T04 / T05 / T06 共用的字典。
 */
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

/**
 * 准备度（`27` §1 Readiness：阶段、描述、颜色、排序）。R3-T05 继任记录、R3-T06 人才池引用 id，端口同时给出 id 与 code；
 * 编码租户唯一、建后不可改；名称（阶段）租户唯一。被引用不可删（引用方登记守卫，409 READINESS_IN_USE），
 * 停用后不可新选用、已有引用保留。没有组织字段：数据范围只认看全部或创建人（DEC-121）。
 */
export const talentReadinessLevels = pgTable(
  'talent_readiness_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').notNull(),
    sortNo: integer('sort_no').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('talent_readiness_levels_tenant_id').on(t.tenantId, t.id),
    unique('talent_readiness_levels_code').on(t.tenantId, t.code),
    unique('talent_readiness_levels_name').on(t.tenantId, t.name),
    check('talent_readiness_levels_color', sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
    check('talent_readiness_levels_revision', sql`${t.revision} > 0`),
  ],
);
