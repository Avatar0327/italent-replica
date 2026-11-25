import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { jobPositionObjects, jobPostObjects } from './job.js';
import { onboardingIntegrationTaskPool } from './onboarding-integration-pool.js';
import { orgObjects } from './org.js';
import { permissionProfiles } from './permission.js';
import { tenantMemberships, tenants } from './tenancy.js';

const offsetUnits = ['day', 'week', 'month'] as const;
const assigneeTypes = ['member', 'role', 'position', 'post', 'identity', 'employee'] as const;
const roles = ['department_head', 'direct_manager', 'mentor', 'hrbp'] as const;

export type IntegrationScopeConditions = Readonly<Record<string, readonly string[]>>;

const id = () => uuid('id').defaultRandom().primaryKey();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

function timingColumns() {
  return {
    startUnit: text('start_unit', { enum: offsetUnits }).notNull(),
    startOrdinal: integer('start_ordinal').notNull(),
    dueUnit: text('due_unit', { enum: offsetUnits }).notNull(),
    dueOrdinal: integer('due_ordinal').notNull(),
  };
}

function timingCheck(name: string, t: Record<'startUnit' | 'dueUnit' | 'startOrdinal' | 'dueOrdinal', AnyPgColumn>) {
  return check(
    name,
    sql`${t.startUnit} IN ('day','week','month') AND ${t.dueUnit} IN ('day','week','month')
    AND ${t.startOrdinal} > 0 AND ${t.dueOrdinal} > 0`,
  );
}

