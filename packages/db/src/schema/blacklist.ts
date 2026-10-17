/**
 * R2 BE-8a 黑名单（B68）与离职自动加黑规则（差距表“补证结论 R2f”、DEC-569）。
 * 黑名单行快照加黑时的姓名 / 证件号 / 手机 / 邮箱（选人员加黑时取人员档案，否则手填）；移出只改状态、保留记录，
 * 删除整行删除（审计留快照）。同一人员、同一证件号同时只能有一条在名单的记录。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { tenants } from './tenancy.js';

const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const utc = (name = 'created_at') => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const day = (name: string) => date(name, { mode: 'string' });

export const employmentBlacklist = pgTable(
  'employment_blacklist',
  {
    id: id(),
    tenantId: tenant(),
    /** 选人员加黑时的人员；手填（含后续导入）时为空。 */
    employeeId: uuid('employee_id'),
    name: text('name').notNull(),
    idNumber: text('id_number'),
    mobilePhone: text('mobile_phone'),
    email: text('email'),
    reason: text('reason').notNull(),
    blacklistDate: day('blacklist_date').notNull(),
    /** 有效截止日期，空 = 永久。 */
    expiryDate: day('expiry_date'),
    note: text('note'),
    source: text('source').notNull(),
    status: text('status').notNull().default('active'),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: uuid('removed_by'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('employment_blacklist_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'employment_blacklist_employee_fk',
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    uniqueIndex('employment_blacklist_active_employee')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.status} = 'active' AND ${t.employeeId} IS NOT NULL`),
    uniqueIndex('employment_blacklist_active_id_number')
      .on(t.tenantId, sql`lower(btrim(${t.idNumber}))`)
      .where(sql`${t.status} = 'active' AND btrim(${t.idNumber}) <> ''`),
    index('employment_blacklist_list').on(t.tenantId, t.status, t.blacklistDate),
    check('employment_blacklist_name', sql`btrim(${t.name}) <> ''`),
    check(
      'employment_blacklist_reason',
      sql`${t.reason} IN ('major_violation', 'integrity', 'instability', 'resignation', 'other')`,
    ),
    check('employment_blacklist_source', sql`${t.source} IN ('manual', 'auto_rule', 'import')`),
    check(
      'employment_blacklist_status',
      sql`(${t.status} = 'active' AND ${t.removedAt} IS NULL)
        OR (${t.status} = 'removed' AND ${t.removedAt} IS NOT NULL)`,
    ),
    check('employment_blacklist_expiry', sql`${t.expiryDate} IS NULL OR ${t.expiryDate} >= ${t.blacklistDate}`),
    check(
      'employment_blacklist_contact',
      sql`${t.employeeId} IS NOT NULL OR ${t.idNumber} IS NOT NULL OR ${t.mobilePhone} IS NOT NULL
        OR ${t.email} IS NOT NULL`,
    ),
    // 联系标识没有空白值：缺失一律存 NULL（与服务端 identityKey 同一口径，#387 第 1 轮 P2-1）
    check(
      'employment_blacklist_identity',
      sql`(${t.idNumber} IS NULL OR btrim(${t.idNumber}) <> '')
        AND (${t.mobilePhone} IS NULL OR btrim(${t.mobilePhone}) <> '')
        AND (${t.email} IS NULL OR btrim(${t.email}) <> '')`,
    ),
    check('employment_blacklist_note', sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
    check('employment_blacklist_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** 离职自动加黑规则：规则信息 + 加黑信息；加黑条件在子表（只实现“离职次数 大于等于 N”）。 */
export const employmentBlacklistRules = pgTable(
  'employment_blacklist_rules',
  {
    id: id(),
    tenantId: tenant(),
    name: text('name').notNull(),
    priority: integer('priority').notNull(),
    /** 登记顺序：新增时在租户规则锁内分配、之后不变；同优先级按它取先登记者（#387 第 1 轮 P2-2）。 */
    sequenceNo: integer('sequence_no').notNull(),
    orgIds: uuid('org_ids').array().notNull(),
    description: text('description'),
    term: text('term').notNull(),
    reason: text('reason').notNull(),
    note: text('note'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('employment_blacklist_rules_tenant_id').on(t.tenantId, t.id),
    unique('employment_blacklist_rules_sequence').on(t.tenantId, t.sequenceNo),
    check('employment_blacklist_rules_sequence_positive', sql`${t.sequenceNo} > 0`),
    check('employment_blacklist_rules_name', sql`btrim(${t.name}) <> ''`),
    check('employment_blacklist_rules_priority', sql`${t.priority} BETWEEN 0 AND 9999`),
    check('employment_blacklist_rules_orgs', sql`cardinality(${t.orgIds}) BETWEEN 1 AND 50`),
    check('employment_blacklist_rules_term', sql`${t.term} IN ('permanent', 'exit_month')`),
    check(
      'employment_blacklist_rules_reason',
      sql`${t.reason} IN ('major_violation', 'integrity', 'instability', 'resignation', 'other')`,
    ),
    check(
      'employment_blacklist_rules_text',
      sql`coalesce(char_length(${t.description}), 0) <= 500 AND coalesce(char_length(${t.note}), 0) <= 500`,
    ),
    check('employment_blacklist_rules_revision_positive', sql`${t.revision} > 0`),
  ],
);

export const employmentBlacklistRuleConditions = pgTable(
  'employment_blacklist_rule_conditions',
  {
    tenantId: tenant(),
    ruleId: uuid('rule_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    field: text('field').notNull(),
    operator: text('operator').notNull(),
    value: integer('value').notNull(),
  },
  (t) => [
    primaryKey({ name: 'employment_blacklist_rule_conditions_pk', columns: [t.tenantId, t.ruleId, t.ordinal] }),
    foreignKey({
      name: 'employment_blacklist_rule_conditions_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [employmentBlacklistRules.tenantId, employmentBlacklistRules.id],
    }).onDelete('cascade'),
    check('employment_blacklist_rule_conditions_field', sql`${t.field} = 'exitCount'`),
    check('employment_blacklist_rule_conditions_operator', sql`${t.operator} = 'gte'`),
    check('employment_blacklist_rule_conditions_value', sql`${t.value} BETWEEN 1 AND 999`),
  ],
);
