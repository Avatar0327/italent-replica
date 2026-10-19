/**
 * R2 BE-5c1a 预计退休日期规则与个人身份字典（docs/08_设计/R2-T04_退休设计.md §2.4，DEC-640）。
 * 规则表照自动转正规则形态（优先级 + 登记顺序号、整份保存、硬删除）；首版 purpose 只有 expected_date、
 * rule_type 只有 fixed_age（弹性范围规则 5c1b、高级公式 R3-T00 再放开）。
 * 条件按固定槽位存：每槽至多一条、操作符只有 in（DEC-640②）。个人身份字典只读，预置工人 10 / 干部 20。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = (name = 'created_at') => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const retirementRules = pgTable(
  'retirement_rules',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    purpose: text('purpose').notNull(),
    ruleType: text('rule_type').notNull(),
    name: text('name').notNull(),
    priority: integer('priority').notNull(),
    sequenceNo: integer('sequence_no').notNull(),
    orgIds: uuid('org_ids').array().notNull(),
    includeSubordinates: boolean('include_subordinates').notNull().default(true),
    retirementAgeYears: integer('retirement_age_years'),
    retirementAgeMonths: integer('retirement_age_months'),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('retirement_rules_tenant_id').on(t.tenantId, t.id),
    unique('retirement_rules_sequence').on(t.tenantId, t.purpose, t.sequenceNo),
    check('retirement_rules_purpose', sql`${t.purpose} IN ('expected_date')`),
    check('retirement_rules_rule_type', sql`${t.ruleType} IN ('fixed_age')`),
    check('retirement_rules_name', sql`btrim(${t.name}) <> '' AND char_length(${t.name}) <= 100`),
    check('retirement_rules_priority', sql`${t.priority} BETWEEN 0 AND 9999`),
    check('retirement_rules_sequence_positive', sql`${t.sequenceNo} > 0`),
    check('retirement_rules_orgs', sql`cardinality(${t.orgIds}) BETWEEN 1 AND 50`),
    check(
      'retirement_rules_age',
      sql`${t.purpose} <> 'expected_date' OR (${t.retirementAgeYears} BETWEEN 30 AND 80
        AND ${t.retirementAgeMonths} BETWEEN 0 AND 11)`,
    ),
    check('retirement_rules_revision_positive', sql`${t.revision} > 0`),
  ],
);

export const retirementRuleConditions = pgTable(
  'retirement_rule_conditions',
  {
    tenantId: tenant(),
    ruleId: uuid('rule_id').notNull(),
    seq: integer('seq').notNull(),
    fieldCode: text('field_code').notNull(),
    operator: text('operator').notNull(),
    values: text('values').array().notNull(),
  },
  (t) => [
    primaryKey({ name: 'retirement_rule_conditions_pk', columns: [t.tenantId, t.ruleId, t.seq] }),
    unique('retirement_rule_conditions_slot').on(t.tenantId, t.ruleId, t.fieldCode),
    foreignKey({
      name: 'retirement_rule_conditions_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [retirementRules.tenantId, retirementRules.id],
    }).onDelete('cascade'),
    check('retirement_rule_conditions_seq', sql`${t.seq} BETWEEN 1 AND 4`),
    check(
      'retirement_rule_conditions_field',
      sql`${t.fieldCode} IN ('gender', 'nationality', 'employType', 'identityType')`,
    ),
    check('retirement_rule_conditions_operator', sql`${t.operator} = 'in'`),
    check('retirement_rule_conditions_values', sql`cardinality(${t.values}) BETWEEN 1 AND 50`),
  ],
);

/** 个人身份字典（DEC-640③）：标准项只读；人事 identityType 与规则条件只能取启用编码。 */
export const retirementIdentityTypes = pgTable(
  'retirement_identity_types',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: tenant(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('retirement_identity_types_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('retirement_identity_types_code').on(t.tenantId, sql`lower(${t.code})`),
    check('retirement_identity_types_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('retirement_identity_types_name_nonempty', sql`btrim(${t.name}) <> ''`),
    check('retirement_identity_types_revision_positive', sql`${t.revision} > 0`),
    check('retirement_identity_types_display_order', sql`${t.displayOrder} >= 0`),
  ],
);
