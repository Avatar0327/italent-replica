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
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects } from './employment.js';
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
    /** 是否同时返聘（规格 IsReEmployed）；与 rehire_plan 同有同无（CHECK）。 */
    reEmployed: boolean('re_employed').notNull().default(false),
    /**
     * 同时返聘的返聘任职 / 合同 / 试用期计划（设计 §8.2）：固定 schema 的待执行命令载荷，结构与
     * POST employees/:id/businesses kind=retire_rehire 的请求体一致；落地后的规范对象是 retire_rehire 任职业务与合同。
     * 返聘日不存这里，生效时由最终生效日 E′ 经 retireRehireStartDate 算出（A-15 顺延时跟着变）。
     */
    rehirePlan: jsonb('rehire_plan'),
    /** 生效时生成的 retire_rehire 业务（规格 LURetireReEmployedRecord）；撤销退休的返聘守卫读它。 */
    rehireBusinessId: uuid('rehire_business_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'retirement_requests_exit_fk',
      columns: [t.tenantId, t.businessId],
      foreignColumns: [exitRequests.tenantId, exitRequests.businessId],
    }),
    foreignKey({
      name: 'retirement_requests_rehire_fk',
      columns: [t.tenantId, t.rehireBusinessId],
      foreignColumns: [employmentBusinessObjects.tenantId, employmentBusinessObjects.id],
    }),
    index('retirement_requests_employee').on(t.tenantId, t.employeeId),
    check('retirement_requests_rehire_plan', sql`${t.reEmployed} = (${t.rehirePlan} IS NOT NULL)`),
    check('retirement_requests_rehire_business', sql`${t.rehireBusinessId} IS NULL OR ${t.reEmployed}`),
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
    check('retirement_rule_conditions_seq', sql`${t.seq} BETWEEN 1 AND 5`),
    check(
      'retirement_rule_conditions_field',
      sql`${t.fieldCode} IN ('gender', 'nationality', 'employType', 'identityType', 'employmentForm')`,
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

/**
 * R2 BE-5c2 预计退休日期 / 弹性范围的每日批次（R2-T04 §2.4 / §9.2）：每租户 × 用途 × 业务日一行，是“推进进度”而不是一次性占位。
 * 认领 = INSERT 新建 running（lease_until 10 分钟）；租约过期的 running 行由 CAS 接管（attempts + 1）；done 行跳过。
 * position_employee_id 是主扫描已完成到的员工 ID（升序），与锁忙跳过清单在同一短事务推进，崩溃后从该位置续跑。
 */
export const retirementRuleDailyRuns = pgTable(
  'retirement_rule_daily_runs',
  {
    tenantId: tenant(),
    purpose: text('purpose').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    state: text('state').notNull().default('running'),
    positionEmployeeId: uuid('position_employee_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(1),
    skippedCount: integer('skipped_count').notNull().default(0),
    commandId: text('command_id').notNull(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    primaryKey({ name: 'retirement_rule_daily_runs_pk', columns: [t.tenantId, t.purpose, t.businessDate] }),
    check('retirement_rule_daily_runs_purpose', sql`${t.purpose} IN ('expected_date', 'flexible_range')`),
    check('retirement_rule_daily_runs_state', sql`${t.state} IN ('running', 'done')`),
    check('retirement_rule_daily_runs_attempts', sql`${t.attempts} > 0 AND ${t.skippedCount} >= 0`),
  ],
);

/** 锁忙待重试清单（第二遍读它）：pending 重试成功即删除，仍锁忙置 given_up（本日不再追，次日批次照常覆盖）。 */
export const retirementRuleRunSkips = pgTable(
  'retirement_rule_run_skips',
  {
    tenantId: tenant(),
    purpose: text('purpose').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    employeeId: uuid('employee_id').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: utc(),
  },
  (t) => [
    primaryKey({
      name: 'retirement_rule_run_skips_pk',
      columns: [t.tenantId, t.purpose, t.businessDate, t.employeeId],
    }),
    foreignKey({
      name: 'retirement_rule_run_skips_run_fk',
      columns: [t.tenantId, t.purpose, t.businessDate],
      foreignColumns: [
        retirementRuleDailyRuns.tenantId,
        retirementRuleDailyRuns.purpose,
        retirementRuleDailyRuns.businessDate,
      ],
    }),
    check('retirement_rule_run_skips_state', sql`${t.state} IN ('pending', 'given_up')`),
  ],
);

/**
 * “立即执行”的续跑句柄：回执只给随机句柄，内部位置（员工 ID）不出库；句柄绑定租户 × 操作人 × 用途 × 业务日。只增不改。
 * 独立于 employment_auto_regularization_run_cursors：自动转正的句柄在退休接口查不到即拒绝。
 */
export const retirementRuleRunCursors = pgTable(
  'retirement_rule_run_cursors',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    userId: uuid('user_id').notNull(),
    purpose: text('purpose').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    positionEmployeeId: uuid('position_employee_id').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('retirement_rule_run_cursors_tenant_id').on(t.tenantId, t.id),
    check('retirement_rule_run_cursors_purpose', sql`${t.purpose} IN ('expected_date', 'flexible_range')`),
  ],
);

/**
 * 意向退休日期申请（5d2，设计 §2.5 / §11）：独立申请表，单表 + revision，不做版本链（意向申请不是任职记录）。
 * 快照列（预计退休日期与弹性上下限）在创建 / 提交时冻结，只读；department_id 是申请时主职部门快照，写范围的组织坐标取它。
 * 同员工至多一张未办结（draft / in_review / rejected），部分唯一索引兜住并发。审批通过只置 approved，不写人事字段（A-6）。
 */
export const retirementIntentions = pgTable(
  'retirement_intentions',
  {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    departmentId: uuid('department_id'),
    intendedDate: date('intended_date', { mode: 'string' }).notNull(),
    expectedDateSnapshot: date('expected_date_snapshot', { mode: 'string' }),
    earliestSnapshot: date('earliest_snapshot', { mode: 'string' }),
    latestSnapshot: date('latest_snapshot', { mode: 'string' }),
    reason: text('reason'),
    initiator: text('initiator').notNull(),
    initiatorUserId: uuid('initiator_user_id').notNull(),
    state: text('state').notNull(),
    approvalInstanceId: uuid('approval_instance_id'),
    revision: integer('revision').notNull().default(1),
    commandId: text('command_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('retirement_intentions_employee').on(t.tenantId, t.employeeId),
    uniqueIndex('retirement_intentions_open')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.state} IN ('draft', 'in_review', 'rejected')`),
    check('retirement_intentions_initiator', sql`${t.initiator} IN ('hr', 'self')`),
    check(
      'retirement_intentions_state',
      sql`${t.state} IN ('draft', 'in_review', 'rejected', 'approved', 'disapproved', 'withdrawn')`,
    ),
    check('retirement_intentions_reason', sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 500`),
  ],
);
