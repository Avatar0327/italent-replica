/**
 * R2-T04 退休：薄扩展行（docs/08_设计/R2-T04_退休设计.md §2.2）。退休本体是任职业务 kind='retirement'，
 * 离职机制（exit_requests）整套复用；这里只放退休特有的快照与派生值，与 exit_requests 1:1。
 * 文件后半是 5c1a 的预计退休日期规则与个人身份字典。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { exitRequests } from './exit.js';
import { tenants } from './tenancy.js';

export const retirementRequests = pgTable(
  'retirement_requests',
  {
    tenantId: uuid('tenant_id').notNull(),
    businessId: uuid('business_id').notNull(),
    /** 冗余：范围谓词与审计。 */
    employeeId: uuid('employee_id').notNull(),
    /** 创建时快照的人员“预计退休日期”P（派生依据，不随后续重算变化，DEC-638 A-3）。 */
    expectedRetirementDate: date('expected_retirement_date', { mode: 'string' }),
    /** early / normal / delayed，由最后工作日 L 与快照 P 派生；不可手改，系统顺延改变 L 时按快照 P 重派生。 */
    retireType: text('retire_type'),
    /** 是否同时返聘（规格 IsReEmployed）；5a 期间恒为 false，5b 开放。 */
    reEmployed: boolean('re_employed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'retirement_requests_exit_fk',
      columns: [t.tenantId, t.businessId],
      foreignColumns: [exitRequests.tenantId, exitRequests.businessId],
    }),
    index('retirement_requests_employee').on(t.tenantId, t.employeeId),
    check(
      'retirement_requests_type',
      sql`${t.retireType} IS NULL OR ${t.retireType} IN ('early', 'normal', 'delayed')`,
    ),
    // 类型只在有 P 快照时存在
    check(
      'retirement_requests_type_needs_expected',
      sql`${t.retireType} IS NULL OR ${t.expectedRetirementDate} IS NOT NULL`,
    ),
  ],
);

/**
 * R2 BE-5c1a 预计退休日期规则与个人身份字典（docs/08_设计/R2-T04_退休设计.md §2.4，DEC-640）。
 * 规则表照自动转正规则形态（优先级 + 登记顺序号、整份保存、硬删除）；5c1b 放开 purpose = flexible_range 与
 * rule_type = builtin（选用内置法定函数，DEC-641；高级公式 R3-T00 再放开）。预置法定规则 preset_code 非空，
 * 覆盖全公司（all_orgs，org_ids 为空）；预置规则的复制件是普通规则，保留 all_orgs 直到管理员选定适用组织。
 * 条件按固定槽位存：每槽至多一条、操作符只有 in（DEC-640②）。个人身份字典只读，预置工人 10 / 干部 20。
 */
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
    /** 选用的内置函数（rule_type = builtin）：expected_date 用 expected_function，flexible_range 用 earliest / latest。 */
    expectedFunction: text('expected_function'),
    earliestFunction: text('earliest_function'),
    latestFunction: text('latest_function'),
    /** 适用全公司：org_ids 为空；只由预置规则及其复制件携带。 */
    allOrgs: boolean('all_orgs').notNull().default(false),
    /** 预置法定规则的稳定编码（DEC-361 种子补装按它判已装）；自建规则为空。 */
    presetCode: text('preset_code'),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('retirement_rules_tenant_id').on(t.tenantId, t.id),
    unique('retirement_rules_sequence').on(t.tenantId, t.purpose, t.sequenceNo),
    unique('retirement_rules_preset').on(t.tenantId, t.presetCode),
    check('retirement_rules_purpose', sql`${t.purpose} IN ('expected_date', 'flexible_range')`),
    check('retirement_rules_rule_type', sql`${t.ruleType} IN ('fixed_age', 'builtin')`),
    check(
      'retirement_rules_preset_code',
      sql`${t.presetCode} IS NULL OR ${t.presetCode} IN ('expected_date_statutory', 'flexible_range_statutory')`,
    ),
    check(
      'retirement_rules_expected_function',
      sql`${t.expectedFunction} IS NULL OR ${t.expectedFunction} = 'statutory_expected_date'`,
    ),
    check(
      'retirement_rules_earliest_function',
      sql`${t.earliestFunction} IS NULL OR ${t.earliestFunction} = 'statutory_earliest'`,
    ),
    check(
      'retirement_rules_latest_function',
      sql`${t.latestFunction} IS NULL OR ${t.latestFunction} = 'statutory_latest'`,
    ),
    // 规则形态：固定年龄只用于预计日期且不带函数；内置函数不带年龄，预计日期选预计函数、弹性范围选最早 + 最晚函数
    check(
      'retirement_rules_shape',
      sql`(${t.ruleType} = 'fixed_age' AND ${t.purpose} = 'expected_date'
          AND ${t.expectedFunction} IS NULL AND ${t.earliestFunction} IS NULL AND ${t.latestFunction} IS NULL)
        OR (${t.ruleType} = 'builtin' AND ${t.retirementAgeYears} IS NULL AND ${t.retirementAgeMonths} IS NULL
          AND ((${t.purpose} = 'expected_date' AND ${t.expectedFunction} IS NOT NULL
              AND ${t.earliestFunction} IS NULL AND ${t.latestFunction} IS NULL)
            OR (${t.purpose} = 'flexible_range' AND ${t.expectedFunction} IS NULL
              AND ${t.earliestFunction} IS NOT NULL AND ${t.latestFunction} IS NOT NULL)))`,
    ),
    check('retirement_rules_name', sql`btrim(${t.name}) <> '' AND char_length(${t.name}) <= 100`),
    check('retirement_rules_priority', sql`${t.priority} BETWEEN 0 AND 9999`),
    check('retirement_rules_sequence_positive', sql`${t.sequenceNo} > 0`),
    check(
      'retirement_rules_orgs',
      sql`(${t.allOrgs} AND cardinality(${t.orgIds}) = 0)
        OR (NOT ${t.allOrgs} AND cardinality(${t.orgIds}) BETWEEN 1 AND 50)`,
    ),
    check(
      'retirement_rules_age',
      sql`${t.ruleType} <> 'fixed_age' OR (${t.retirementAgeYears} BETWEEN 30 AND 80
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
