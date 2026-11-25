import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { onboardingEntryCases } from './onboarding.js';
import { orgObjects } from './org.js';
import { tenantMemberships, tenants } from './tenancy.js';

const materialStatus = ['pending', 'submitted', 'received'] as const;
const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const id = () => uuid('id').defaultRandom().primaryKey();
const revision = () => integer('revision').notNull().default(1);
const stamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
});
const members = (prefix: string, t: { tenantId: AnyPgColumn; createdBy: AnyPgColumn; updatedBy: AnyPgColumn }) => [
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
];

export const onboardingMaterialRules = pgTable(
  'onboarding_material_rules',
  {
    tenantId: tenant(),
    id: id(),
    revision: revision(),
    ...stamps(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    archived: boolean('archived').notNull().default(false),
    priority: integer('priority').notNull(),
    remindAfterHire: boolean('remind_after_hire').notNull().default(false),
    remindDays: integer('remind_days'),
  },
  (t) => [
    ...members('onboarding_material_rules', t),
    unique('onboarding_material_rules_tenant_id').on(t.tenantId, t.id),
    index('onboarding_material_rules_match').on(t.tenantId, t.archived, t.enabled, t.priority, t.id),
    check('onboarding_material_rule_revision', sql`${t.revision} > 0`),
    check('onboarding_material_rule_archive', sql`NOT ${t.archived} OR NOT ${t.enabled}`),
    check('onboarding_material_rule_priority', sql`${t.priority} >= 0`),
    check(
      'onboarding_material_rule_remind_days',
      sql`(${t.remindDays} IS NULL OR ${t.remindDays} > 0)
        AND (NOT ${t.remindAfterHire} OR ${t.remindDays} IS NOT NULL)`,
    ),
  ],
);

export const onboardingMaterialScopeOrgs = pgTable(
  'onboarding_material_scope_orgs',
  { tenantId: tenant(), ruleId: uuid('rule_id').notNull(), orgId: uuid('org_id').notNull() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.ruleId, t.orgId] }),
    foreignKey({
      name: 'onboarding_material_scope_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [onboardingMaterialRules.tenantId, onboardingMaterialRules.id],
    }),
    foreignKey({
      name: 'onboarding_material_scope_org_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    index('onboarding_material_scope_org').on(t.tenantId, t.orgId, t.ruleId),
  ],
);

/** 定义属于规则聚合。移除时保留稳定 ID，已经生成的清单可继续指向它。 */
export const onboardingMaterialRuleItems = pgTable(
  'onboarding_material_rule_items',
  {
    tenantId: tenant(),
    id: id(),
    revision: revision(),
    ruleId: uuid('rule_id').notNull(),
    name: text('name').notNull(),
    required: boolean('required').notNull(),
    allowSupplement: boolean('allow_supplement').notNull(),
    position: integer('position').notNull(),
    archived: boolean('archived').notNull().default(false),
  },
  (t) => [
    unique('onboarding_material_rule_items_tenant_rule_id').on(t.tenantId, t.ruleId, t.id),
    foreignKey({
      name: 'onboarding_material_rule_item_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [onboardingMaterialRules.tenantId, onboardingMaterialRules.id],
    }),
    index('onboarding_material_rule_item_list').on(t.tenantId, t.ruleId, t.archived, t.position, t.id),
    check('onboarding_material_rule_item_revision', sql`${t.revision} > 0`),
    check('onboarding_material_rule_item_position', sql`${t.position} >= 0`),
  ],
);

export const onboardingMaterialItems = pgTable(
  'onboarding_material_items',
  {
    tenantId: tenant(),
    id: id(),
    revision: revision(),
    ...stamps(),
    caseId: uuid('case_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    ruleRevision: integer('rule_revision').notNull(),
    definitionId: uuid('definition_id').notNull(),
    definitionRevision: integer('definition_revision').notNull(),
    definitionName: text('definition_name').notNull(),
    required: boolean('required').notNull(),
    allowSupplement: boolean('allow_supplement').notNull(),
    position: integer('position').notNull(),
    status: text('status', { enum: materialStatus }).notNull().default('pending'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
  },
  (t) => [
    ...members('onboarding_material_items', t),
    unique('onboarding_material_items_tenant_id').on(t.tenantId, t.id),
    unique('onboarding_material_item_case_definition').on(t.tenantId, t.caseId, t.definitionId),
    foreignKey({
      name: 'onboarding_material_item_case_fk',
      columns: [t.tenantId, t.caseId],
      foreignColumns: [onboardingEntryCases.tenantId, onboardingEntryCases.id],
    }),
    foreignKey({
      name: 'onboarding_material_item_definition_fk',
      columns: [t.tenantId, t.ruleId, t.definitionId],
      foreignColumns: [
        onboardingMaterialRuleItems.tenantId,
        onboardingMaterialRuleItems.ruleId,
        onboardingMaterialRuleItems.id,
      ],
    }),
    index('onboarding_material_item_definition').on(t.tenantId, t.ruleId, t.definitionId),
    check(
      'onboarding_material_item_versions',
      sql`${t.revision} > 0 AND ${t.ruleRevision} > 0 AND ${t.definitionRevision} > 0 AND ${t.position} >= 0`,
    ),
    check(
      'onboarding_material_item_status',
      sql`(${t.status} = 'pending' AND ${t.submittedAt} IS NULL AND ${t.receivedAt} IS NULL)
        OR (${t.status} = 'submitted' AND ${t.submittedAt} IS NOT NULL AND ${t.receivedAt} IS NULL)
        OR (${t.status} = 'received' AND ${t.submittedAt} IS NOT NULL
          AND ${t.receivedAt} IS NOT NULL AND ${t.receivedAt} >= ${t.submittedAt})`,
    ),
  ],
);
