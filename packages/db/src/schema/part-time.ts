import { employmentForms } from './employment-forms.js';
import { employmentTypes } from './employment-types.js';
/**
 * BE-7 兼职（docs/08_设计/R2-T05_兼职设计.md §1.2 / §1.4）：兼职期限链与兼职申请三表。
 * 兼职记录本身复用 employment_records（service_type ≠ primary、kind = part_time，不进时间轴，§1.1），这里只放
 * 追加式的期限链与独立的申请对象（原站 ParttimeJobApproval）。触发器、RLS 与授权见迁移手写部分。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentEmployees, employmentRecords } from './employment.js';
import { jobLevelObjects, jobPositionObjects, jobPostObjects, jobSequenceObjects } from './job.js';
import { orgObjects } from './org.js';
import { tenants } from './tenancy.js';

const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const utc = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const day = (name: string) => date(name, { mode: 'string' });

interface TenantKeyed {
  readonly tenantId: AnyPgColumn;
  readonly id: AnyPgColumn;
}
const ref = (name: string, t: AnyPgColumn, column: AnyPgColumn, target: TenantKeyed) =>
  foreignKey({ name, columns: [t, column], foreignColumns: [target.tenantId, target.id] });
const recordFk = (name: string, t: Record<'tenantId' | 'employeeId' | 'recordId', AnyPgColumn>) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.employeeId, t.recordId],
    foreignColumns: [employmentRecords.tenantId, employmentRecords.employeeId, employmentRecords.id],
  });
const employeeFk = (name: string, t: Record<'tenantId' | 'employeeId', AnyPgColumn>) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.employeeId],
    foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
  });

/**
 * 兼职期限链（§1.2）：新增 / 编辑 / 延长 / 结束 / 批量结束 / 调动结束 / 离职结束，每次在同一条兼职记录上追加一期，
 * 当前期 = 最大期号；“原结束日期”从上一期取（硬规则 3）。end_date 为空 = 无结束日期，含当天。
 * 结束日不早于记录开始日 − 1、空区间只允许系统来源，由插入触发器读记录开始日校验（跨表，CHECK 写不了）。
 */
export const employmentPartTimeTerms = pgTable(
  'employment_part_time_terms',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    recordId: uuid('record_id').notNull(),
    termNo: integer('term_no').notNull(),
    endDate: day('end_date'),
    source: text('source').notNull(),
    /** 申请 ID（来自申请）/ 批次 ID / 调动联动子项 ID / 离职记录 ID。 */
    sourceId: uuid('source_id'),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_part_time_terms_tenant_id').on(t.tenantId, t.id),
    // 当前期按 (tenant, record, term_no DESC) 取，唯一索引可倒序扫描，不另建索引
    unique('employment_part_time_terms_record_term').on(t.tenantId, t.recordId, t.termNo),
    recordFk('employment_part_time_terms_record_fk', t),
    index('employment_part_time_terms_employee').on(t.tenantId, t.employeeId),
    check('employment_part_time_terms_term_positive', sql`${t.termNo} > 0`),
    check(
      'employment_part_time_terms_source',
      sql`${t.source} IN ('create', 'edit', 'extend', 'end', 'batch_end', 'transfer', 'exit')`,
    ),
    check('employment_part_time_terms_end_finite', sql`${t.endDate} IS NULL OR isfinite(${t.endDate})`),
    check('employment_part_time_terms_command_nonempty', sql`btrim(${t.commandId}) <> ''`),
  ],
);

/**
 * 兼职申请头（§1.4）：1 行 / 单，只允许改 revision（迁移里的 protect_employment_head_metadata 触发器与列级授权）。
 * 新增申请不挂记录（落地的记录 ID 记在 effective 事件上），延长 / 结束挂目标兼职记录。
 */
