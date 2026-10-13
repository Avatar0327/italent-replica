/**
 * R3-T05 继任管理的表结构（设计 §1；schema/index.ts 已导出）。表随子 PR 在本文件追加，迁移按开工时最新 main
 * 用 pnpm db:generate 连续生成（DEC-221）。A1 建继任记录与目标锁；区间排他、RLS、授权、SQL 函数与触发器在配套的
 * --custom 迁移里（drizzle 表达不了 EXCLUDE）。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';
import { employmentEmployees, employmentRecords } from './employment.js';
import { jobPositionObjects } from './job.js';
import { orgObjects } from './org.js';
import { talentReadinessLevels } from './talent-review.js';
import { tenantMemberships, tenants } from './tenancy.js';

export const SUCCESSION_TYPES = ['org', 'position'] as const;
export type SuccessionType = (typeof SUCCESSION_TYPES)[number];
export const SUCCESSION_BACKUP_TYPES = ['principal', 'deputy'] as const;
export const SUCCESSION_END_SOURCES = ['manual', 'exit', 'sync_overwrite', 'sync_scope_overwrite'] as const;
export const SUCCESSION_SOURCE_KINDS = ['manual', 'review_sync'] as const;
/** 结束日的“长期有效”哨兵值（§1.1：end_date 非空，默认 9999-12-31；生效状态派生）。 */
export const SUCCESSION_OPEN_END = '9999-12-31';

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));

/** DEC-443：个人筛选仅用于职位地图，管理员显示开关不存于个人表。 */
export const SUCCESSION_POSITION_PREFERENCES_DEFAULTS = Object.freeze({
  showKeyPositions: false,
  showPositionsWithoutSuccessor: true,
});

/** C1 / DEC-443：root / depth / hidden 是位置筛选；两个布尔筛选按个人保存。 */
export const successionMapPreferences = pgTable(
  'succession_map_preferences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    mapKind: text('map_kind').$type<'position'>().notNull(),
    rootOrgId: uuid('root_org_id'),
    depth: integer('depth').notNull(),
    hiddenOrgIds: jsonb('hidden_org_ids').$type<string[]>().notNull().default([]),
    showKeyPositions: boolean('show_key_positions')
      .notNull()
      .default(SUCCESSION_POSITION_PREFERENCES_DEFAULTS.showKeyPositions),
    showPositionsWithoutSuccessor: boolean('show_positions_without_successor')
      .notNull()
      .default(SUCCESSION_POSITION_PREFERENCES_DEFAULTS.showPositionsWithoutSuccessor),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId, t.mapKind] }),
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({ columns: [t.tenantId, t.rootOrgId], foreignColumns: [orgObjects.tenantId, orgObjects.id] }),
    check('succession_preferences_kind', sql`${t.mapKind} = 'position'`),
    check('succession_preferences_depth', sql`${t.depth} BETWEEN 2 AND 4`),
    check(
      'succession_preferences_hidden',
      sql`jsonb_typeof(${t.hiddenOrgIds})='array'
    AND jsonb_array_length(${t.hiddenOrgIds})<=200`,
    ),
    check('succession_preferences_revision', sql`${t.revision}>0`),
  ],
);

/** §4.5：同一组织各业务日独立缓存，run 与来源项目只存引用。 */
export const successionOrgStats = pgTable(
  'succession_org_stats',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orgId: uuid('org_id').notNull(),
    statDate: date('stat_date', { mode: 'string' }).notNull(),
    onDutyCount: integer('on_duty_count').notNull(),
    greenRate: numeric('green_rate'),
    greenSourceProjectId: uuid('green_source_project_id'),
    slotKey: text('slot_key').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    runId: uuid('run_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.orgId, t.statDate] }),
    foreignKey({ columns: [t.tenantId, t.orgId], foreignColumns: [orgObjects.tenantId, orgObjects.id] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [successionCalcRuns.tenantId, successionCalcRuns.id],
    }),
    check('succession_stats_count', sql`${t.onDutyCount}>=0`),
  ],
);

