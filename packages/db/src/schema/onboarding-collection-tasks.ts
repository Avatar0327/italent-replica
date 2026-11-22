import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { onboardingCollectionRules, onboardingCollectionTemplates } from './onboarding-collection.js';
import { onboardingEntryCases } from './onboarding.js';
import { tenantMemberships } from './tenancy.js';

export const COLLECTION_TASK_STATES = [
  'ready',
  'sent',
  'draft',
  'in_review',
  'returned',
  'rehire_pending',
  'completed',
  'closed',
  'withdrawn',
] as const;
export const ACTIVE_COLLECTION_TASK_STATES = [
  'ready',
  'sent',
  'draft',
  'in_review',
  'returned',
  'rehire_pending',
] as const;

interface FrozenField {
  objectCode: string;
  fieldCode: string;
  group: string;
  position: number;
  required: boolean;
  editable: boolean;
}

const taskStatesSql = sql.raw(COLLECTION_TASK_STATES.map((value) => `'${value}'`).join(','));
const timestampUtc = (column: string) => timestamp(column, { withTimezone: true });
export const onboardingCollectionTasks = pgTable(
  'onboarding_collection_tasks',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id').notNull(),
    templateId: uuid('template_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    templateRevision: integer('template_revision').notNull(),
    ruleRevision: integer('rule_revision').notNull(),
    fields: jsonb('fields').$type<FrozenField[]>().notNull(),
    requiredSubsets: jsonb('required_subsets').$type<string[]>().notNull(),
    verificationMode: text('verification_mode', { enum: ['independent_channel', 'phone_otp'] }).notNull(),
    requiresApproval: boolean('requires_approval').notNull(),
    status: text('status', { enum: COLLECTION_TASK_STATES }).notNull().default('ready'),
    nextRemindOn: date('next_remind_on'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestampUtc('created_at').notNull(),
    updatedAt: timestampUtc('updated_at').notNull(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    unique('onboarding_collection_task_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('onboarding_collection_task_active')
      .on(t.tenantId, t.caseId)
      .where(sql`${t.status} IN ('ready','sent','draft','in_review','returned','rehire_pending')`),
    index('onboarding_collection_task_case').on(t.tenantId, t.caseId, t.createdAt, t.id),
    index('onboarding_collection_task_template').on(t.tenantId, t.templateId),
    index('onboarding_collection_task_rule').on(t.tenantId, t.ruleId),
    index('onboarding_collection_task_remind').on(t.tenantId, t.status, t.nextRemindOn, t.id),
    foreignKey({
      name: 'onboarding_collection_task_case_fk',
      columns: [t.tenantId, t.caseId],
      foreignColumns: [onboardingEntryCases.tenantId, onboardingEntryCases.id],
    }),
    foreignKey({
      name: 'onboarding_collection_task_template_fk',
      columns: [t.tenantId, t.templateId],
      foreignColumns: [onboardingCollectionTemplates.tenantId, onboardingCollectionTemplates.id],
    }),
    foreignKey({
      name: 'onboarding_collection_task_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [onboardingCollectionRules.tenantId, onboardingCollectionRules.id],
    }),
    foreignKey({
      name: 'onboarding_collection_task_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_collection_task_updater_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    check('onboarding_collection_task_status', sql`${t.status} IN (${taskStatesSql})`),
    check('onboarding_collection_task_verification', sql`${t.verificationMode} IN ('independent_channel','phone_otp')`),
    check(
      'onboarding_collection_task_revisions',
      sql`${t.revision} > 0 AND ${t.templateRevision} > 0 AND ${t.ruleRevision} > 0`,
    ),
  ],
);

export const onboardingCollectionComments = pgTable(
  'onboarding_collection_comments',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id').notNull(),
    authorId: uuid('author_id').notNull(),
    text: text('text').notNull(),
    createdAt: timestampUtc('created_at').notNull(),
  },
  (t) => [
    index('onboarding_collection_comment_task').on(t.tenantId, t.taskId, t.createdAt, t.id),
    foreignKey({
      name: 'onboarding_collection_comment_task_fk',
      columns: [t.tenantId, t.taskId],
      foreignColumns: [onboardingCollectionTasks.tenantId, onboardingCollectionTasks.id],
    }),
    foreignKey({
      name: 'onboarding_collection_comment_author_fk',
      columns: [t.tenantId, t.authorId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    check('onboarding_collection_comment_text', sql`length(btrim(${t.text})) BETWEEN 1 AND 2000`),
  ],
);

/** 任职创建事件的采集消费回执。一阶段只登记一次作业，领取时再读当前业务。 */
export const onboardingCollectionJobs = pgTable(
  'onboarding_collection_jobs',
  {
    tenantId: uuid('tenant_id').notNull(),
    caseId: uuid('case_id').notNull(),
    status: text('status', { enum: ['pending', 'done', 'skipped', 'failed'] })
      .notNull()
      .default('pending'),
    reason: text('reason'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestampUtc('next_attempt_at').notNull(),
    updatedAt: timestampUtc('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.caseId] }),
    index('onboarding_collection_job_due')
      .on(t.tenantId, t.nextAttemptAt, t.caseId)
      .where(sql`${t.status} IN ('pending','failed')`),
    foreignKey({
      name: 'onboarding_collection_job_case_fk',
      columns: [t.tenantId, t.caseId],
      foreignColumns: [onboardingEntryCases.tenantId, onboardingEntryCases.id],
    }),
    check('onboarding_collection_job_status', sql`${t.status} IN ('pending','done','skipped','failed')`),
    check('onboarding_collection_job_attempts', sql`${t.attempts} >= 0`),
  ],
);

export type OnboardingCollectionTask = typeof onboardingCollectionTasks.$inferSelect;
