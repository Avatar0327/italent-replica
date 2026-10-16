/**
 * 待入职状态动作日志（R2 BE-2a；34 EN-R8 / R9）：取消入职的原因与说明、改期入职的新旧日期与备注。
 * 只追加：取消 / 改期各写一行，不原地改；改期会替换待入职记录（任职记录不可改日期），previous_business_id 串起前后两条。
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { employmentBusinessObjects } from './employment.js';
import { tenants } from './tenancy.js';

export const employmentEntryActions = pgTable(
  'employment_entry_actions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    /** 动作之后存活的待入职业务：取消为被取消的业务本身，改期为替换后的新业务。 */
    businessId: uuid('business_id').notNull(),
    previousBusinessId: uuid('previous_business_id'),
    action: text('action').notNull(),
    reasonCode: text('reason_code'),
    remark: text('remark'),
    fromDate: date('from_date', { mode: 'string' }),
    toDate: date('to_date', { mode: 'string' }),
    commandId: text('command_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employment_entry_actions_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'employment_entry_actions_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    index('employment_entry_actions_business').on(t.tenantId, t.businessId, t.createdAt),
    check('employment_entry_actions_action', sql`${t.action} IN ('cancel', 'postpone')`),
    check('employment_entry_actions_reason', sql`${t.reasonCode} IS NULL OR btrim(${t.reasonCode}) <> ''`),
    check('employment_entry_actions_postpone_dates', sql`${t.action} <> 'postpone' OR ${t.toDate} IS NOT NULL`),
  ],
);
