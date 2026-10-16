/**
 * 入职生成邮箱规则（R2 BE-2b；34 EN-R12）：整份替换的版本化配置。
 * 头表记当前版本号（并发控制用 If-Match），规则行按版本号只追加（旧版本留存，不原地改）；当前规则 = 头表版本号对应的行。
 * 组织范围 org_ids 存部门 ID 列表，写入时校验存在，匹配时展开到下级。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

export const employmentEmailRuleSets = pgTable('employment_email_rule_sets', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  revision: integer('revision').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const employmentEmailRules = pgTable(
  'employment_email_rules',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    setRevision: integer('set_revision').notNull(),
    /** 规则标识：跨版本保持（客户端可回传），生成日志用它指回规则。 */
    ruleId: uuid('rule_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    priority: integer('priority').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    orgIds: uuid('org_ids').array().notNull(),
    employTypes: text('employ_types')
      .array()
      .notNull()
      .default(sql`'{}'`),
    prefixField: text('prefix_field').notNull(),
    domain: text('domain').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'employment_email_rules_pk', columns: [t.tenantId, t.setRevision, t.ordinal] }),
    unique('employment_email_rules_rule').on(t.tenantId, t.setRevision, t.ruleId),
    index('employment_email_rules_set').on(t.tenantId, t.setRevision),
    check('employment_email_rules_priority', sql`${t.priority} >= 0`),
    check(
      'employment_email_rules_prefix_field',
      sql`${t.prefixField} IN ('employeeCode', 'namePinyin', 'pinyinInitials')`,
    ),
    check('employment_email_rules_orgs', sql`cardinality(${t.orgIds}) BETWEEN 1 AND 50`),
    check('employment_email_rules_name', sql`btrim(${t.name}) <> ''`),
  ],
);
