/**
 * 试用期与转正（R2 BE-3；docs/02_业务建模/29 §1、§2.3，15 §5）：
 * - 试用期信息版本链：键 = 开启本段试用的入职 / 实习转正业务（任职记录与业务同一 ID），入职写第 1 版，调整试用信息追加，
 *   只追加不改写（AGENTS §2 版本链）；转正日期不在这里存，取本周期生效的转正记录的生效日（PB-R13 由投影保证）；
 * - 转正的“试用结果”：每张转正业务一行，创建时写入，只追加；
 * - 试用结果字典：照离职字典形态（编码租户内唯一不分大小写、保存后不可改、可改名 / 停用 / 调顺序，不提供删除）。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects } from './employment.js';
import { tenants } from './tenancy.js';

const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = (name = 'created_at') => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const business = [
  employmentBusinessObjects.tenantId,
  employmentBusinessObjects.employeeId,
  employmentBusinessObjects.id,
] as const;

export const employmentProbationVersions = pgTable(
  'employment_probation_versions',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    hasProbation: boolean('has_probation').notNull(),
    startDate: date('start_date', { mode: 'string' }),
    months: smallint('months'),
    expectedEndDate: date('expected_end_date', { mode: 'string' }),
    source: text('source').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_probation_versions_no').on(t.tenantId, t.businessId, t.versionNo),
    foreignKey({
      name: 'employment_probation_versions_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [...business],
    }),
    check('employment_probation_versions_source', sql`${t.source} IN ('entry', 'adjust')`),
    check('employment_probation_versions_months', sql`${t.months} IS NULL OR ${t.months} BETWEEN 1 AND 6`),
    check(
      'employment_probation_versions_none',
      sql`${t.hasProbation} OR (${t.startDate} IS NULL AND ${t.months} IS NULL AND ${t.expectedEndDate} IS NULL)`,
    ),
    check(
      'employment_probation_versions_dates',
      sql`${t.expectedEndDate} IS NULL OR ${t.startDate} IS NULL OR ${t.expectedEndDate} >= ${t.startDate}`,
    ),
  ],
);

export const employmentRegularizationResults = pgTable(
  'employment_regularization_results',
  {
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    resultCode: text('result_code').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    primaryKey({ name: 'employment_regularization_results_pk', columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'employment_regularization_results_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [...business],
    }),
  ],
);

export const employmentProbationResults = pgTable(
  'employment_probation_results',
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
    unique('employment_probation_results_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('employment_probation_results_code').on(t.tenantId, sql`lower(${t.code})`),
    check('employment_probation_results_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('employment_probation_results_name_nonempty', sql`btrim(${t.name}) <> ''`),
    check('employment_probation_results_revision_positive', sql`${t.revision} > 0`),
    check('employment_probation_results_display_order', sql`${t.displayOrder} >= 0`),
  ],
);

/**
 * R2 BE-15a 自动转正规则（docs/02_业务建模/29 PB-R16 / R18，DEC-533② 单条启停、DEC-539② 规则名称）：
 * 照自动加黑规则的形态（优先级 + 登记顺序号、整份保存、硬删除）；删除规则不影响已发起的（PB-R22，台账不挂外键）。
 * operator_user_id = 最后保存的管理员，发起人类型为“当前管理员”时取它。
 */
export const employmentAutoRegularizationRules = pgTable(
  'employment_auto_regularization_rules',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    name: text('name').notNull(),
    priority: integer('priority').notNull(),
    sequenceNo: integer('sequence_no').notNull(),
    orgIds: uuid('org_ids').array().notNull(),
    includeSubordinates: boolean('include_subordinates').notNull().default(true),
    mode: text('mode').notNull(),
    daysBefore: integer('days_before').notNull(),
    initiatorType: text('initiator_type').notNull(),
    probationResult: text('probation_result').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    operatorUserId: uuid('operator_user_id').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('employment_auto_regularization_rules_tenant_id').on(t.tenantId, t.id),
    unique('employment_auto_regularization_rules_sequence').on(t.tenantId, t.sequenceNo),
    check('employment_auto_regularization_rules_name', sql`btrim(${t.name}) <> '' AND char_length(${t.name}) <= 100`),
    check('employment_auto_regularization_rules_priority', sql`${t.priority} BETWEEN 0 AND 9999`),
    check('employment_auto_regularization_rules_sequence_positive', sql`${t.sequenceNo} > 0`),
    check('employment_auto_regularization_rules_orgs', sql`cardinality(${t.orgIds}) BETWEEN 1 AND 50`),
    check('employment_auto_regularization_rules_mode', sql`${t.mode} IN ('direct', 'application')`),
    check('employment_auto_regularization_rules_days', sql`${t.daysBefore} BETWEEN 0 AND 999`),
    check(
      'employment_auto_regularization_rules_initiator',
      sql`${t.initiatorType} IN ('rule_operator', 'department_hrbp', 'department_head')`,
    ),
    check('employment_auto_regularization_rules_revision_positive', sql`${t.revision} > 0`),
  ],
);

/**
 * 自动转正发起台账：键 = 规则 × 本任职周期的开启记录（同一任职同一规则只发起一次，R2e7 / DEC-539①）。
 * launched 只写一次（带业务 ID、系统代发标记与发起人）；failed 可在后续执行重试（次数、原因，DEC-052）。
 */
export const employmentAutoRegularizationLaunches = pgTable(
  'employment_auto_regularization_launches',
  {
    tenantId: tenant(),
    ruleId: uuid('rule_id').notNull(),
    anchorId: uuid('anchor_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    state: text('state').notNull(),
    businessId: uuid('business_id'),
    initiatorUserId: uuid('initiator_user_id'),
    systemProxy: boolean('system_proxy').notNull().default(true),
    attempts: integer('attempts').notNull().default(1),
    lastReason: text('last_reason'),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    primaryKey({ name: 'employment_auto_regularization_launches_pk', columns: [t.tenantId, t.ruleId, t.anchorId] }),
    foreignKey({
      name: 'employment_auto_regularization_launches_anchor_fk',
      columns: [t.tenantId, t.employeeId, t.anchorId],
      foreignColumns: [...business],
    }),
    foreignKey({
      name: 'employment_auto_regularization_launches_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [...business],
    }),
    check('employment_auto_regularization_launches_state', sql`${t.state} IN ('launched', 'failed')`),
    check(
      'employment_auto_regularization_launches_outcome',
      sql`(${t.state} = 'launched') = (${t.businessId} IS NOT NULL)`,
    ),
    check('employment_auto_regularization_launches_attempts', sql`${t.attempts} > 0`),
  ],
);

/** 每日批次登记（DEC-539①）：每租户每个业务日只跑一次定时批次；“立即执行”不占用。 */
export const employmentAutoRegularizationDailyRuns = pgTable(
  'employment_auto_regularization_daily_runs',
  {
    tenantId: tenant(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [primaryKey({ name: 'employment_auto_regularization_daily_runs_pk', columns: [t.tenantId, t.businessDate] })],
);