/**
 * 继任记录（原站 `Map`，§1.1）。区间 [start_date, end_date) 半开；同目标同继任者任何两条未删除记录区间不得重叠
 * （排他约束 succession_records_no_overlap，在配套 SQL 迁移里）。软删除（deleted_at）后不参与任何列表 / 统计 / 查重，
 * 且同事务释放准备度引用（触发器）。source_batch_id 的批次复合外键由 D1 补齐；source_item_id 保留来源快照 ID。
 */
export const successionRecords = pgTable(
  'succession_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    successionType: text('succession_type').$type<SuccessionType>().notNull(),
    targetOrgId: uuid('target_org_id'),
    targetPositionId: uuid('target_position_id'),
    successorEmployeeId: uuid('successor_employee_id').notNull(),
    readinessId: uuid('readiness_id'),
    backupType: text('backup_type').notNull().default('principal'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull().default(SUCCESSION_OPEN_END),
    endReason: text('end_reason'),
    endSource: text('end_source'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: uuid('ended_by'),
    exitRecordId: uuid('exit_record_id'),
    sourceKind: text('source_kind').notNull().default('manual'),
    sourceBatchId: uuid('source_batch_id'),
    sourceItemId: uuid('source_item_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'succession_records_successor_fk',
      columns: [t.tenantId, t.successorEmployeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'succession_records_target_org_fk',
      columns: [t.tenantId, t.targetOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    foreignKey({
      name: 'succession_records_target_position_fk',
      columns: [t.tenantId, t.targetPositionId],
      foreignColumns: [jobPositionObjects.tenantId, jobPositionObjects.id],
    }),
    foreignKey({
      name: 'succession_records_readiness_fk',
      columns: [t.tenantId, t.readinessId],
      foreignColumns: [talentReadinessLevels.tenantId, talentReadinessLevels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'succession_records_source_batch_fk',
      columns: [t.tenantId, t.sourceBatchId],
      foreignColumns: [successionSyncBatches.tenantId, successionSyncBatches.id],
    }).onDelete('restrict'),
    index('succession_records_org_target').on(t.tenantId, t.successionType, t.targetOrgId, t.endDate),
    index('succession_records_position_target').on(t.tenantId, t.successionType, t.targetPositionId, t.endDate),
    index('succession_records_successor').on(t.tenantId, t.successorEmployeeId, t.endDate),
    index('succession_records_exit').on(t.tenantId, t.exitRecordId),
    check('succession_records_type', sql`${t.successionType} IN (${list(SUCCESSION_TYPES)})`),
    check(
      'succession_records_target',
      sql`(${t.successionType} = 'org' AND ${t.targetOrgId} IS NOT NULL AND ${t.targetPositionId} IS NULL)
        OR (${t.successionType} = 'position' AND ${t.targetPositionId} IS NOT NULL AND ${t.targetOrgId} IS NULL)`,
    ),
    check('succession_records_period', sql`${t.startDate} <= ${t.endDate}`),
    check('succession_records_backup_type', sql`${t.backupType} IN (${list(SUCCESSION_BACKUP_TYPES)})`),
    check(
      'succession_records_end_source',
      sql`${t.endSource} IS NULL OR ${t.endSource} IN (${list(SUCCESSION_END_SOURCES)})`,
    ),
    check('succession_records_source_kind', sql`${t.sourceKind} IN (${list(SUCCESSION_SOURCE_KINDS)})`),
    check('succession_records_revision', sql`${t.revision} > 0`),
  ],
);

/**
 * 目标级序列化锁行（§1.1、§7）：新增 / 结束 / 删除 / 同步计划 / 离职钩子都先取目标锁，再取记录行。
 * 首次 `INSERT … ON CONFLICT DO NOTHING` 再 `FOR UPDATE`（同 org/locks.ts 的组织设置锁行做法）。
 */
export const successionTargetLocks = pgTable(
  'succession_target_locks',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    targetKind: text('target_kind').$type<SuccessionType | 'org_health'>().notNull(),
    targetId: uuid('target_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.targetKind, t.targetId] }),
    check('succession_target_locks_kind', sql`${t.targetKind} IN ('org','position','org_health')`),
  ],
);

/** A3 / §5.4：事件时冻结候选，逐类型消费；不扫描补处理事件之后新增的继任记录。 */
export const successionExitApplications = pgTable(
  'succession_exit_applications',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    employmentRecordId: uuid('employment_record_id').notNull(),
    leaveDate: date('leave_date', { mode: 'string' }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
    source: text('source').$type<'record_write' | 'sweep' | 'delete_revert'>().notNull(),
    /** 只含本事件尚未判定的候选 ID；已结束 / 已删除也消费，不能因以后手工恢复而重放本次离职。 */
    candidateRecordIds: jsonb('candidate_record_ids').$type<string[]>().notNull().default([]),
    endedRecordIds: jsonb('ended_record_ids').$type<string[]>().notNull().default([]),
    commandId: text('command_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.employmentRecordId] }),
    foreignKey({
      name: 'succession_exit_employee_fk',
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'succession_exit_record_fk',
      columns: [t.tenantId, t.employmentRecordId],
      foreignColumns: [employmentRecords.tenantId, employmentRecords.id],
    }),
    index('succession_exit_employee').on(t.tenantId, t.employeeId),
    check('succession_exit_source', sql`${t.source} IN ('record_write','sweep','delete_revert')`),
    check(
      'succession_exit_arrays',
      sql`jsonb_typeof(${t.candidateRecordIds})='array'
      AND jsonb_typeof(${t.endedRecordIds})='array'`,
    ),
  ],
);

/** B2a，设计 §1.4：条件行是原始数据，公式和编译错误仅为缓存。 */
export const successionPopulations = pgTable(
  'succession_populations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    conditionExpression: text('condition_expression').notNull(),
    compiledFormula: text('compiled_formula'),
    compilerVersion: text('compiler_version'),
    compileError: jsonb('compile_error'),
    displayOrder: integer('display_order').notNull(),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique().on(t.tenantId, t.code),
    check('succession_populations_revision', sql`${t.revision} > 0`),
  ],
);

export const successionPopulationRows = pgTable(
  'succession_population_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    populationId: uuid('population_id').notNull(),
    rowNo: integer('row_no').notNull(),
    fieldCode: text('field_code').notNull(),
    filterOperator: text('filter_operator').notNull(),
    filterValues: jsonb('filter_values').notNull(),
  },
  (t) => [
    unique().on(t.tenantId, t.populationId, t.rowNo),
    foreignKey({
      columns: [t.tenantId, t.populationId],
      foreignColumns: [successionPopulations.tenantId, successionPopulations.id],
    }).onDelete('cascade'),
    check('succession_population_rows_number', sql`${t.rowNo} BETWEEN 1 AND 2147483647`),
  ],
);

/** DEC-420 / D-077：初值由读取服务提供；首次写入按 revision 0 CAS，不在 GET 中制造业务写入。 */
export const successionRuleSettings = pgTable(
  'succession_rule_settings',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    defaultColor: text('default_color').notNull(),
    levelsRevision: integer('levels_revision').notNull().default(0),
    revision: integer('revision').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.kind] }),
    check('succession_rule_settings_kind', sql`${t.kind} IN ('position_risk', 'org_health')`),
    check('succession_rule_settings_color', sql`${t.defaultColor} ~ '^#[0-9A-Fa-f]{6}$'`),
    check('succession_rule_settings_revision', sql`${t.revision} >= 0 AND ${t.levelsRevision} >= 0`),
  ],
);

