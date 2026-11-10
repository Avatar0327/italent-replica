/**
 * F-493 S2 历史离职人员导入：批次与逐行明细（docs/08_设计/F-493_历史离职人员导入对齐北森_设计.md §6.5）。
 * 全部带 tenant_id；RLS / 授权在迁移里手写（FORCE RLS，只授 app_user）。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects, employmentEmployees } from './employment.js';
import { tenantMemberships, tenants } from './tenancy.js';

const utc = (name: string) => timestamp(name, { withTimezone: true });
const count = (name: string) => integer(name).notNull().default(0);

export const exitImportBatches = pgTable(
  'exit_import_batches',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    commandId: text('command_id').notNull(),
    submittedBy: uuid('submitted_by').notNull(),
    fileName: text('file_name').notNull(),
    status: text('status').notNull().default('queued'),
    total: integer('total').notNull(),
    createdCount: count('created_count'),
    /** 错误行数（错误文件的数据行数、操作日志 failureCount）；与 error_count 的区别见设计 §6.3（DEC-840①）。 */
    errorRowCount: count('error_row_count'),
    /** 错误条数（一行可有多条）：通知正文与导入历史的 N。 */
    errorCount: count('error_count'),
    attempts: count('attempts'),
    leaseUntil: utc('lease_until'),
    startedAt: utc('started_at'),
    finishedAt: utc('finished_at'),
    expiresAt: utc('expires_at'),
    purgedAt: utc('purged_at'),
    createdAt: utc('created_at').notNull().defaultNow(),
    lastError: text('last_error'),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'exit_import_batches_submitter_fk',
      columns: [t.tenantId, t.submittedBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    index('exit_import_batches_status_lease').on(t.tenantId, t.status, t.leaseUntil),
    index('exit_import_batches_expiry')
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.purgedAt} IS NULL`),
    // 导入历史本人列表（设计 §8.4）
    index('exit_import_batches_own_list').on(t.tenantId, t.submittedBy, sql`${t.createdAt} DESC`, sql`${t.id} DESC`),
    check('exit_import_batches_status', sql`${t.status} IN ('queued','running','completed','failed')`),
    check('exit_import_batches_total', sql`${t.total} BETWEEN 1 AND 1000`),
    check(
      'exit_import_batches_counts',
      sql`${t.createdCount} >= 0 AND ${t.errorRowCount} >= 0 AND ${t.errorCount} >= 0 AND ${t.attempts} >= 0
        AND ${t.errorRowCount} <= ${t.total} AND ${t.errorCount} >= ${t.errorRowCount}`,
    ),
    check('exit_import_batches_file_name', sql`char_length(${t.fileName}) BETWEEN 1 AND 255`),
    check('exit_import_batches_expires', sql`${t.expiresAt} IS NULL OR ${t.status} IN ('completed','failed')`),
  ],
);

const raw = (name: string) => text(name);

export const exitImportRows = pgTable(
  'exit_import_rows',
  {
    tenantId: uuid('tenant_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    rowNo: integer('row_no').notNull(),
    // B～Z 共 25 列原始输入，只去首尾空白；日期存原文；批次过期后整批置 NULL（设计 §8.3）
    name: raw('name'),
    email: raw('email'),
    departmentCode: raw('department_code'),
    entryDate: raw('entry_date'),
    positionName: raw('position_name'),
    postName: raw('post_name'),
    levelName: raw('level_name'),
    workDate: raw('work_date'),
    place: raw('place'),
    idNumber: raw('id_number'),
    mobilePhone: raw('mobile_phone'),
    personalEmail: raw('personal_email'),
    gender: raw('gender'),
    birthday: raw('birthday'),
    nation: raw('nation'),
    politicalStatus: raw('political_status'),
    householdAddress: raw('household_address'),
    registAddress: raw('regist_address'),
    school: raw('school'),
    major: raw('major'),
    lastWorkDate: raw('last_work_date'),
    exitTypeName: raw('exit_type_name'),
    exitReasonName: raw('exit_reason_name'),
    whereaboutsName: raw('whereabouts_name'),
    exitNote: raw('exit_note'),
    status: text('status').notNull().default('pending'),
    /** `[{ column: 'A'..'Z' | null, reason }]`，只存列字母和原因码，不存值。 */
    errors: jsonb('errors')
      .$type<{ column: string | null; reason: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    employeeId: uuid('employee_id'),
    exitBusinessId: uuid('exit_business_id'),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.batchId, t.rowNo] }),
    foreignKey({
      name: 'exit_import_rows_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [exitImportBatches.tenantId, exitImportBatches.id],
    }),
    foreignKey({
      name: 'exit_import_rows_employee_fk',
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'exit_import_rows_business_fk',
      columns: [t.tenantId, t.employeeId, t.exitBusinessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    check('exit_import_rows_row_no', sql`${t.rowNo} >= 1`),
    check('exit_import_rows_status', sql`${t.status} IN ('pending','succeeded','created_with_error','failed')`),
    // failed / created_with_error 必有错误，其余必无
    check(
      'exit_import_rows_errors',
      sql`jsonb_typeof(${t.errors}) = 'array' AND ((${t.status} IN ('failed','created_with_error'))
        = (jsonb_array_length(${t.errors}) > 0))`,
    ),
    // 建了人的两种终态才有人员 / 离职业务引用
    check(
      'exit_import_rows_refs',
      sql`(${t.status} IN ('succeeded','created_with_error')) = (${t.employeeId} IS NOT NULL)
        AND (${t.employeeId} IS NOT NULL) = (${t.exitBusinessId} IS NOT NULL)`,
    ),
    index('exit_import_rows_pending').on(t.tenantId, t.batchId, t.status, t.rowNo),
  ],
);
