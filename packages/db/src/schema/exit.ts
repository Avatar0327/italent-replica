/**
 * R2-T03 离职：扩展行、三个字典、效果台账、撤销记录（docs/08_设计/R2-T03_离职管理设计.md §2.1）。
 * 离职本体是任职业务 kind='leave'（申请单层复用 employment_*），这里只放离职特有的数据；状态与 revision 都在业务头。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
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
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects, employmentCycles, employmentEmployees } from './employment.js';
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
const businessFk = (name: string, t: Record<'tenantId' | 'employeeId' | 'businessId', AnyPgColumn>) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.employeeId, t.businessId],
    foreignColumns: [
      employmentBusinessObjects.tenantId,
      employmentBusinessObjects.employeeId,
      employmentBusinessObjects.id,
    ],
  });

/** 离职扩展行：与任职业务 1:1（照 transfer_requests）；可改的只有非日期业务字段（列级授权见迁移）。 */
export const exitRequests = pgTable(
  'exit_requests',
  {
    tenantId: tenant(),
    businessId: uuid('business_id').notNull(),
    supersedesBusinessId: uuid('supersedes_business_id'),
    employeeId: uuid('employee_id').notNull(),
    /** 离职所属任职周期（employment_cycles.id），创建时等于载荷 selectedStaffId，此后不变（§2.1）。 */
    staffId: uuid('staff_id').notNull(),
    mode: text('mode').notNull(),
    initiator: text('initiator').notNull(),
    initiatorUserId: uuid('initiator_user_id').notNull(),
    /** 本人申请“手写离职申请”附件的元数据 ID 数组；上传与下载验权随 F-020。 */
    attachmentRefs: jsonb('attachment_refs'),
    processCode: text('process_code'),
    exitTypeCode: text('exit_type_code'),
    reasonCode: text('reason_code'),
    whereaboutsCode: text('whereabouts_code'),
    handoverEmployeeId: uuid('handover_employee_id'),
    addToBlacklist: boolean('add_to_blacklist').notNull().default(false),
    /** 加黑三项（DM-R2，R2f B68）：只在 addToBlacklist 时有值；有效截止日期空 = 永久。离职生效时由 BE-8b1 写入黑名单。 */
    blacklistExpiryDate: day('blacklist_expiry_date'),
    blacklistReason: text('blacklist_reason'),
    blacklistNote: text('blacklist_note'),
    compensationAmount: numeric('compensation_amount', { precision: 14, scale: 2 }),
    nonCompeteAmount: numeric('non_compete_amount', { precision: 14, scale: 2 }),
    lastPayDate: day('last_pay_date'),
    socialInsuranceEndMonth: text('social_insurance_end_month'),
    annualLeaveSettled: boolean('annual_leave_settled'),
    taxPeriod: text('tax_period'),
    taxYear: integer('tax_year'),
    employerName: text('employer_name'),
    actualLeaveDate: day('actual_leave_date'),
    /** 确认过的在途调动完整集合与令牌哈希（§8，不回传）。 */
    pendingTransferAck: jsonb('pending_transfer_ack'),
    batchId: uuid('batch_id'),
    dutyTransferTiming: text('duty_transfer_timing').notNull(),
    /** 编制预减时点 R（DEC-266①）：审批通过 / 直接离职确认的租户日，与生效日分离（§6）。 */
    preReleaseDate: day('pre_release_date'),
    createdAt: utc(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.businessId] }),
    businessFk('exit_requests_business_fk', t),
    foreignKey({
      name: 'exit_requests_supersedes_fk',
      columns: [t.tenantId, t.employeeId, t.supersedesBusinessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    unique('exit_requests_one_successor').on(t.tenantId, t.supersedesBusinessId),
    foreignKey({
      name: 'exit_requests_cycle_fk',
      columns: [t.tenantId, t.employeeId, t.staffId],
      foreignColumns: [employmentCycles.tenantId, employmentCycles.employeeId, employmentCycles.id],
    }),
    foreignKey({
      name: 'exit_requests_handover_fk',
      columns: [t.tenantId, t.handoverEmployeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    index('exit_requests_employee').on(t.tenantId, t.employeeId),
    index('exit_requests_batch')
      .on(t.tenantId, t.batchId)
      .where(sql`${t.batchId} IS NOT NULL`),
    check('exit_requests_mode', sql`${t.mode} IN ('application', 'direct')`),
    check('exit_requests_initiator', sql`${t.initiator} IN ('hr', 'self', 'manager')`),
    // 本人申请与经理代发只能走申请（§4B）
    check('exit_requests_direct_by_hr', sql`${t.mode} <> 'direct' OR ${t.initiator} = 'hr'`),
    check('exit_requests_timing', sql`${t.dutyTransferTiming} IN ('business_effective', 'approval_passed')`),
    check('exit_requests_attachments', sql`${t.attachmentRefs} IS NULL OR jsonb_typeof(${t.attachmentRefs}) = 'array'`),
    check(
      'exit_requests_amounts',
      sql`coalesce(${t.compensationAmount}, 0) >= 0 AND coalesce(${t.nonCompeteAmount}, 0) >= 0`,
    ),
    check(
      'exit_requests_months',
      sql`coalesce(${t.socialInsuranceEndMonth}, '2000-01') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
        AND coalesce(${t.taxPeriod}, '2000-01') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check('exit_requests_tax_year', sql`${t.taxYear} IS NULL OR ${t.taxYear} BETWEEN 1900 AND 9999`),
    check(
      'exit_requests_blacklist',
      sql`(${t.addToBlacklist} OR (${t.blacklistExpiryDate} IS NULL AND ${t.blacklistReason} IS NULL
          AND ${t.blacklistNote} IS NULL))
        AND (${t.blacklistReason} IS NULL
          OR ${t.blacklistReason} IN ('major_violation', 'integrity', 'instability', 'resignation', 'other'))
        AND coalesce(char_length(${t.blacklistNote}), 0) <= 500`,
    ),
  ],
);

/** 三个字典同构（照合同主数据 master 形态）：编码租户内唯一（不分大小写）、保存后不可改，不提供删除（§2.1）。 */
const dictionary = (name: string) =>
  pgTable(
    name,
    {
      id: id(),
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
      unique(`${name}_tenant_id`).on(t.tenantId, t.id),
      uniqueIndex(`${name}_code`).on(t.tenantId, sql`lower(${t.code})`),
      check(`${name}_code_nonempty`, sql`btrim(${t.code}) <> ''`),
      check(`${name}_name_nonempty`, sql`btrim(${t.name}) <> ''`),
      check(`${name}_revision_positive`, sql`${t.revision} > 0`),
      check(`${name}_display_order`, sql`${t.displayOrder} >= 0`),
    ],
  );
export const exitTypes = dictionary('exit_types');
export const exitReasons = dictionary('exit_reasons');
export const exitWhereabouts = dictionary('exit_whereabouts');

/** 离职在确认 / 生效时对下游产生的效果台账，只追加（§2.1）。 */
export const exitEffects = pgTable(
  'exit_effects',
  {
    id: id(),
    tenantId: tenant(),
    businessId: uuid('business_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    phase: text('phase').notNull(),
    kind: text('kind').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    businessFk('exit_effects_business_fk', t),
    index('exit_effects_business').on(t.tenantId, t.businessId, t.phase, t.kind),
    check('exit_effects_phase', sql`${t.phase} IN ('confirmed', 'effective')`),
    check(
      'exit_effects_kind',
      sql`${t.kind} IN ('establishment_pre_released', 'contract_terminated', 'contract_deleted',
        'contract_request_withdrawn', 'application_voided', 'future_transfer_detached', 'duty_transferred',
        'duty_failed', 'rehire_created')`,
    ),
    check('exit_effects_target_type', sql`btrim(${t.targetType}) <> ''`),
  ],
);

/** 撤销的离职记录：一次撤销一行、不删除；只有撤销原因可事后修改（DM-R5，revision 乐观锁）。 */
export const exitCancellations = pgTable(
  'exit_cancellations',
  {
    id: id(),
    tenantId: tenant(),
    businessId: uuid('business_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    stateBefore: text('state_before').notNull(),
    /** 设计 §2.1 的 case（SQL 保留字，列名加前缀）。 */
    cancelCase: text('cancel_case').notNull(),
    reason: text('reason').notNull(),
    revision: integer('revision').notNull().default(1),
    downstream: jsonb('downstream')
      .notNull()
      .default(sql`'{}'::jsonb`),
    commandId: text('command_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('exit_cancellations_tenant_id').on(t.tenantId, t.id),
    // 撤销后业务进入 voided / deleted 终态且不提供恢复（§7.3），同一业务至多撤销一次
    unique('exit_cancellations_business').on(t.tenantId, t.businessId),
    businessFk('exit_cancellations_business_fk', t),
    index('exit_cancellations_created').on(t.tenantId, t.createdAt, t.id),
    check(
      'exit_cancellations_state',
      sql`${t.stateBefore} IN ('draft', 'in_review', 'approved', 'rejected', 'effective')`,
    ),
    check(
      'exit_cancellations_case',
      sql`${t.cancelCase} IN ('process_voided', 'approved_voided', 'record_deleted', 'record_deleted_reinstated')`,
    ),
    check('exit_cancellations_reason', sql`btrim(${t.reason}) <> ''`),
    check('exit_cancellations_revision', sql`${t.revision} > 0`),
  ],
);

/**
 * 离职交接事项设置（BE-8b1，B64；DEC-266③）：事项类别、序号、待办类别、待办事项、事项办理表单、备注。
 * 没有适用人群与负责人（办理人由交接流程会签节点决定，归 BE-8b2）；不预置原站 30 项。
 */
export const exitHandoverItems = pgTable(
  'exit_handover_items',
  {
    id: id(),
    tenantId: tenant(),
    category: text('category').notNull(),
    sequenceNo: integer('sequence_no').notNull(),
    todoType: text('todo_type').notNull(),
    title: text('title').notNull(),
    /** 事项办理表单：只存文本或表单标识，不接表单引擎。 */
    formRef: text('form_ref'),
    remark: text('remark'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('exit_handover_items_tenant_id').on(t.tenantId, t.id),
    index('exit_handover_items_list').on(t.tenantId, t.sequenceNo, t.createdAt, t.id),
    check('exit_handover_items_category', sql`btrim(${t.category}) <> '' AND char_length(${t.category}) <= 50`),
    check('exit_handover_items_sequence', sql`${t.sequenceNo} >= 1`),
    check('exit_handover_items_todo_type', sql`${t.todoType} IN ('work_handover', 'other')`),
    check('exit_handover_items_title', sql`btrim(${t.title}) <> '' AND char_length(${t.title}) <= 200`),
    check('exit_handover_items_form', sql`${t.formRef} IS NULL OR char_length(${t.formRef}) <= 200`),
    check('exit_handover_items_remark', sql`${t.remark} IS NULL OR char_length(${t.remark}) <= 500`),
    check('exit_handover_items_revision_positive', sql`${t.revision} > 0`),
  ],
);
