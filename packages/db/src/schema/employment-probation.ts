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
    check('employment_probation_versions_source', sql`${t.source} IN ('entry', 'adjust', 'intern_regularization')`),
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
