/**
 * F-323（DEC-706）：人员类别租户字典；任职按 ID 引用。顺序号允许重复（原站无唯一校验）。
 * 删除为软删：保留 presetKey，种子补装不复活已删预置；被任职引用的项不可删。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

export const employmentTypes = pgTable(
  'employment_types',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    expiryDate: date('expiry_date', { mode: 'string' }).notNull().default('9999-12-31'),
    enabled: boolean('enabled').notNull().default(true),
    presetKey: text('preset_key'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employment_types_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('employment_types_tenant_preset')
      .on(t.tenantId, t.presetKey)
      .where(sql`${t.presetKey} IS NOT NULL`),
    check('employment_types_nonempty', sql`btrim(${t.name}) <> ''`),
    check('employment_types_dates', sql`${t.effectiveDate} <= ${t.expiryDate}`),
    check('employment_types_revision_order', sql`${t.revision} > 0 AND ${t.displayOrder} >= 0`),
  ],
);