// B2b，设计 §1.3 / §1.4：两套独立关系表共用结构；排序唯一约束在 SQL 迁移中设为延迟检查。
function levelTable<N extends 'succession_risk_levels' | 'succession_health_levels'>(name: N) {
  return pgTable(
    name,
    {
      id: uuid('id').primaryKey().defaultRandom(),
      tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenants.id),
      code: text('code').notNull(),
      name: text('name').notNull(),
      color: text('color').notNull(),
      description: text('description'),
      displayOrder: integer('display_order').notNull(),
      conditionExpression: text('condition_expression'),
      compiledFormula: text('compiled_formula'),
      compilerVersion: text('compiler_version'),
      compileError: jsonb('compile_error'),
      enabled: boolean('enabled').notNull().default(true),
      revision: integer('revision').notNull().default(1),
    },
    (t) => [
      unique(`${name}_tenant_id`).on(t.tenantId, t.id),
      unique(`${name}_code`).on(t.tenantId, t.code),
      unique(`${name}_name`).on(t.tenantId, t.name),
      unique(`${name}_order`).on(t.tenantId, t.displayOrder),
      check(`${name}_color`, sql`${t.color} ~ '^#[0-9A-Fa-f]{6}$'`),
      check(`${name}_revision`, sql`${t.revision} > 0 AND ${t.displayOrder} > 0`),
    ],
  );
}
export const successionRiskLevels = levelTable('succession_risk_levels');
export const successionHealthLevels = levelTable('succession_health_levels');

