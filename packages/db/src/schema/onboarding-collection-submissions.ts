import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects } from './employment.js';
import { onboardingCollectionTasks } from './onboarding-collection-tasks.js';
import { orgObjects } from './org.js';
import { tenantMemberships } from './tenancy.js';

export interface CollectionSubmissionValues {
  profileRevision: number;
  profile: Record<string, unknown>;
  subsets: {
    kind: 'education' | 'certificate';
    id?: string;
    revision: number;
    values: Record<string, unknown>;
  }[];
}

export const onboardingCollectionSubmissions = pgTable(
  'onboarding_collection_submissions',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    version: integer('version').notNull(),
    businessRevision: integer('business_revision').notNull(),
    caseRevision: integer('case_revision').notNull(),
    kind: text('kind', { enum: ['draft', 'submit'] }).notNull(),
    departmentId: uuid('department_id').notNull(),
    pendingDate: date('pending_date').notNull(),
    values: jsonb('values').$type<CollectionSubmissionValues>().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('onboarding_collection_submission_version').on(t.tenantId, t.taskId, t.version),
    index('onboarding_collection_submission_business').on(t.tenantId, t.employeeId, t.businessId),
    index('onboarding_collection_submission_author').on(t.tenantId, t.createdBy),
    index('onboarding_collection_submission_department').on(t.tenantId, t.departmentId),
    foreignKey({
      name: 'onboarding_collection_submission_task_fk',
      columns: [t.tenantId, t.taskId],
      foreignColumns: [onboardingCollectionTasks.tenantId, onboardingCollectionTasks.id],
    }),
    foreignKey({
      name: 'onboarding_collection_submission_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'onboarding_collection_submission_author_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_collection_submission_department_fk',
      columns: [t.tenantId, t.departmentId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    check('onboarding_collection_submission_kind', sql`${t.kind} IN ('draft','submit')`),
    check(
      'onboarding_collection_submission_revisions',
      sql`${t.version} > 0 AND ${t.businessRevision} > 0 AND ${t.caseRevision} > 0`,
    ),
  ],
);

export type OnboardingCollectionSubmission = typeof onboardingCollectionSubmissions.$inferSelect;
