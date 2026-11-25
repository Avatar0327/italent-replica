import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import type { ProcessCondition } from '@italent/domain';
import { jobPositionObjects, jobPostObjects } from './job.js';
import { onboardingEntryCases } from './onboarding.js';
import { orgObjects } from './org.js';
import { permissionProfiles } from './permission.js';
import { tenantMemberships, tenants } from './tenancy.js';

export type PreparationField = {
  code: string;
  label: string;
  required: boolean;
  writeback?: 'employee.code' | 'employee.workEmail';
};

export type PreparationSelector =
  | { kind: 'member' | 'position' | 'post' | 'identity'; id: string }
  | { kind: 'direct_manager' | 'department_head' | 'hrbp'; id?: never };

type Ref = { tenantId: AnyPgColumn; id: AnyPgColumn };
const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const stamp = (name: string) => timestamp(name, { withTimezone: true });
const memberRef = { tenantId: tenantMemberships.tenantId, id: tenantMemberships.userId };
const ref = (name: string, tenantId: AnyPgColumn, column: AnyPgColumn, target: Ref) =>
  foreignKey({ name, columns: [tenantId, column], foreignColumns: [target.tenantId, target.id] });

const head = () => ({
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenant(),
  name: text('name').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  archived: boolean('archived').default(false).notNull(),
  revision: integer('revision').default(1).notNull(),
  createdAt: stamp('created_at').defaultNow().notNull(),
  updatedAt: stamp('updated_at').defaultNow().notNull(),
  createdBy: uuid('created_by').notNull(),
  updatedBy: uuid('updated_by').notNull(),
});
type Head = Record<'tenantId' | 'id' | 'createdBy' | 'updatedBy' | 'archived' | 'enabled' | 'revision', AnyPgColumn>;
const headRules = (name: string, t: Head) => [
  unique(`${name}_tenant_key`).on(t.tenantId, t.id),
  ref(`${name}_creator_fk`, t.tenantId, t.createdBy, memberRef),
  ref(`${name}_updater_fk`, t.tenantId, t.updatedBy, memberRef),
  check(`${name}_valid`, sql`${t.revision} > 0 AND (NOT ${t.archived} OR NOT ${t.enabled})`),
];
export const preparationCategories = ['employee_code', 'work_email', 'other'] as const;
export const onboardingPreparationItems = pgTable(
  'onboarding_preparation_items',
  {
    ...head(),
    category: text('category', { enum: preparationCategories }).notNull(),
    code: text('code').notNull(),
    fields: jsonb('fields').$type<PreparationField[]>().notNull(),
  },
  (t) => [
    ...headRules('onboarding_prep_items', t),
    unique('onboarding_prep_items_code').on(t.tenantId, t.category, t.code),
    check('onboarding_prep_items_category', sql`${t.category} IN ('employee_code', 'work_email', 'other')`),
  ],
);

export const onboardingPreparationRules = pgTable(
  'onboarding_preparation_rules',
  {
    ...head(),
    itemId: uuid('item_id').notNull(),
    priority: integer('priority').notNull(),
    conditions: jsonb('conditions').$type<ProcessCondition>().notNull(),
    startDaysBefore: integer('start_days_before'),
    remindDaysBefore: integer('remind_days_before'),
  },
  (t) => [
    ...headRules('onboarding_prep_rules', t),
    unique('onboarding_prep_rules_item_key').on(t.tenantId, t.itemId, t.id),
    ref('onboarding_prep_rules_item_fk', t.tenantId, t.itemId, onboardingPreparationItems),
    index('onboarding_prep_rules_match').on(t.tenantId, t.enabled, t.itemId, t.priority),
    check('onboarding_prep_rules_priority', sql`${t.priority} >= 0`),
    check('onboarding_prep_rules_start', sql`${t.startDaysBefore} BETWEEN 1 AND 365`),
    check('onboarding_prep_rules_remind', sql`${t.remindDaysBefore} BETWEEN 1 AND 365`),
  ],
);

export const onboardingPreparationScopeOrgs = pgTable(
  'onboarding_preparation_scope_orgs',
  { tenantId: tenant(), ruleId: uuid('rule_id').notNull(), orgId: uuid('org_id').notNull() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ruleId, t.orgId] }),
    ref('onboarding_prep_scope_rule_fk', t.tenantId, t.ruleId, onboardingPreparationRules),
    ref('onboarding_prep_scope_org_fk', t.tenantId, t.orgId, orgObjects),
    index('onboarding_prep_scope_org').on(t.tenantId, t.orgId, t.ruleId),
  ],
);

