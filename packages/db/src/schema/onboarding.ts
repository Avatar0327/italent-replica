import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects, employmentRecords } from './employment.js';
import { tenantMemberships, tenants } from './tenancy.js';

export const ONBOARDING_ENTRY_STATES = ['pending', 'cancelled', 'hired', 'deleted'] as const;

/** R2-T01 §3.2。阶段 ID 持续承接同一次待入职，版本历史仍由任职动作链保存。 */
export const onboardingEntryCases = pgTable(
  'onboarding_entry_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    rootBusinessId: uuid('root_business_id').notNull(),
    currentBusinessId: uuid('current_business_id').notNull(),
    state: varchar('state', { enum: ONBOARDING_ENTRY_STATES }).notNull().default('pending'),
    pendingDate: date('pending_date').notNull(),
    hiredRecordId: uuid('hired_record_id'),
    hiredOn: date('hired_on'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    unique('onboarding_entry_cases_tenant_id').on(t.tenantId, t.id),
    unique('onboarding_entry_cases_root').on(t.tenantId, t.rootBusinessId),
    unique('onboarding_entry_cases_current').on(t.tenantId, t.currentBusinessId),
    unique('onboarding_entry_cases_hired_record').on(t.tenantId, t.hiredRecordId),
    foreignKey({
      name: 'onboarding_entry_cases_root_fk',
      columns: [t.tenantId, t.employeeId, t.rootBusinessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'onboarding_entry_cases_current_fk',
      columns: [t.tenantId, t.employeeId, t.currentBusinessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'onboarding_entry_cases_hired_record_fk',
      columns: [t.tenantId, t.employeeId, t.hiredRecordId],
      foreignColumns: [employmentRecords.tenantId, employmentRecords.employeeId, employmentRecords.id],
    }),
    foreignKey({
      name: 'onboarding_entry_cases_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_entry_cases_updater_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    index('onboarding_entry_cases_state_date').on(t.tenantId, t.state, t.pendingDate, t.id),
    check('onboarding_entry_cases_state_valid', sql`${t.state} IN ('pending','cancelled','hired','deleted')`),
    check('onboarding_entry_cases_revision_positive', sql`${t.revision} > 0`),
    check(
      'onboarding_entry_cases_dates_finite',
      sql`isfinite(${t.pendingDate}) AND (${t.hiredOn} IS NULL OR isfinite(${t.hiredOn}))`,
    ),
    check(
      'onboarding_entry_cases_hire_valid',
      sql`(${t.state} = 'hired' AND ${t.hiredOn} IS NOT NULL AND ${t.hiredRecordId} IS NOT NULL)
        OR (${t.state} <> 'hired' AND ${t.hiredOn} IS NULL AND ${t.hiredRecordId} IS NULL)`,
    ),
  ],
);

export type OnboardingEntryCase = typeof onboardingEntryCases.$inferSelect;