export const onboardingIntegrationSchemes = pgTable(
  'onboarding_integration_schemes',
  {
    id: id(),
    tenantId: tenantId(),
    name: jsonb('name').$type<Readonly<Record<string, string>>>().notNull(),
    priority: integer('priority').notNull(),
    description: text('description'),
    failureRecipientId: uuid('failure_recipient_id'),
    conditions: jsonb('conditions').$type<IntegrationScopeConditions>().notNull(),
    scopeKey: text('scope_key').notNull(),
    reminderDays: integer('reminder_days'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [
    unique('onboarding_scheme_tenant_id').on(t.tenantId, t.id),
    unique('onboarding_scheme_priority_scope').on(t.tenantId, t.priority, t.scopeKey),
    foreignKey({
      name: 'onboarding_scheme_recipient_fk',
      columns: [t.tenantId, t.failureRecipientId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_scheme_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_scheme_updater_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    check(
      'onboarding_scheme_values',
      sql`${t.priority} >= 0 AND ${t.revision} > 0
      AND ${t.reminderDays} > 0 AND char_length(${t.description}) <= 500
      AND jsonb_typeof(${t.name}) = 'object' AND jsonb_typeof(${t.conditions}) = 'object'`,
    ),
  ],
);

export const onboardingIntegrationScopeOrgs = pgTable(
  'onboarding_integration_scope_orgs',
  {
    tenantId: uuid('tenant_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    orgId: uuid('org_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.schemeId, t.orgId], name: 'onboarding_scope_org_pk' }),
    foreignKey({
      name: 'onboarding_scope_org_scheme_fk',
      columns: [t.tenantId, t.schemeId],
      foreignColumns: [onboardingIntegrationSchemes.tenantId, onboardingIntegrationSchemes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'onboarding_scope_org_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    index('onboarding_scope_org_match').on(t.tenantId, t.orgId, t.schemeId),
  ],
);

export const onboardingIntegrationStages = pgTable(
  'onboarding_integration_stages',
  {
    id: id(),
    tenantId: uuid('tenant_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    sequence: integer('sequence').notNull(),
    name: text('name').notNull(),
    ...timingColumns(),
  },
  (t) => [
    unique('onboarding_stage_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'onboarding_stage_scheme_fk',
      columns: [t.tenantId, t.schemeId],
      foreignColumns: [onboardingIntegrationSchemes.tenantId, onboardingIntegrationSchemes.id],
    }).onDelete('cascade'),
    index('onboarding_stage_order').on(t.tenantId, t.schemeId, t.sequence, t.id),
    timingCheck('onboarding_stage_dates', t),
  ],
);

export const onboardingIntegrationStageTasks = pgTable(
  'onboarding_integration_stage_tasks',
  {
    id: id(),
    tenantId: uuid('tenant_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    poolTaskId: uuid('pool_task_id').notNull(),
    sequence: integer('sequence').notNull(),
    ...timingColumns(),
    assigneeType: text('assignee_type', { enum: assigneeTypes }).notNull(),
    assigneeRole: text('assignee_role', { enum: roles }),
    assigneeUserId: uuid('assignee_user_id'),
    assigneePositionId: uuid('assignee_position_id'),
    assigneePostId: uuid('assignee_post_id'),
    assigneeProfileId: uuid('assignee_profile_id'),
    employeeVisible: boolean('employee_visible').notNull(),
    reminderDays: integer('reminder_days'),
  },
  (t) => [
    unique('onboarding_stage_task_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'onboarding_stage_task_stage_fk',
      columns: [t.tenantId, t.stageId],
      foreignColumns: [onboardingIntegrationStages.tenantId, onboardingIntegrationStages.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'onboarding_stage_task_pool_fk',
      columns: [t.tenantId, t.poolTaskId],
      foreignColumns: [onboardingIntegrationTaskPool.tenantId, onboardingIntegrationTaskPool.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'onboarding_stage_task_member_fk',
      columns: [t.tenantId, t.assigneeUserId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      name: 'onboarding_stage_task_position_fk',
      columns: [t.tenantId, t.assigneePositionId],
      foreignColumns: [jobPositionObjects.tenantId, jobPositionObjects.id],
    }),
    foreignKey({
      name: 'onboarding_stage_task_post_fk',
      columns: [t.tenantId, t.assigneePostId],
      foreignColumns: [jobPostObjects.tenantId, jobPostObjects.id],
    }),
    foreignKey({
      name: 'onboarding_stage_task_profile_fk',
      columns: [t.tenantId, t.assigneeProfileId],
      foreignColumns: [permissionProfiles.tenantId, permissionProfiles.id],
    }),
    index('onboarding_stage_task_order').on(t.tenantId, t.stageId, t.sequence, t.id),
    index('onboarding_stage_task_pool').on(t.tenantId, t.poolTaskId),
    timingCheck('onboarding_stage_task_dates', t),
    check('onboarding_stage_task_reminder', sql`${t.reminderDays} >= 0`),
    check(
      'onboarding_stage_task_assignee',
      sql`
      (${t.assigneeType} = 'member') = (${t.assigneeUserId} IS NOT NULL)
      AND (${t.assigneeType} = 'role') = (${t.assigneeRole} IS NOT NULL)
      AND ${t.assigneeRole} IN ('department_head','direct_manager','mentor','hrbp')
      AND (${t.assigneeType} = 'position') = (${t.assigneePositionId} IS NOT NULL)
      AND (${t.assigneeType} = 'post') = (${t.assigneePostId} IS NOT NULL)
      AND (${t.assigneeType} = 'identity') = (${t.assigneeProfileId} IS NOT NULL)
      AND (${t.assigneeType} <> 'employee' OR ${t.employeeVisible})
      AND ${t.assigneeType} IN ('member','role','position','post','identity','employee')`,
    ),
  ],
);

export const onboardingIntegrationSettings = pgTable(
  'onboarding_integration_settings',
  {
    tenantId: tenantId().primaryKey(),
    autoStart: boolean('auto_start').notNull().default(false),
    revision: integer('revision').notNull().default(1),
    updatedAt: utc('updated_at'),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'onboarding_integration_settings_updater_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    check('onboarding_integration_settings_revision', sql`${t.revision} > 0`),
  ],
);