export const partTimeRequests = pgTable(
  'part_time_requests',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    requestType: text('request_type').notNull(),
    recordId: uuid('record_id'),
    initiator: text('initiator').notNull(),
    initiatorUserId: uuid('initiator_user_id').notNull(),
    /** 提交时绑定的流程编码（原站标准编码，`14` §11.1）。 */
    processCode: text('process_code'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
  },
  (t) => [
    unique('part_time_requests_tenant_id').on(t.tenantId, t.id),
    unique('part_time_requests_employee_id').on(t.tenantId, t.employeeId, t.id),
    employeeFk('part_time_requests_employee_fk', t),
    recordFk('part_time_requests_record_fk', t),
    index('part_time_requests_employee').on(t.tenantId, t.employeeId, t.createdAt),
    index('part_time_requests_record')
      .on(t.tenantId, t.recordId)
      .where(sql`${t.recordId} IS NOT NULL`),
    check('part_time_requests_type', sql`${t.requestType} IN ('add', 'extend', 'end')`),
    check('part_time_requests_record_pair', sql`(${t.requestType} = 'add') = (${t.recordId} IS NULL)`),
    check('part_time_requests_initiator', sql`${t.initiator} IN ('hr', 'self', 'manager')`),
    check('part_time_requests_revision_positive', sql`${t.revision} > 0`),
  ],
);

const requestFk = (name: string, t: Record<'tenantId' | 'employeeId' | 'requestId', AnyPgColumn>) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.employeeId, t.requestId],
    foreignColumns: [partTimeRequests.tenantId, partTimeRequests.employeeId, partTimeRequests.id],
  });

/**
 * 兼职申请载荷版本（§1.4，追加式）：预置字段与兼职记录同一组（§1.1）。原定结束日期、提交时的目标期号是延长 /
 * 结束申请创建时取目标记录当前期的值，此后不被实际失效日覆盖（R2f1“原定结束日期仍是 10-31”）。
 */