export const onboardingPreparationRuleAssignees = pgTable(
  'onboarding_preparation_rule_assignees',
  {
    tenantId: tenant(),
    ruleId: uuid('rule_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').$type<PreparationSelector['kind']>().notNull(),
    userId: uuid('user_id'),
    positionId: uuid('position_id'),
    postId: uuid('post_id'),
    profileId: uuid('profile_id'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ruleId, t.ordinal] }),
    ref('onboarding_prep_selector_rule_fk', t.tenantId, t.ruleId, onboardingPreparationRules),
    ref('onboarding_prep_selector_member_fk', t.tenantId, t.userId, memberRef),
    ref('onboarding_prep_selector_position_fk', t.tenantId, t.positionId, jobPositionObjects),
    ref('onboarding_prep_selector_post_fk', t.tenantId, t.postId, jobPostObjects),
    ref('onboarding_prep_selector_identity_fk', t.tenantId, t.profileId, permissionProfiles),
    check(
      'onboarding_prep_selector_shape',
      sql`(${t.kind} = 'member' AND ${t.userId} IS NOT NULL
        OR ${t.kind} = 'position' AND ${t.positionId} IS NOT NULL
        OR ${t.kind} = 'post' AND ${t.postId} IS NOT NULL
        OR ${t.kind} = 'identity' AND ${t.profileId} IS NOT NULL
        OR ${t.kind} IN ('direct_manager', 'department_head', 'hrbp')
          AND num_nonnulls(${t.userId}, ${t.positionId}, ${t.postId}, ${t.profileId}) = 0)
        AND num_nonnulls(${t.userId}, ${t.positionId}, ${t.postId}, ${t.profileId}) <= 1`,
    ),
  ],
);

export const onboardingPreparationTasks = pgTable(
  'onboarding_preparation_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: tenant(),
    caseId: uuid('case_id').notNull(),
    itemId: uuid('item_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    caseRevision: integer('case_revision').notNull(),
    revision: integer('revision').default(1).notNull(),
    status: text('status', { enum: ['scheduled', 'open', 'completed', 'closed'] }).notNull(),
    nextDueOn: date('next_due_on'),
    nextRemindOn: date('next_remind_on'),
    startDaysBefore: integer('start_days_before'),
    remindDaysBefore: integer('remind_days_before'),
    ruleSnapshot: jsonb('rule_snapshot')
      .$type<{
        revision: number;
        orgIds: string[];
        conditions: ProcessCondition;
        assignees: PreparationSelector[];
      }>()
      .notNull(),
    formSnapshot: jsonb('form_snapshot')
      .$type<{
        revision: number;
        category: (typeof preparationCategories)[number];
        name: string;
        fields: PreparationField[];
      }>()
      .notNull(),
    result: jsonb('result').$type<Record<string, string>>(),
    completedBy: uuid('completed_by'),
    completedAt: stamp('completed_at'),
    createdAt: stamp('created_at').defaultNow().notNull(),
    updatedAt: stamp('updated_at').defaultNow().notNull(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    unique('onboarding_prep_task_tenant_key').on(t.tenantId, t.id),
    uniqueIndex('onboarding_prep_task_current')
      .on(t.tenantId, t.caseId, t.itemId)
      .where(sql`${t.status} <> 'closed'`),
    index('onboarding_prep_task_case').on(t.tenantId, t.caseId, t.status),
    index('onboarding_prep_task_due').on(t.tenantId, t.status, t.nextDueOn, t.id),
    ref('onboarding_prep_task_case_fk', t.tenantId, t.caseId, onboardingEntryCases),
    foreignKey({
      name: 'onboarding_prep_task_rule_fk',
      columns: [t.tenantId, t.itemId, t.ruleId],
      foreignColumns: [
        onboardingPreparationRules.tenantId,
        onboardingPreparationRules.itemId,
        onboardingPreparationRules.id,
      ],
    }),
    ref('onboarding_prep_task_finisher_fk', t.tenantId, t.completedBy, memberRef),
    ref('onboarding_prep_task_creator_fk', t.tenantId, t.createdBy, memberRef),
    ref('onboarding_prep_task_updater_fk', t.tenantId, t.updatedBy, memberRef),
    check(
      'onboarding_prep_task_status',
      sql`${t.status} IN ('scheduled', 'open', 'completed', 'closed')
        AND ((${t.status} = 'scheduled') = (${t.nextDueOn} IS NOT NULL))
        AND ((${t.status} = 'completed') = (${t.completedBy} IS NOT NULL AND ${t.completedAt} IS NOT NULL))
        AND (${t.completedBy} IS NULL) = (${t.completedAt} IS NULL)`,
    ),
    check('onboarding_prep_task_revision', sql`${t.revision} > 0 AND ${t.caseRevision} > 0`),
  ],
);

export const onboardingPreparationAssignees = pgTable(
  'onboarding_preparation_assignees',
  {
    tenantId: tenant(),
    taskId: uuid('task_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: text('status', { enum: ['open', 'completed', 'revoked'] }).notNull(),
    endedAt: stamp('ended_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.taskId, t.userId] }),
    ref('onboarding_prep_assignee_task_fk', t.tenantId, t.taskId, onboardingPreparationTasks),
    ref('onboarding_prep_assignee_member_fk', t.tenantId, t.userId, memberRef),
    index('onboarding_prep_my_tasks').on(t.tenantId, t.userId, t.status, t.taskId),
    check(
      'onboarding_prep_assignee_status',
      sql`${t.status} IN ('open', 'completed', 'revoked')
      AND ((${t.status} = 'open') = (${t.endedAt} IS NULL))`,
    ),
  ],
);