/** B5 / §1.4：当前结果带 CAS；盘点来源列先建，批次外键交 D1 / D4。 */
export const successionHealthResults = pgTable(
  'succession_health_results',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orgId: uuid('org_id').notNull(),
    levelId: uuid('level_id'),
    method: text('method').$type<'computed' | 'manual' | 'synced'>().notNull(),
    runId: uuid('run_id'),
    sourceBatchId: uuid('source_batch_id'),
    sourceProjectId: uuid('source_project_id'),
    sourceMeetingId: uuid('source_meeting_id'),
    computedAt: timestamp('computed_at', { withTimezone: true }),
    assignedBy: uuid('assigned_by'),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.orgId] }),
    foreignKey({ columns: [t.tenantId, t.orgId], foreignColumns: [orgObjects.tenantId, orgObjects.id] }),
    foreignKey({
      columns: [t.tenantId, t.levelId],
      foreignColumns: [successionHealthLevels.tenantId, successionHealthLevels.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [successionCalcRuns.tenantId, successionCalcRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.assignedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    check('succession_health_method', sql`${t.method} IN ('computed','manual','synced')`),
    check('succession_health_revision', sql`${t.revision}>0`),
  ],
);
const levelRowColumns = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  levelId: uuid('level_id').notNull(),
  rowNo: integer('row_no').notNull(),
  fieldCode: text('field_code'),
  filterOperator: text('filter_operator'),
  filterValues: jsonb('filter_values').notNull().default([]),
  measure: text('measure').notNull(),
  comparator: text('comparator').notNull(),
  threshold: doublePrecision('threshold'),
  thresholdHigh: doublePrecision('threshold_high'),
  isPercent: boolean('is_percent').notNull().default(false),
});
export const successionRiskLevelRows = pgTable(
  'succession_risk_level_rows',
  {
    ...levelRowColumns(),
    subject: text('subject').notNull(),
  },
  (t) => [
    unique().on(t.tenantId, t.levelId, t.rowNo),
    foreignKey({
      columns: [t.tenantId, t.levelId],
      foreignColumns: [successionRiskLevels.tenantId, successionRiskLevels.id],
    }).onDelete('cascade'),
    check('succession_risk_rows_number', sql`${t.rowNo} > 0`),
    check('succession_risk_rows_subject', sql`${t.subject} IN ('incumbent', 'successor')`),
    check(
      'succession_risk_rows_measure',
      sql`${t.measure} IN ('count', 'count_over_incumbents', 'count_over_successors')`,
    ),
  ],
);
export const successionHealthLevelRows = pgTable(
  'succession_health_level_rows',
  {
    ...levelRowColumns(),
    population: text('population').notNull(),
    populationId: uuid('population_id'),
    fieldSource: text('field_source').notNull(),
  },
  (t) => [
    unique().on(t.tenantId, t.levelId, t.rowNo),
    foreignKey({
      columns: [t.tenantId, t.levelId],
      foreignColumns: [successionHealthLevels.tenantId, successionHealthLevels.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.populationId],
      foreignColumns: [successionPopulations.tenantId, successionPopulations.id],
    }).onDelete('restrict'),
    check('succession_health_rows_number', sql`${t.rowNo} > 0`),
    check(
      'succession_health_rows_population',
      sql`${t.population} IN ('all', 'successors', 'incumbents', 'custom')
    AND ((${t.population} = 'custom') = (${t.populationId} IS NOT NULL))`,
    ),
    check('succession_health_rows_source', sql`${t.fieldSource} IN ('review', 'org', 'succession')`),
  ],
);

