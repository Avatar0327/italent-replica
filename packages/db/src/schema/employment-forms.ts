/** F-321：用工形式租户字典；名称可改，引用用稳定编码，不允许删除被历史记录引用的项。 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

export const employmentForms = pgTable(
  'employment_forms',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    category: integer('category'),
    displayOrder: integer('display_order').notNull().default(0),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    expiryDate: date('expiry_date', { mode: 'string' }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    remark: text('remark'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employment_forms_tenant_id').on(t.tenantId, t.id),
    unique('employment_forms_tenant_code').on(t.tenantId, t.code),
    check('employment_forms_category', sql`${t.category} IN (1,2,3,4)`),
    check('employment_forms_nonempty', sql`btrim(${t.code}) <> '' AND btrim(${t.name}) <> ''`),
    check('employment_forms_dates', sql`${t.effectiveDate} <= ${t.expiryDate}`),
    check('employment_forms_revision_order', sql`${t.revision} > 0 AND ${t.displayOrder} >= 0`),
  ],
);
