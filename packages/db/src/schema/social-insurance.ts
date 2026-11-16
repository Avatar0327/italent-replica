/**
 * 社保缴交方案与员工社保档案（F-474-8c-2a；docs/08_设计/F-474-8b_社保与调动薪资_设计.md §3.2 / §3.3）。
 * 方案 + 方案版本是主数据（运行时只读，种子 / 导入脚本写）；档案是事件溯源版本链：一次调动追加一条，
 * 不按日期唯一，没有 before_* 列（变更前从版本链取）。RLS、app_user 授权、方案版本区间排他在迁移里手写。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminRegions } from './admin-regions.js';
import { contractCompanies } from './contracts.js';
import { employmentBusinessObjects, employmentEmployees } from './employment.js';
import { tenants } from './tenancy.js';

const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

/** 缴交方案头：只有租户内唯一的业务编码；名称、缴交地、生效区间都在版本表。 */
export const socialInsurancePlans = pgTable(
  'social_insurance_plans',
  {
    tenantId: tenant(),
    id: uuid('id').notNull().defaultRandom(),
    code: text('code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique('social_insurance_plans_code').on(t.tenantId, t.code),
    check('social_insurance_plans_code_nonempty', sql`btrim(${t.code}) <> ''`),
  ],
);

/** 方案版本：同方案同生效月唯一；区间 [生效月, 停用月) 不重叠由迁移里手写的排他约束保证（沿用继任记录做法）。 */
export const socialInsurancePlanVersions = pgTable(
  'social_insurance_plan_versions',
  {
    tenantId: tenant(),
    id: uuid('id').notNull().defaultRandom(),
    planId: uuid('plan_id').notNull(),
    name: text('name').notNull(),
    regionCode: text('region_code')
      .notNull()
      .references(() => adminRegions.code),
    effectiveMonth: date('effective_month', { mode: 'string' }).notNull(),
    /** 空 = 长期有效；半开区间，停用月本身不再生效。 */
    stopMonth: date('stop_month', { mode: 'string' }),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'social_insurance_plan_versions_plan_fk',
      columns: [t.tenantId, t.planId],
      foreignColumns: [socialInsurancePlans.tenantId, socialInsurancePlans.id],
    }),
    unique('social_insurance_plan_versions_month').on(t.tenantId, t.planId, t.effectiveMonth),
    check('social_insurance_plan_versions_month_start', sql`extract(day from ${t.effectiveMonth}) = 1`),
    check(
      'social_insurance_plan_versions_stop_after',
      sql`${t.stopMonth} IS NULL OR (${t.stopMonth} > ${t.effectiveMonth} AND extract(day from ${t.stopMonth}) = 1)`,
    ),
    check('social_insurance_plan_versions_revision_positive', sql`${t.revision} > 0`),
    check('social_insurance_plan_versions_name_nonempty', sql`btrim(${t.name}) <> ''`),
  ],
);

/**
 * 员工社保档案版本链：只存各调动业务填写的调整值（缴交地 / 方案 / 公司，null = 未填写、沿用前驱），不复制完整当前值。
 * 业务顺序由 (effective_date, planned_effective_date, operation_seq) 表达；version_no 只是员工锁内的追加序号。
 */
export const socialInsuranceArchiveVersions = pgTable(
  'social_insurance_archive_versions',
  {
    tenantId: tenant(),
    id: uuid('id').notNull().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    versionNo: integer('version_no').notNull(),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    plannedEffectiveDate: date('planned_effective_date', { mode: 'string' }).notNull(),
    operationSeq: bigint('operation_seq', { mode: 'number' }).notNull(),
    regionCode: text('region_code').references(() => adminRegions.code),
    planId: uuid('plan_id'),
    companyId: uuid('company_id'),
    source: text('source').notNull(),
    sourceBusinessId: uuid('source_business_id').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    unique('social_insurance_archive_versions_number').on(t.tenantId, t.employeeId, t.versionNo),
    unique('social_insurance_archive_versions_source').on(t.tenantId, t.source, t.sourceBusinessId),
    foreignKey({
      name: 'social_insurance_archive_versions_business_fk',
      columns: [t.tenantId, t.sourceBusinessId],
      foreignColumns: [employmentBusinessObjects.tenantId, employmentBusinessObjects.id],
    }),
    foreignKey({
      name: 'social_insurance_archive_versions_employee_fk',
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'social_insurance_archive_versions_plan_fk',
      columns: [t.tenantId, t.planId],
      foreignColumns: [socialInsurancePlans.tenantId, socialInsurancePlans.id],
    }),
    foreignKey({
      name: 'social_insurance_archive_versions_company_fk',
      columns: [t.tenantId, t.companyId],
      foreignColumns: [contractCompanies.tenantId, contractCompanies.id],
    }),
    check('social_insurance_archive_versions_number_positive', sql`${t.versionNo} > 0`),
    // 最小集只有调动一种来源；放开入职 / 离职等来源时走新迁移改 CHECK（DEC-402）
    check('social_insurance_archive_versions_source_check', sql`${t.source} IN ('transfer')`),
  ],
);