// B3a / DEC-427：对象集合独立冻结；NULL outcome = 尚未执行，重试只重置可恢复行。
export const CALC_KINDS = ['position_risk', 'org_health', 'org_health_reset', 'org_stats', 'exit_sweep'] as const;
export const CALC_STATUSES = ['pending', 'running', 'succeeded', 'partial', 'blocked', 'aborted'] as const;
export const CALC_OUTCOMES = ['written', 'unchanged', 'manual_kept', 'failed', 'revision_conflict'] as const;
export const successionCalcRuns = pgTable(
  'succession_calc_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').$type<(typeof CALC_KINDS)[number]>().notNull(),
    trigger: text('trigger').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    scope: jsonb('scope').$type<{ rootOrgId?: string; sourceBatchId?: string }>().notNull().default({}),
    principalUserId: uuid('principal_user_id'),
    ownerUserId: uuid('owner_user_id'),
    requestedBy: uuid('requested_by'),
    commandId: text('command_id').notNull(),
    businessDate: date('business_date').notNull(),
    phase: integer('phase').notNull().default(0),
    status: text('status').$type<(typeof CALC_STATUSES)[number]>().notNull().default('pending'),
    blockReason: text('block_reason'),
    attemptNo: integer('attempt_no').notNull().default(1),
    lastErrorCode: text('last_error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    unique('succession_calc_runs_tenant_id').on(t.tenantId, t.id),
    unique('succession_calc_runs_key').on(t.tenantId, t.idempotencyKey),
    ...[t.principalUserId, t.ownerUserId, t.requestedBy].map((column) =>
      foreignKey({
        columns: [t.tenantId, column],
        foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
      }),
    ),
    check('succession_calc_runs_kind', sql`${t.kind} IN (${list(CALC_KINDS)})`),
    check('succession_calc_runs_status', sql`${t.status} IN (${list(CALC_STATUSES)})`),
    check(
      'succession_calc_runs_trigger',
      sql`${t.trigger} IN ('schedule','manual','review_sync','preferences_change','retry')`,
    ),
    check('succession_calc_runs_counters', sql`${t.phase} >= 0 AND ${t.attemptNo} > 0 AND ${t.revision} > 0`),
    check('succession_calc_runs_owner', sql`${t.ownerUserId} IS NOT DISTINCT FROM ${t.principalUserId}`),
  ],
);
export const successionCalcRunObjects = pgTable(
  'succession_calc_run_objects',
  {
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    objectType: text('object_type').$type<'org' | 'position' | 'employee'>().notNull(),
    objectId: uuid('object_id').notNull(),
    expectedRevision: integer('expected_revision'),
    outcome: text('outcome').$type<(typeof CALC_OUTCOMES)[number]>(),
    retryable: boolean('retryable').notNull().default(false),
    pageNo: integer('page_no').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.objectType, t.objectId] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [successionCalcRuns.tenantId, successionCalcRuns.id],
    }),
    check('succession_calc_objects_type', sql`${t.objectType} IN ('org','position','employee')`),
    check('succession_calc_objects_outcome', sql`${t.outcome} IN (${list(CALC_OUTCOMES)})`),
    check('succession_calc_objects_revision', sql`${t.expectedRevision} >= 0`),
    check('succession_calc_objects_page', sql`${t.pageNo} >= 0`),
    check('succession_calc_objects_retry', sql`NOT ${t.retryable} OR ${t.outcome} = 'failed'`),
  ],
);
export const successionCalcRunFailures = pgTable(
  'succession_calc_run_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    levelId: uuid('level_id'),
    rowNo: integer('row_no'),
    code: text('code').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.runId, t.objectType, t.objectId],
      foreignColumns: [
        successionCalcRunObjects.tenantId,
        successionCalcRunObjects.runId,
        successionCalcRunObjects.objectType,
        successionCalcRunObjects.objectId,
      ],
    }),
    check('succession_calc_failures_code', sql`${t.code} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
  ],
);
// 通知行本身就是事务 outbox：消费者按 pending/failed 游标拉取；unknown 只回查，不盲重发。
export const successionNotifications = pgTable(
  'succession_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runId: uuid('run_id'),
    batchId: uuid('batch_id'),
    subjectId: uuid('subject_id')
      .generatedAlwaysAs(sql`COALESCE(run_id, batch_id)`)
      .notNull(),
    recipientUserId: uuid('recipient_user_id').notNull(),
    kind: text('kind').notNull(),
    channel: text('channel').notNull().default('in_app'),
    state: text('state').$type<'pending' | 'sent' | 'failed' | 'unknown'>().notNull().default('pending'),
    attemptNo: integer('attempt_no').notNull().default(0),
    commandId: text('command_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    unique('succession_notifications_dedupe').on(t.tenantId, t.subjectId, t.recipientUserId, t.kind),
    foreignKey({
      columns: [t.tenantId, t.recipientUserId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [successionCalcRuns.tenantId, successionCalcRuns.id],
    }),
    foreignKey({
      name: 'succession_notifications_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [successionSyncBatches.tenantId, successionSyncBatches.id],
    }).onDelete('restrict'),
    check('succession_notifications_subject', sql`num_nonnulls(${t.runId},${t.batchId}) = 1`),
    check(
      'succession_notifications_kind',
      sql`(${t.kind}='calc_done' AND ${t.runId} IS NOT NULL)
    OR (${t.kind}='sync_done' AND ${t.batchId} IS NOT NULL)`,
    ),
    check('succession_notifications_state', sql`${t.state} IN ('pending','sent','failed','unknown')`),
    check('succession_notifications_attempt', sql`${t.attemptNo} >= 0`),
    index('succession_notifications_pending').on(t.tenantId, t.state, t.createdAt, t.id),
  ],
);

/** B4 / DEC-449：清除保留结果行与 revision，原子恢复 computed。 */
export const successionRiskResults = pgTable(
  'succession_risk_results',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    positionId: uuid('position_id').notNull(),
    levelId: uuid('level_id'),
    method: text('method').$type<'computed' | 'manual'>().notNull(),
    runId: uuid('run_id'),
    computedAt: timestamp('computed_at', { withTimezone: true }),
    assignedBy: uuid('assigned_by'),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.positionId] }),
    foreignKey({
      columns: [t.tenantId, t.positionId],
      foreignColumns: [jobPositionObjects.tenantId, jobPositionObjects.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.levelId],
      foreignColumns: [successionRiskLevels.tenantId, successionRiskLevels.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [successionCalcRuns.tenantId, successionCalcRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.assignedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    check('succession_risk_results_method', sql`${t.method} IN ('manual','computed')`),
    check('succession_risk_results_revision', sql`${t.revision} > 0`),
  ],
);

/** D1 / §1.2：来源快照引用保留原 ID；T04 冻结表的真实接线随协议 PR-D 落地。 */
export const successionSyncBatches = pgTable(
  'succession_sync_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sourceRunId: uuid('source_run_id').notNull(),
    projectId: uuid('project_id').notNull(),
    meetingId: uuid('meeting_id'),
    trigger: text('trigger').notNull(),
    manualOverride: boolean('manual_override').notNull().default(false),
    actorUserId: uuid('actor_user_id').notNull(),
    actorScopeCheckedAt: timestamp('actor_scope_checked_at', { withTimezone: true }),
    sourcePrincipalUserId: uuid('source_principal_user_id').notNull(),
    writePrincipalUserId: uuid('write_principal_user_id'),
    ownerUserId: uuid('owner_user_id').notNull(),
    strategy: text('strategy').$type<'append' | 'overwrite' | 'overwrite_in_scope'>(),
    scopeOrgIds: jsonb('scope_org_ids').$type<readonly string[]>().notNull().default([]),
    scopeExplicit: boolean('scope_explicit').notNull().default(false),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    status: text('status')
      .$type<'waiting' | 'executing' | 'blocked' | 'completed' | 'terminated' | 'rejected'>()
      .notNull()
      .default('waiting'),
    hasPlan: boolean('has_plan').notNull().default(false),
    result: text('result').$type<'succeeded' | 'partial'>(),
    blockReason: text('block_reason'),
    endReason: text('end_reason'),
    executionNo: integer('execution_no'),
    leaseOwner: text('lease_owner'),
    nextPageNo: integer('next_page_no').notNull().default(1),
    autoRetryCount: integer('auto_retry_count').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    plannedAt: timestamp('planned_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    unique('succession_sync_batches_tenant_id').on(t.tenantId, t.id),
    unique('succession_sync_batches_run').on(t.tenantId, t.sourceRunId),
    check(
      'succession_sync_batches_status',
      sql`${t.status} IN ('waiting','executing','blocked','completed','terminated','rejected')`,
    ),
    check('succession_sync_batches_strategy', sql`${t.strategy} IN ('append','overwrite','overwrite_in_scope')`),
    check('succession_sync_batches_result', sql`${t.result} IN ('succeeded','partial')`),
    check(
      'succession_sync_batches_revision',
      sql`${t.revision} > 0 AND ${t.nextPageNo} > 0
      AND ${t.autoRetryCount} >= 0 AND (${t.executionNo} IS NULL OR ${t.executionNo} >= 0)`,
    ),
    index('succession_sync_batches_pending').on(t.tenantId, t.status, t.nextRetryAt),
  ],
);

/** 提名快照含永久失败的未知 ID，不能用当前字典外键阻止保存错误回执（SP-14 R2～R4）。 */
export const successionSyncItems = pgTable(
  'succession_sync_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    batchId: uuid('batch_id').notNull(),
    nominationId: uuid('nomination_id').notNull(),
    objectId: uuid('object_id').notNull(),
    subjectEmployeeId: uuid('subject_employee_id').notNull(),
    kind: text('kind').$type<SuccessionType>().notNull(),
    direction: text('direction').$type<'successor' | 'target'>().notNull(),
    targetOrgId: uuid('target_org_id'),
    targetPositionId: uuid('target_position_id'),
    successorEmployeeId: uuid('successor_employee_id').notNull(),
    readinessId: uuid('readiness_id'),
    planOutcome: text('plan_outcome').$type<'planned' | 'failed' | 'skipped'>().notNull(),
    execOutcome: text('exec_outcome').$type<'created' | 'updated' | 'exists' | 'failed' | 'aborted'>(),
    recordId: uuid('record_id'),
    errorCode: text('error_code'),
    errorParams: jsonb('error_params').$type<Readonly<Record<string, unknown>>>(),
    retryable: boolean('retryable').notNull().default(false),
    executionNo: integer('execution_no').notNull(),
    pageCommandId: text('page_command_id').notNull(),
  },
  (t) => [
    unique('succession_sync_items_tenant_id').on(t.tenantId, t.id),
    unique('succession_sync_items_nomination').on(t.tenantId, t.batchId, t.nominationId),
    foreignKey({
      name: 'succession_sync_items_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [successionSyncBatches.tenantId, successionSyncBatches.id],
    }).onDelete('restrict'),
    check('succession_sync_items_kind', sql`${t.kind} IN ('org','position')`),
    check('succession_sync_items_direction', sql`${t.direction} IN ('successor','target')`),
    check('succession_sync_items_plan', sql`${t.planOutcome} IN ('planned','failed','skipped')`),
    check('succession_sync_items_exec', sql`${t.execOutcome} IN ('created','updated','exists','failed','aborted')`),
    check(
      'succession_sync_items_target',
      sql`(${t.kind}='org' AND ${t.targetOrgId} IS NOT NULL
      AND ${t.targetPositionId} IS NULL) OR (${t.kind}='position' AND ${t.targetPositionId} IS NOT NULL
      AND ${t.targetOrgId} IS NULL)`,
    ),
  ],
);

/** §7：与 A2 共用目标锁；pending / 可重试 failed 在已计划批次中形成持久屏障。 */
export const successionSyncTargets = pgTable(
  'succession_sync_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    batchId: uuid('batch_id').notNull(),
    targetKind: text('target_kind').$type<'org' | 'position' | 'org_health'>().notNull(),
    targetId: uuid('target_id').notNull(),
    action: text('action')
      .$type<'append' | 'overwrite' | 'scope_overwrite' | 'delete_only' | 'health_write'>()
      .notNull(),
    plannedItemIds: jsonb('planned_item_ids').$type<readonly string[]>().notNull().default([]),
    oldRecordIds: jsonb('old_record_ids').$type<readonly string[]>().notNull().default([]),
    healthLevelId: uuid('health_level_id'),
    healthManual: boolean('health_manual'),
    healthStatus: text('health_status').$type<'value' | 'empty' | 'not_provided' | 'forbidden'>(),
    status: text('status').$type<'pending' | 'done' | 'failed' | 'aborted'>().notNull().default('pending'),
    retryable: boolean('retryable').notNull().default(false),
    errorCode: text('error_code'),
    errorParams: jsonb('error_params').$type<Readonly<Record<string, unknown>>>(),
    endedRecordIds: jsonb('ended_record_ids').$type<readonly string[]>().notNull().default([]),
    targetRowKey: text('target_row_key').notNull(),
    executionNo: integer('execution_no').notNull(),
    pageCommandId: text('page_command_id').notNull(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [
    unique('succession_sync_targets_target').on(t.tenantId, t.batchId, t.targetKind, t.targetId),
    foreignKey({
      name: 'succession_sync_targets_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [successionSyncBatches.tenantId, successionSyncBatches.id],
    }).onDelete('restrict'),
    check('succession_sync_targets_kind', sql`${t.targetKind} IN ('org','position','org_health')`),
    check(
      'succession_sync_targets_action',
      sql`${t.action} IN ('append','overwrite','scope_overwrite','delete_only','health_write')`,
    ),
    check('succession_sync_targets_status', sql`${t.status} IN ('pending','done','failed','aborted')`),
    check('succession_sync_targets_health', sql`${t.healthStatus} IN ('value','empty','not_provided','forbidden')`),
    check('succession_sync_targets_health_action', sql`(${t.targetKind}='org_health') = (${t.action}='health_write')`),
    index('succession_sync_targets_barrier').on(t.tenantId, t.targetKind, t.targetId, t.status),
  ],
);

/** 批次持有、无过期时间；租约过期不能释放这把跨 run 互斥（SP-09）。 */
export const successionSyncMutex = pgTable(
  'succession_sync_mutex',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    batchId: uuid('batch_id'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'succession_sync_mutex_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [successionSyncBatches.tenantId, successionSyncBatches.id],
    }).onDelete('restrict'),
  ],
);
