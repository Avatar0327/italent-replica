/**
 * R3-T05 继任管理的表结构（设计 §1；schema/index.ts 已导出）。表随子 PR 在本文件追加，迁移按开工时最新 main
 * 用 pnpm db:generate 连续生成（DEC-221）。A1 建继任记录与目标锁；区间排他、RLS、授权、SQL 函数与触发器在配套的
 * --custom 迁移里（drizzle 表达不了 EXCLUDE）。
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
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { jobPositionObjects } from './job.js';
import { orgObjects } from './org.js';
import { talentReadinessLevels } from './talent-review.js';
import { tenants } from './tenancy.js';

export const SUCCESSION_TYPES = ['org', 'position'] as const;
export type SuccessionType = (typeof SUCCESSION_TYPES)[number];
export const SUCCESSION_BACKUP_TYPES = ['principal', 'deputy'] as const;
export const SUCCESSION_END_SOURCES = ['manual', 'exit', 'sync_overwrite', 'sync_scope_overwrite'] as const;
export const SUCCESSION_SOURCE_KINDS = ['manual', 'review_sync'] as const;
/** 结束日的“长期有效”哨兵值（§1.1：end_date 非空，默认 9999-12-31；生效状态派生）。 */
export const SUCCESSION_OPEN_END = '9999-12-31';

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));

/**
 * 继任记录（原站 `Map`，§1.1）。区间 [start_date, end_date) 半开；同目标同继任者任何两条未删除记录区间不得重叠
 * （排他约束 succession_records_no_overlap，在配套 SQL 迁移里）。软删除（deleted_at）后不参与任何列表 / 统计 / 查重，
 * 且同事务释放准备度引用（触发器）。source_batch_id / source_item_id 先建列、不建外键（同步批次表由 D1 建并补外键）。
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
    targetKind: text('target_kind').$type<SuccessionType>().notNull(),
    targetId: uuid('target_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.targetKind, t.targetId] }),
    check('succession_target_locks_kind', sql`${t.targetKind} IN (${list(SUCCESSION_TYPES)})`),
  ],
);
