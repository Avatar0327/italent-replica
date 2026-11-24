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
import type { ProcessCondition } from '@italent/domain';
import { orgObjects } from './org.js';
import { tenantMemberships, tenants } from './tenancy.js';

const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const timestamps = () => ({
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
  updatedBy: uuid('updated_by').notNull(),
});
const actors = (prefix: string, t: Record<'tenantId' | 'createdBy' | 'updatedBy' | 'revision', AnyPgColumn>) => [
  foreignKey({
    name: `${prefix}_created_by_fk`,
    columns: [t.tenantId, t.createdBy],
    foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
  }),
  foreignKey({
    name: `${prefix}_updated_by_fk`,
    columns: [t.tenantId, t.updatedBy],
    foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
  }),
  check(`${prefix}_revision_positive`, sql`${t.revision} > 0`),
];
const head = () => ({
  tenantId: tenant(),
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull(),
  archived: boolean('archived').notNull().default(false),
  ...timestamps(),
});

export const onboardingCollectionTemplates = pgTable(
  'onboarding_collection_templates',
  {
    ...head(),
    noticeTitle: text('notice_title').notNull(),
    noticeBody: text('notice_body').notNull(),
  },
  (t) => [
    ...actors('onboarding_collection_templates', t),
    unique('onboarding_collection_template_tenant_id').on(t.tenantId, t.id),
    index('onboarding_collection_template_list').on(t.tenantId, t.archived, t.id),
    check('onboarding_collection_template_archived', sql`NOT ${t.archived} OR NOT ${t.enabled}`),
  ],
);

export const onboardingCollectionFields = pgTable(
  'onboarding_collection_fields',
  {
    tenantId: tenant(),
    templateId: uuid('template_id').notNull(),
    objectCode: text('object_code').notNull(),
    fieldCode: text('field_code').notNull(),
    group: text('group_name').notNull(),
    position: integer('position').notNull(),
    required: boolean('required').notNull(),
    editable: boolean('editable').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.templateId, t.objectCode, t.fieldCode] }),
    unique('onboarding_collection_field_position').on(t.tenantId, t.templateId, t.position),
    foreignKey({
      name: 'onboarding_collection_field_template_fk',
      columns: [t.tenantId, t.templateId],
      foreignColumns: [onboardingCollectionTemplates.tenantId, onboardingCollectionTemplates.id],
    }),
    check('onboarding_collection_field_position_nonnegative', sql`${t.position} >= 0`),
  ],
);

export const onboardingCollectionRules = pgTable(
  'onboarding_collection_rules',
  {
    ...head(),
    templateId: uuid('template_id').notNull(),
    priority: integer('priority').notNull(),
    conditions: jsonb('conditions').$type<ProcessCondition>().notNull(),
    verificationMode: text('verification_mode', { enum: ['independent_channel', 'phone_otp'] }).notNull(),
    requiresApproval: boolean('requires_approval').notNull(),
    remindDaysBefore: integer('remind_days_before'),
  },
  (t) => [
    ...actors('onboarding_collection_rules', t),
    unique('onboarding_collection_rule_tenant_id').on(t.tenantId, t.id),
    index('onboarding_collection_rule_template').on(t.tenantId, t.templateId),
    index('onboarding_collection_rule_match').on(t.tenantId, t.archived, t.enabled, t.priority, t.id),
    foreignKey({
      name: 'onboarding_collection_rule_template_fk',
      columns: [t.tenantId, t.templateId],
      foreignColumns: [onboardingCollectionTemplates.tenantId, onboardingCollectionTemplates.id],
    }),
    check('onboarding_collection_rule_archived', sql`NOT ${t.archived} OR NOT ${t.enabled}`),
    check('onboarding_collection_rule_priority', sql`${t.priority} >= 0`),
    check('onboarding_collection_rule_remind_days', sql`${t.remindDaysBefore} BETWEEN 1 AND 365`),
    check('onboarding_collection_rule_verify', sql`${t.verificationMode} IN ('independent_channel','phone_otp')`),
  ],
);

export const onboardingCollectionScopeOrgs = pgTable(
  'onboarding_collection_scope_orgs',
  { tenantId: tenant(), ruleId: uuid('rule_id').notNull(), orgId: uuid('org_id').notNull() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ruleId, t.orgId] }),
    index('onboarding_collection_scope_org').on(t.tenantId, t.orgId, t.ruleId),
    foreignKey({
      name: 'onboarding_collection_scope_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [onboardingCollectionRules.tenantId, onboardingCollectionRules.id],
    }),
    foreignKey({
      name: 'onboarding_collection_scope_org_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
  ],
);

export const onboardingCollectionRequiredSubsets = pgTable(
  'onboarding_collection_required_subsets',
  { tenantId: tenant(), ruleId: uuid('rule_id').notNull(), subsetCode: text('subset_code').notNull() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ruleId, t.subsetCode] }),
    foreignKey({
      name: 'onboarding_collection_required_subset_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [onboardingCollectionRules.tenantId, onboardingCollectionRules.id],
    }),
  ],
);

export const onboardingCollectionSettings = pgTable(
  'onboarding_collection_settings',
  { tenantId: tenant().primaryKey(), enabled: boolean('enabled').notNull().default(true), ...timestamps() },
  (t) => actors('onboarding_collection_settings', t),
);
