import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { contractRecords } from './contracts.js';
import { employmentBusinessObjects, employmentEmployees } from './employment.js';
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
const dictionary = () => ({
  tenantId: tenant(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  displayOrder: integer('display_order'),
});

/** 出厂定义在 domain；租户覆盖含停用状态，读取合并后再按业务日期过滤。 */
export const transferTypes = pgTable(
  'transfer_types',
  {
    ...dictionary(),
    formId: text('form_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.code] }),
    check('transfer_types_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('transfer_types_date_finite', sql`isfinite(${t.effectiveDate})`),
  ],
);
export const transferReasons = pgTable(
  'transfer_reasons',
  {
    ...dictionary(),
    transferTypeCode: text('transfer_type_code'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.code] }),
    check('transfer_reasons_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('transfer_reasons_date_finite', sql`isfinite(${t.effectiveDate})`),
  ],
);
export const transferSettings = pgTable(
  'transfer_settings',
  {
    tenantId: tenant().primaryKey(),
    revision: integer('revision').notNull().default(0),
  },
  (t) => [check('transfer_settings_revision_nonnegative', sql`${t.revision} >= 0`)],
);
export const transferSettingVersions = pgTable(
  'transfer_setting_versions',
  {
    id: id(),
    tenantId: tenant(),
    versionNo: integer('version_no').notNull(),
    unrestrictTargetDepartment: boolean('unrestrict_target_department').notNull().default(true),
    autoPopulate: boolean('auto_populate').notNull().default(true),
    createdAt: utc(),
  },
  (t) => [
    unique('transfer_setting_versions_tenant_id').on(t.tenantId, t.id),
    unique('transfer_setting_versions_number').on(t.tenantId, t.versionNo),
    foreignKey({
      name: 'transfer_setting_versions_settings_fk',
      columns: [t.tenantId],
      foreignColumns: [transferSettings.tenantId],
    }),
    check('transfer_setting_versions_number_positive', sql`${t.versionNo} > 0`),
  ],
);
export const transferForms = pgTable(
  'transfer_forms',
  {
    id: id(),
    tenantId: tenant(),
    formId: text('form_id').notNull(),
    revision: integer('revision').notNull().default(0),
  },
  (t) => [
    unique('transfer_forms_tenant_id').on(t.tenantId, t.id),
    unique('transfer_forms_tenant_form').on(t.tenantId, t.formId),
    check('transfer_forms_form_nonempty', sql`btrim(${t.formId}) <> ''`),
    check('transfer_forms_revision_nonnegative', sql`${t.revision} >= 0`),
  ],
);
export const transferFormVersions = pgTable(
  'transfer_form_versions',
  {
    id: id(),
    tenantId: tenant(),
    formId: uuid('form_id').notNull(),
    versionNo: integer('version_no').notNull(),
    name: text('name').notNull(),
    group: text('group'),
    processCode: text('process_code').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('transfer_form_versions_tenant_id').on(t.tenantId, t.id),
    unique('transfer_form_versions_number').on(t.tenantId, t.formId, t.versionNo),
    foreignKey({
      name: 'transfer_form_versions_form_fk',
      columns: [t.tenantId, t.formId],
      foreignColumns: [transferForms.tenantId, transferForms.id],
    }),
    check('transfer_form_versions_number_positive', sql`${t.versionNo} > 0`),
    check('transfer_form_versions_group', sql`${t.group} IS NULL OR ${t.group} = 'transfer'`),
    check('transfer_form_versions_process_nonempty', sql`btrim(${t.processCode}) <> ''`),
  ],
);
export const transferFormFields = pgTable(
  'transfer_form_fields',
  {
    tenantId: tenant(),
    versionId: uuid('version_id').notNull(),
    fieldCode: text('field_code').notNull(),
    mode: text('mode').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.fieldCode] }),
    foreignKey({
      name: 'transfer_form_fields_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [transferFormVersions.tenantId, transferFormVersions.id],
    }),
    check('transfer_form_fields_mode', sql`${t.mode} IN ('editable', 'readonly', 'hidden', 'absent')`),
  ],
);
export const transferRequests = pgTable(
  'transfer_requests',
  {
    tenantId: tenant(),
    businessId: uuid('business_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    transferTypeCode: text('transfer_type_code').notNull(),
    reasonCode: text('reason_code'),
    initiator: text('initiator').notNull(),
    processCode: text('process_code').notNull(),
    createdAt: utc(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'transfer_requests_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    check('transfer_requests_initiator', sql`${t.initiator} IN ('hr', 'manager', 'employee')`),
    check('transfer_requests_type_nonempty', sql`btrim(${t.transferTypeCode}) <> ''`),
    check('transfer_requests_process_nonempty', sql`btrim(${t.processCode}) <> ''`),
  ],
);

/**
 * R1-T10 调动跨对象联动（`21`，REQ-LNK-001）：调动表单上的联动选项。随表单保存追加版本，不原地改写；
 * 合同字段只保存合同端口（R2-T06 changeContractForTransfer）的入参快照，合同规则与合同对象由合同模块负责。
 */
export const transferLinkageVersions = pgTable(
  'transfer_linkage_versions',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    versionNo: integer('version_no').notNull(),
    changeContract: boolean('change_contract').notNull().default(false),
    contractTargetId: uuid('contract_target_id'),
    contractFields: jsonb('contract_fields').$type<Record<string, unknown>>(),
    adjustSalary: boolean('adjust_salary').notNull().default(false),
    onTrialStartDate: date('on_trial_start_date', { mode: 'string' }),
    onTrialMonths: integer('on_trial_months'),
    handover: boolean('handover').notNull().default(false),
    handoverPersonId: uuid('handover_person_id'),
    partTimeRecordIds: uuid('part_time_record_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('transfer_linkage_versions_tenant_id').on(t.tenantId, t.id),
    unique('transfer_linkage_versions_number').on(t.tenantId, t.businessId, t.versionNo),
    foreignKey({
      name: 'transfer_linkage_versions_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'transfer_linkage_versions_contract_fk',
      columns: [t.tenantId, t.contractTargetId],
      foreignColumns: [contractRecords.tenantId, contractRecords.id],
    }),
    foreignKey({
      name: 'transfer_linkage_versions_handover_fk',
      columns: [t.tenantId, t.handoverPersonId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    check('transfer_linkage_versions_number_positive', sql`${t.versionNo} > 0`),
    check(
      'transfer_linkage_versions_contract',
      sql`${t.changeContract} = (${t.contractTargetId} IS NOT NULL AND ${t.contractFields} IS NOT NULL)`,
    ),
    check(
      'transfer_linkage_versions_trial',
      sql`${t.onTrialMonths} IS NULL AND ${t.onTrialStartDate} IS NULL
        OR ${t.onTrialMonths} BETWEEN 1 AND 60 AND (${t.onTrialStartDate} IS NULL OR isfinite(${t.onTrialStartDate}))`,
    ),
    check('transfer_linkage_versions_handover', sql`${t.handover} OR ${t.handoverPersonId} IS NULL`),
    check('transfer_linkage_versions_part_times', sql`cardinality(${t.partTimeRecordIds}) <= 50`),
  ],
);

/** 职责转交计划（`30` DT-R1：下属员工 / 组织角色），每行一个下属或一个组织角色，属于某个联动选项版本。 */
export const transferLinkageDuties = pgTable(
  'transfer_linkage_duties',
  {
    tenantId: tenant(),
    versionId: uuid('version_id').notNull(),
    lineNo: integer('line_no').notNull(),
    itemType: text('item_type').notNull(),
    subordinateId: uuid('subordinate_id'),
    relation: text('relation'),
    orgId: uuid('org_id'),
    orgRole: text('org_role'),
    receiverId: uuid('receiver_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.lineNo] }),
    foreignKey({
      name: 'transfer_linkage_duties_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [transferLinkageVersions.tenantId, transferLinkageVersions.id],
    }),
    foreignKey({
      name: 'transfer_linkage_duties_subordinate_fk',
      columns: [t.tenantId, t.subordinateId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'transfer_linkage_duties_receiver_fk',
      columns: [t.tenantId, t.receiverId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'transfer_linkage_duties_org_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    check('transfer_linkage_duties_line_positive', sql`${t.lineNo} > 0`),
    check(
      'transfer_linkage_duties_shape',
      sql`${t.itemType} = 'duty_subordinate' AND ${t.subordinateId} IS NOT NULL
          AND ${t.relation} IN ('direct', 'dotted') AND ${t.orgId} IS NULL AND ${t.orgRole} IS NULL
        OR ${t.itemType} = 'duty_org_role' AND ${t.orgId} IS NOT NULL
          AND ${t.orgRole} IN ('person_in_charge', 'shop_owner', 'hrbp')
          AND ${t.subordinateId} IS NULL AND ${t.relation} IS NULL`,
    ),
  ],
);

/** 联动执行结果（每张调动单至多一次，DEC-052：整单要么随生效一起落地，要么都不落地）。 */
export const transferLinkageRuns = pgTable(
  'transfer_linkage_runs',
  {
    tenantId: tenant(),
    businessId: uuid('business_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    versionId: uuid('version_id').notNull(),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    beforeContractId: uuid('before_contract_id'),
    afterContractId: uuid('after_contract_id'),
    salaryReminderStatus: text('salary_reminder_status'),
    commandId: text('command_id').notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'transfer_linkage_runs_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [transferLinkageVersions.tenantId, transferLinkageVersions.id],
    }),
    foreignKey({
      name: 'transfer_linkage_runs_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'transfer_linkage_runs_before_contract_fk',
      columns: [t.tenantId, t.beforeContractId],
      foreignColumns: [contractRecords.tenantId, contractRecords.id],
    }),
    foreignKey({
      name: 'transfer_linkage_runs_after_contract_fk',
      columns: [t.tenantId, t.afterContractId],
      foreignColumns: [contractRecords.tenantId, contractRecords.id],
    }),
    check('transfer_linkage_runs_contract', sql`(${t.beforeContractId} IS NULL) = (${t.afterContractId} IS NULL)`),
    check(
      'transfer_linkage_runs_salary',
      sql`${t.salaryReminderStatus} IS NULL OR ${t.salaryReminderStatus} = 'pending'`,
    ),
  ],
);

/**
 * 联动子项（REQ-LNK-001 R3 / DEC-052）：职责转交的每个下属 / 组织角色、每条要结束的兼职。主记录已落地后
 * 子项可以单独失败，记失败原因与次数，经 revision 校验后单独重试。
 */
export const transferLinkageItems = pgTable(
  'transfer_linkage_items',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    lineNo: integer('line_no').notNull(),
    itemType: text('item_type').notNull(),
    subordinateId: uuid('subordinate_id'),
    relation: text('relation'),
    orgId: uuid('org_id'),
    orgRole: text('org_role'),
    receiverId: uuid('receiver_id'),
    partTimeRecordId: uuid('part_time_record_id'),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    failureRule: text('failure_rule'),
    revision: integer('revision').notNull().default(1),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    createdAt: utc(),
  },
  (t) => [
    unique('transfer_linkage_items_tenant_id').on(t.tenantId, t.id),
    unique('transfer_linkage_items_line').on(t.tenantId, t.businessId, t.lineNo),
    foreignKey({
      name: 'transfer_linkage_items_run_fk',
      columns: [t.tenantId, t.businessId],
      foreignColumns: [transferLinkageRuns.tenantId, transferLinkageRuns.businessId],
    }),
    foreignKey({
      name: 'transfer_linkage_items_subordinate_fk',
      columns: [t.tenantId, t.subordinateId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'transfer_linkage_items_receiver_fk',
      columns: [t.tenantId, t.receiverId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'transfer_linkage_items_org_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    check('transfer_linkage_items_type', sql`${t.itemType} IN ('duty_subordinate', 'duty_org_role', 'part_time_end')`),
    check('transfer_linkage_items_status', sql`${t.status} IN ('pending', 'succeeded', 'failed')`),
    check('transfer_linkage_items_failure', sql`(${t.status} = 'failed') = (${t.failureCode} IS NOT NULL)`),
    check('transfer_linkage_items_counts', sql`${t.attemptCount} >= 0 AND ${t.revision} > 0 AND ${t.lineNo} > 0`),
  ],
);

/** 试岗期信息（`29` PB-R23）：首版只做数据记录与到期跟踪，考核与联动调薪暂缓（`21` §3.5）。 */
export const transferOnTrials = pgTable(
  'transfer_on_trials',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    months: integer('months').notNull(),
    expectedEndDate: date('expected_end_date', { mode: 'string' }).notNull(),
    status: text('status').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('transfer_on_trials_tenant_id').on(t.tenantId, t.id),
    unique('transfer_on_trials_business').on(t.tenantId, t.businessId),
    foreignKey({
      name: 'transfer_on_trials_run_fk',
      columns: [t.tenantId, t.businessId],
      foreignColumns: [transferLinkageRuns.tenantId, transferLinkageRuns.businessId],
    }),
    check('transfer_on_trials_months', sql`${t.months} BETWEEN 1 AND 60`),
    check('transfer_on_trials_dates', sql`${t.expectedEndDate} >= ${t.startDate}`),
    check('transfer_on_trials_status', sql`${t.status} IN ('in_trial')`),
  ],
);

/** 调动交接（`13` §6.2，TransferHandoverV2）：首版只记录交接人与交接状态，交接流程本身不在 R1-T10。 */
export const transferHandovers = pgTable(
  'transfer_handovers',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    handoverPersonId: uuid('handover_person_id'),
    handoverStatus: text('handover_status').notNull(),
    approvalStatus: text('approval_status'),
    createdAt: utc(),
  },
  (t) => [
    unique('transfer_handovers_tenant_id').on(t.tenantId, t.id),
    unique('transfer_handovers_business').on(t.tenantId, t.businessId),
    foreignKey({
      name: 'transfer_handovers_run_fk',
      columns: [t.tenantId, t.businessId],
      foreignColumns: [transferLinkageRuns.tenantId, transferLinkageRuns.businessId],
    }),
    foreignKey({
      name: 'transfer_handovers_person_fk',
      columns: [t.tenantId, t.handoverPersonId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    check('transfer_handovers_status', sql`${t.handoverStatus} IN ('not_started')`),
  ],
);
