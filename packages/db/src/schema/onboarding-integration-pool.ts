import type { AssessmentType } from '@italent/domain';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantMemberships, tenants } from './tenancy.js';

export const INTEGRATION_POOL_CATEGORIES = [
  'administrative',
  'team_integration',
  'work_integration',
  'new_employee_introduction',
  'probation_assessment',
  'learning_plan',
  'probation_goal_plan',
  'survey',
  'other',
] as const;

export type IntegrationPoolCategory = (typeof INTEGRATION_POOL_CATEGORIES)[number];
export const INTEGRATION_POOL_DEFERRED_CATEGORIES = ['learning_plan', 'probation_goal_plan', 'survey'] as const;

export const INTEGRATION_POOL_FORM_KINDS = ['text', 'number', 'date', 'boolean'] as const;
export interface IntegrationPoolFormField {
  readonly code: string;
  readonly label: string;
  readonly kind: (typeof INTEGRATION_POOL_FORM_KINDS)[number];
  readonly required: boolean;
}

const categorySql = sql.raw(
  INTEGRATION_POOL_CATEGORIES.filter((code) => !INTEGRATION_POOL_DEFERRED_CATEGORIES.some((c) => c === code))
    .map((code) => `'${code}'`)
    .join(', '),
);
export const INTEGRATION_POOL_ASSESSMENT_TYPES = [
  'probation',
  'regularization',
] as const satisfies readonly AssessmentType[];
const assessmentsSql = sql.raw(INTEGRATION_POOL_ASSESSMENT_TYPES.map((code) => `'${code}'`).join(', '));

/** R2-T01 §3.3。后续方案关系和历史任务以 (tenant_id, id) 引用，禁止级联删除。 */
export const onboardingIntegrationTaskPool = pgTable(
  'onboarding_integration_task_pool',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category', { enum: INTEGRATION_POOL_CATEGORIES }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    assessmentType: text('assessment_type').$type<AssessmentType>(),
    assessmentName: text('assessment_name'),
    formFields: jsonb('form_fields').$type<readonly IntegrationPoolFormField[]>(),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [
    unique('onboarding_integration_pool_tenant_id').on(t.tenantId, t.id),
    unique('onboarding_integration_pool_tenant_code').on(t.tenantId, t.code),
    foreignKey({
      name: 'onboarding_integration_pool_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_integration_pool_updater_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    index('onboarding_integration_pool_category_status').on(t.tenantId, t.category, t.enabled, t.code, t.id),
    index('onboarding_integration_pool_status').on(t.tenantId, t.enabled, t.code, t.id),
    check('onboarding_integration_pool_category', sql`${t.category} IN (${categorySql})`),
    check('onboarding_integration_pool_revision', sql`${t.revision} > 0`),
    check(
      'onboarding_integration_pool_title',
      sql`char_length(btrim(${t.code})) BETWEEN 1 AND 100 AND char_length(btrim(${t.name})) BETWEEN 1 AND 100`,
    ),
    check(
      'onboarding_integration_pool_action',
      sql`(${t.category} = 'probation_assessment'
        AND ${t.assessmentType} IS NOT NULL AND ${t.assessmentType} IN (${assessmentsSql})
        AND ${t.assessmentName} IS NOT NULL AND char_length(btrim(${t.assessmentName})) BETWEEN 1 AND 100
        AND ${t.formFields} IS NULL)
        OR (${t.category} <> 'probation_assessment' AND ${t.assessmentType} IS NULL AND ${t.assessmentName} IS NULL
        AND ${t.formFields} IS NOT NULL AND jsonb_typeof(${t.formFields}) = 'array')`,
    ),
  ],
);

export type IntegrationPoolTask = typeof onboardingIntegrationTaskPool.$inferSelect;