export const partTimeRequestVersions = pgTable(
  'part_time_request_versions',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    requestId: uuid('request_id').notNull(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    commandId: text('command_id').notNull(),
    serviceType: text('service_type').notNull(),
    institutionId: uuid('institution_id'),
    departmentId: uuid('department_id'),
    positionId: uuid('position_id'),
    postId: uuid('post_id'),
    sequenceId: uuid('sequence_id'),
    levelId: uuid('level_id'),
    directManagerId: uuid('direct_manager_id'),
    dottedManagerId: uuid('dotted_manager_id'),
    employmentType: uuid('employment_type'),
    employmentForm: text('employment_form'),
    isDepartmentHead: boolean('is_department_head'),
    addedSubordinateIds: uuid('added_subordinate_ids').array(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date'),
    originalEndDate: day('original_end_date'),
    baseTermNo: integer('base_term_no'),
    remark: text('remark'),
    customFields: jsonb('custom_fields')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: utc(),
  },
  (t) => [
    foreignKey({
      name: 'part_time_request_versions_form_fk',
      columns: [t.tenantId, t.employmentForm],
      foreignColumns: [employmentForms.tenantId, employmentForms.code],
    }),
    foreignKey({
      name: 'part_time_request_versions_type_fk',
      columns: [t.tenantId, t.employmentType],
      foreignColumns: [employmentTypes.tenantId, employmentTypes.id],
    }),
    unique('part_time_request_versions_tenant_id').on(t.tenantId, t.id),
    unique('part_time_request_versions_request_id').on(t.tenantId, t.employeeId, t.requestId, t.id),
    unique('part_time_request_versions_request_version').on(t.tenantId, t.requestId, t.versionNo),
    requestFk('part_time_request_versions_request_fk', t),
    foreignKey({
      name: 'part_time_request_versions_previous_fk',
      columns: [t.tenantId, t.employeeId, t.requestId, t.previousVersionId],
      foreignColumns: [t.tenantId, t.employeeId, t.requestId, t.id],
    }),
    ref('part_time_request_versions_institution_fk', t.tenantId, t.institutionId, orgObjects),
    ref('part_time_request_versions_department_fk', t.tenantId, t.departmentId, orgObjects),
    ref('part_time_request_versions_position_fk', t.tenantId, t.positionId, jobPositionObjects),
    ref('part_time_request_versions_post_fk', t.tenantId, t.postId, jobPostObjects),
    ref('part_time_request_versions_sequence_fk', t.tenantId, t.sequenceId, jobSequenceObjects),
    ref('part_time_request_versions_level_fk', t.tenantId, t.levelId, jobLevelObjects),
    ref('part_time_request_versions_direct_manager_fk', t.tenantId, t.directManagerId, employmentEmployees),
    ref('part_time_request_versions_dotted_manager_fk', t.tenantId, t.dottedManagerId, employmentEmployees),
    check('part_time_request_versions_version_positive', sql`${t.versionNo} > 0`),
    check('part_time_request_versions_previous_not_self', sql`${t.previousVersionId} <> ${t.id}`),
    check('part_time_request_versions_command_nonempty', sql`btrim(${t.commandId}) <> ''`),
    check(
      'part_time_request_versions_service_type',
      sql`${t.serviceType} IN ('part_time', 'secondment', 'expatriate')`,
    ),
    // 人工填写的日期：结束日期不能早于开始日期（R2d 原文，D-1 / T-1 的数据库兜底）
    check('part_time_request_versions_end_date', sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
    check(
      'part_time_request_versions_dates_finite',
      sql`isfinite(${t.startDate}) AND coalesce(isfinite(${t.endDate}), true)
        AND coalesce(isfinite(${t.originalEndDate}), true)`,
    ),
    check('part_time_request_versions_base_term', sql`${t.baseTermNo} IS NULL OR ${t.baseTermNo} > 0`),
    check('part_time_request_versions_remark', sql`char_length(${t.remark}) <= 32766`),
    check('part_time_request_versions_custom_object', sql`jsonb_typeof(${t.customFields}) = 'object'`),
  ],
);

/**
 * 兼职申请状态事件（§1.4 / §2.2，追加式）：状态集合与任职业务一致；作废必须写原因，effective 写落地 / 被改的兼职记录。
 * event_seq 由数据库在持员工行锁写入时分配（同 employment_state_events，DEC-108）。
 */
export const partTimeRequestEvents = pgTable(
  'part_time_request_events',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    requestId: uuid('request_id').notNull(),
    versionId: uuid('version_id').notNull(),
    state: text('state').notNull(),
    eventNo: integer('event_no').notNull(),
    commandId: text('command_id').notNull(),
    reason: text('reason'),
    recordId: uuid('record_id'),
    eventSeq: bigint('event_seq', { mode: 'number' }).generatedByDefaultAsIdentity(),
    createdAt: utc(),
  },
  (t) => [
    unique('part_time_request_events_tenant_id').on(t.tenantId, t.id),
    unique('part_time_request_events_request_number').on(t.tenantId, t.requestId, t.eventNo),
    foreignKey({
      name: 'part_time_request_events_version_fk',
      columns: [t.tenantId, t.employeeId, t.requestId, t.versionId],
      foreignColumns: [
        partTimeRequestVersions.tenantId,
        partTimeRequestVersions.employeeId,
        partTimeRequestVersions.requestId,
        partTimeRequestVersions.id,
      ],
    }),
    recordFk('part_time_request_events_record_fk', t),
    index('part_time_request_events_employee_seq').on(t.tenantId, t.employeeId, t.eventSeq),
    check('part_time_request_events_number_positive', sql`${t.eventNo} > 0`),
    check('part_time_request_events_command_nonempty', sql`btrim(${t.commandId}) <> ''`),
    check(
      'part_time_request_events_state',
      sql`${t.state} IN ('draft', 'in_review', 'approved', 'rejected', 'disapproved', 'voided', 'effective',
        'deleted')`,
    ),
    check(
      'part_time_request_events_reason',
      sql`(${t.state} = 'voided') = (${t.reason} IS NOT NULL) AND (${t.reason} IS NULL
        OR ${t.reason} IN ('hr', 'exit', 'transfer', 'changed_since_submit', 'landing_rejected'))`,
    ),
    check('part_time_request_events_record', sql`(${t.state} = 'effective') = (${t.recordId} IS NOT NULL)`),
  ],
);
