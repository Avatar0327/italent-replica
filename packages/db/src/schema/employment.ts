/**
 * 任职业务的不可变快照与独立日期投影（R1-T05；07 §1–3、15 §1–2）。
 * 草稿、审批事件和生效记录分开保存；当前状态按租户业务日期从投影派生。
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
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import {
  jobGradeObjects,
  jobLevelObjects,
  jobPositionObjects,
  jobPostObjects,
  jobProfessionalLineObjects,
  jobSequenceObjects,
} from './job.js';
import { orgObjects } from './org.js';
import { tenants, users } from './tenancy.js';
import { daterange } from './types.js';

type CustomValues = Record<string, string | number | boolean | null>;
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const day = (name: string) => date(name, { mode: 'string' });
const customFields = () => jsonb('custom_fields').$type<CustomValues>().notNull().default({});

interface TargetColumns {
  readonly tenantId: AnyPgColumn;
  readonly id: AnyPgColumn;
}

function reference(name: string, tenant: AnyPgColumn, targetId: AnyPgColumn, target: TargetColumns) {
  return foreignKey({ name, columns: [tenant, targetId], foreignColumns: [target.tenantId, target.id] });
}

export const employmentEmployees = pgTable(
  'employment_employees',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_employees_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('employment_employees_tenant_code').on(t.tenantId, sql`lower(${t.code})`),
    index('employment_employees_tenant_created').on(t.tenantId, t.createdAt, t.id),
    check('employment_employees_revision_positive', sql`${t.revision} > 0`),
    check('employment_employees_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('employment_employees_name_nonempty', sql`btrim(${t.name}) <> ''`),
  ],
);

export const employmentCycles = pgTable(
  'employment_cycles',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    entryDate: day('entry_date').notNull(),
    entryType: text('entry_type').notNull(),
    employType: text('employ_type').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_cycles_tenant_id').on(t.tenantId, t.id),
    unique('employment_cycles_employee_id').on(t.tenantId, t.employeeId, t.id),
    unique('employment_cycles_employee_entry').on(t.tenantId, t.employeeId, t.id, t.entryDate),
    reference('employment_cycles_employee_fk', t.tenantId, t.employeeId, employmentEmployees),
    index('employment_cycles_employee_date').on(t.tenantId, t.employeeId, t.entryDate, t.id),
    check('employment_cycles_entry_type', sql`${t.entryType} IN ('hire', 'rehire', 'retire_rehire')`),
    check('employment_cycles_employ_type', sql`${t.employType} IN ('internal', 'intern', 'external')`),
    check('employment_cycles_entry_finite', sql`isfinite(${t.entryDate})`),
  ],
);

export const employmentBusinessObjects = pgTable(
  'employment_business_objects',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_business_objects_tenant_id').on(t.tenantId, t.id),
    unique('employment_business_objects_employee_id').on(t.tenantId, t.employeeId, t.id),
    reference('employment_business_objects_employee_fk', t.tenantId, t.employeeId, employmentEmployees),
    index('employment_business_objects_employee_created').on(t.tenantId, t.employeeId, t.createdAt, t.id),
    check('employment_business_objects_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** 预置字段显式存列；仅自定义字段值和服务端表单元数据使用 JSON。 */
function presetFields() {
  return {
    departmentId: uuid('department_id'),
    positionId: uuid('position_id'),
    postId: uuid('post_id'),
    levelId: uuid('level_id'),
    gradeId: uuid('grade_id'),
    place: text('place'),
    directManagerId: uuid('direct_manager_id'),
    dottedManagerId: uuid('dotted_manager_id'),
    employmentType: text('employment_type'),
    employType: text('employ_type'),
    employmentSource: text('employment_source'),
    employmentForm: text('employment_form'),
    sequenceId: uuid('sequence_id'),
    professionalLineId: uuid('professional_line_id'),
    isKeyPerson: boolean('is_key_person'),
    dimension1: text('dimension1'),
    dimension2: text('dimension2'),
    dimension3: text('dimension3'),
    dimension4: text('dimension4'),
    dimension5: text('dimension5'),
    jobNumber: text('job_number'),
    remarks: text('remarks'),
    isDepartmentHead: boolean('is_department_head'),
  };
}

interface PresetColumns {
  readonly tenantId: AnyPgColumn;
  readonly departmentId: AnyPgColumn;
  readonly positionId: AnyPgColumn;
  readonly postId: AnyPgColumn;
  readonly levelId: AnyPgColumn;
  readonly gradeId: AnyPgColumn;
  readonly directManagerId: AnyPgColumn;
  readonly dottedManagerId: AnyPgColumn;
  readonly sequenceId: AnyPgColumn;
  readonly professionalLineId: AnyPgColumn;
  readonly employType: AnyPgColumn;
  readonly customFields: AnyPgColumn;
}

function presetRules(name: string, t: PresetColumns): PgTableExtraConfigValue[] {
  return [
    reference(`${name}_department_fk`, t.tenantId, t.departmentId, orgObjects),
    reference(`${name}_position_fk`, t.tenantId, t.positionId, jobPositionObjects),
    reference(`${name}_post_fk`, t.tenantId, t.postId, jobPostObjects),
    reference(`${name}_level_fk`, t.tenantId, t.levelId, jobLevelObjects),
    reference(`${name}_grade_fk`, t.tenantId, t.gradeId, jobGradeObjects),
    reference(`${name}_direct_manager_fk`, t.tenantId, t.directManagerId, employmentEmployees),
    reference(`${name}_dotted_manager_fk`, t.tenantId, t.dottedManagerId, employmentEmployees),
    reference(`${name}_sequence_fk`, t.tenantId, t.sequenceId, jobSequenceObjects),
    reference(`${name}_professional_line_fk`, t.tenantId, t.professionalLineId, jobProfessionalLineObjects),
    check(`${name}_employ_type`, sql`${t.employType} IN ('internal', 'intern', 'external')`),
    check(`${name}_custom_object`, sql`jsonb_typeof(${t.customFields}) = 'object'`),
  ];
}

function kindRule(name: string, kind: AnyPgColumn) {
  return check(
    name,
    sql`${kind} IN ('hire', 'rehire', 'retire_rehire', 'regularization', 'transfer',
      'org_adjustment', 'leave', 'retirement', 'intern_regularization')`,
  );
}

export const employmentPayloadVersions = pgTable(
  'employment_payload_versions',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    commandId: text('command_id'),
    triggerBusinessId: uuid('trigger_business_id'),
    isRecordSnapshot: boolean('is_record_snapshot').notNull().default(false),
    kind: text('kind').notNull(),
    mode: text('mode').notNull(),
    effectiveDate: day('effective_date').notNull(),
    lastWorkDate: day('last_work_date'),
    formId: text('form_id').notNull(),
    selectedStaffId: uuid('selected_staff_id'),
    sourceRecordId: uuid('source_record_id'),
    sourceStaffId: uuid('source_staff_id'),
    ...presetFields(),
    customFields: customFields(),
    deferredFieldCodes: text('deferred_field_codes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    explicitFieldCodes: text('explicit_field_codes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    formSnapshot: jsonb('form_snapshot').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: utc(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('employment_payload_versions_tenant_id').on(t.tenantId, t.id),
    unique('employment_payload_versions_employee_id').on(t.tenantId, t.employeeId, t.id),
    unique('employment_payload_versions_business_id').on(t.tenantId, t.employeeId, t.businessId, t.id),
    unique('employment_payload_versions_business_version').on(t.tenantId, t.businessId, t.versionNo),
    index('employment_payload_versions_cycle_date').on(
      t.tenantId,
      t.employeeId,
      t.selectedStaffId,
      t.effectiveDate,
      t.businessId,
      t.versionNo,
    ),
    index('employment_payload_versions_snapshot_position')
      .on(t.tenantId, t.positionId, t.businessId, t.versionNo)
      .where(sql`${t.isRecordSnapshot}`),
    index('employment_payload_versions_latest_snapshot')
      .on(t.tenantId, t.businessId, t.versionNo.desc())
      .where(sql`${t.isRecordSnapshot}`),
    foreignKey({
      name: 'employment_payload_versions_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'employment_payload_versions_previous_fk',
      columns: [t.tenantId, t.employeeId, t.businessId, t.previousVersionId],
      foreignColumns: [t.tenantId, t.employeeId, t.businessId, t.id],
    }),
    foreignKey({
      name: 'employment_payload_versions_trigger_business_fk',
      columns: [t.tenantId, t.employeeId, t.triggerBusinessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'employment_payload_versions_selected_cycle_fk',
      columns: [t.tenantId, t.employeeId, t.selectedStaffId],
      foreignColumns: [employmentCycles.tenantId, employmentCycles.employeeId, employmentCycles.id],
    }),
    foreignKey({
      name: 'employment_payload_versions_source_fk',
      columns: [t.tenantId, t.employeeId, t.sourceRecordId, t.sourceStaffId],
      foreignColumns: [
        employmentRecords.tenantId,
        employmentRecords.employeeId,
        employmentRecords.id,
        employmentRecords.staffId,
      ],
    }),
    ...presetRules('employment_payload_versions', t),
    kindRule('employment_payload_versions_kind', t.kind),
    check('employment_payload_versions_version_positive', sql`${t.versionNo} > 0`),
    check('employment_payload_versions_previous_not_self', sql`${t.previousVersionId} <> ${t.id}`),
    check('employment_payload_versions_command_pair', sql`(${t.commandId} IS NULL) = (${t.triggerBusinessId} IS NULL)`),
    check('employment_payload_versions_snapshot_command', sql`NOT ${t.isRecordSnapshot} OR ${t.commandId} IS NOT NULL`),
    check('employment_payload_versions_command_nonempty', sql`${t.commandId} IS NULL OR btrim(${t.commandId}) <> ''`),
    check('employment_payload_versions_mode', sql`${t.mode} IN ('direct', 'application')`),
    check('employment_payload_versions_form_nonempty', sql`btrim(${t.formId}) <> ''`),
    check('employment_payload_versions_source_pair', sql`(${t.sourceRecordId} IS NULL) = (${t.sourceStaffId} IS NULL)`),
    check('employment_payload_versions_form_object', sql`jsonb_typeof(${t.formSnapshot}) = 'object'`),
    check('employment_payload_versions_date_finite', sql`isfinite(${t.effectiveDate})`),
  ],
);

export const employmentStateEvents = pgTable(
  'employment_state_events',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    payloadVersionId: uuid('payload_version_id').notNull(),
    state: text('state').notNull(),
    eventNo: integer('event_no').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_state_events_tenant_id').on(t.tenantId, t.id),
    unique('employment_state_events_business_number').on(t.tenantId, t.businessId, t.eventNo),
    foreignKey({
      name: 'employment_state_events_payload_fk',
      columns: [t.tenantId, t.employeeId, t.businessId, t.payloadVersionId],
      foreignColumns: [
        employmentPayloadVersions.tenantId,
        employmentPayloadVersions.employeeId,
        employmentPayloadVersions.businessId,
        employmentPayloadVersions.id,
      ],
    }),
    // R1-T08：定时任务只扫描审批通过的申请（再判断是否仍是最新状态），避免逐租户全表扫描
    index('employment_state_events_approved')
      .on(t.tenantId, t.businessId, t.eventNo)
      .where(sql`${t.state} = 'approved'`),
    check('employment_state_events_number_positive', sql`${t.eventNo} > 0`),
    check(
      'employment_state_events_state',
      sql`${t.state} IN ('draft', 'in_review', 'approved', 'rejected', 'effective', 'deleted')`,
    ),
    check('employment_state_events_command_nonempty', sql`btrim(${t.commandId}) <> ''`),
  ],
);

export const employmentRecords = pgTable(
  'employment_records',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    payloadVersionId: uuid('payload_version_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    entryDate: day('entry_date').notNull(),
    kind: text('kind').notNull(),
    startDate: day('start_date').notNull(),
    lastWorkDate: day('last_work_date'),
    serviceType: text('service_type').notNull().default('primary'),
    isInserted: boolean('is_inserted').notNull().default(false),
    inheritanceSourceId: uuid('inheritance_source_id'),
    ...presetFields(),
    employType: text('employ_type').notNull(),
    customFields: customFields(),
    createdAt: utc(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('employment_records_tenant_id').on(t.tenantId, t.id),
    unique('employment_records_employee_id').on(t.tenantId, t.employeeId, t.id),
    unique('employment_records_employee_staff').on(t.tenantId, t.employeeId, t.id, t.staffId),
    unique('employment_records_employee_start_id').on(t.tenantId, t.employeeId, t.id, t.startDate),
    index('employment_records_position_start').on(t.tenantId, t.positionId, t.startDate, t.employeeId),
    foreignKey({
      name: 'employment_records_payload_fk',
      columns: [t.tenantId, t.employeeId, t.id, t.payloadVersionId],
      foreignColumns: [
        employmentPayloadVersions.tenantId,
        employmentPayloadVersions.employeeId,
        employmentPayloadVersions.businessId,
        employmentPayloadVersions.id,
      ],
    }),
    foreignKey({
      name: 'employment_records_cycle_fk',
      columns: [t.tenantId, t.employeeId, t.staffId, t.entryDate],
      foreignColumns: [
        employmentCycles.tenantId,
        employmentCycles.employeeId,
        employmentCycles.id,
        employmentCycles.entryDate,
      ],
    }),
    foreignKey({
      name: 'employment_records_inheritance_source_fk',
      columns: [t.tenantId, t.employeeId, t.inheritanceSourceId],
      foreignColumns: [t.tenantId, t.employeeId, t.id],
    }),
    ...presetRules('employment_records', t),
    kindRule('employment_records_kind', t.kind),
    check('employment_records_primary_only', sql`${t.serviceType} = 'primary'`),
    check('employment_records_start_valid', sql`isfinite(${t.startDate}) AND ${t.startDate} >= ${t.entryDate}`),
    check('employment_records_source_not_self', sql`${t.inheritanceSourceId} <> ${t.id}`),
  ],
);

function recordReference(name: string, tenant: AnyPgColumn, employee: AnyPgColumn, record: AnyPgColumn) {
  return foreignKey({
    name,
    columns: [tenant, employee, record],
    foreignColumns: [employmentRecords.tenantId, employmentRecords.employeeId, employmentRecords.id],
  });
}

export const employmentRecordTombstones = pgTable(
  'employment_record_tombstones',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    recordId: uuid('record_id').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_record_tombstones_tenant_id').on(t.tenantId, t.id),
    unique('employment_record_tombstones_record').on(t.tenantId, t.recordId),
    recordReference('employment_record_tombstones_record_fk', t.tenantId, t.employeeId, t.recordId),
  ],
);

/** 可重排的日期元数据；EXCLUDE 与延迟连续覆盖检查由配套 SQL 迁移提供。 */
export const employmentTimeline = pgTable(
  'employment_timeline',
  {
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    recordId: uuid('record_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(1),
    startDate: day('start_date').notNull(),
    validDuring: daterange('valid_during').notNull(),
    createdAt: utc(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.recordId] }),
    foreignKey({
      name: 'employment_timeline_record_fk',
      columns: [t.tenantId, t.employeeId, t.recordId, t.staffId],
      foreignColumns: [
        employmentRecords.tenantId,
        employmentRecords.employeeId,
        employmentRecords.id,
        employmentRecords.staffId,
      ],
    }),
    unique('employment_timeline_cycle_start').on(t.tenantId, t.employeeId, t.staffId, t.startDate),
    index('employment_timeline_employee_start').on(t.tenantId, t.employeeId, t.startDate, t.sortOrder),
    check(
      'employment_timeline_lower_matches',
      sql`isempty(${t.validDuring}) OR (NOT lower_inf(${t.validDuring})
        AND lower(${t.validDuring}) = ${t.startDate})`,
    ),
    check('employment_timeline_sort_order', sql`${t.sortOrder} IN (0, 1)`),
  ],
);

export const employmentOutbox = pgTable(
  'employment_outbox',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id'),
    businessId: uuid('business_id'),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    state: text('state').notNull().default('pending'),
    commandId: text('command_id').notNull(),
    payloadVersionId: uuid('payload_version_id'),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_outbox_tenant_id').on(t.tenantId, t.id),
    unique('employment_outbox_command_event').on(t.tenantId, t.commandId, t.eventType, t.objectId, t.payloadVersionId),
    reference('employment_outbox_employee_fk', t.tenantId, t.employeeId, employmentEmployees),
    reference('employment_outbox_business_fk', t.tenantId, t.businessId, employmentBusinessObjects),
    foreignKey({
      name: 'employment_outbox_employee_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    index('employment_outbox_tenant_created').on(t.tenantId, t.createdAt, t.id),
    index('employment_outbox_employee_created').on(t.tenantId, t.employeeId, t.createdAt),
    index('employment_outbox_business_created').on(t.tenantId, t.businessId, t.createdAt),
    check('employment_outbox_object_nonempty', sql`btrim(${t.objectType}) <> ''`),
    check('employment_outbox_event_nonempty', sql`btrim(${t.eventType}) <> ''`),
    check('employment_outbox_payload_object', sql`jsonb_typeof(${t.payload}) = 'object'`),
    check('employment_outbox_state', sql`${t.state} IN ('pending', 'sent', 'failed', 'unknown')`),
  ],
);

export const employmentOutboxAttempts = pgTable(
  'employment_outbox_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    outboxId: uuid('outbox_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    state: text('state').notNull().default('pending'),
    errorReason: text('error_reason'),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_outbox_attempts_tenant_id').on(t.tenantId, t.id),
    unique('employment_outbox_attempts_number').on(t.tenantId, t.outboxId, t.attemptNo),
    foreignKey({
      name: 'employment_outbox_attempts_outbox_fk',
      columns: [t.tenantId, t.outboxId],
      foreignColumns: [employmentOutbox.tenantId, employmentOutbox.id],
    }),
    index('employment_outbox_attempts_pending').on(t.tenantId, t.state, t.createdAt),
    check('employment_outbox_attempts_number_positive', sql`${t.attemptNo} > 0`),
    check('employment_outbox_attempts_state', sql`${t.state} IN ('pending', 'sent', 'failed', 'unknown')`),
  ],
);

export const employmentCustomFieldObjects = pgTable(
  'employment_custom_field_objects',
  {
    id: id(),
    tenantId: tenantId(),
    revision: integer('revision').notNull().default(1),
    objectType: text('object_type').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    valueType: text('value_type').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_custom_field_objects_tenant_id').on(t.tenantId, t.id),
    unique('employment_custom_field_objects_tenant_code').on(t.tenantId, t.code),
    index('employment_custom_field_objects_tenant_type').on(t.tenantId, t.objectType, t.id),
    check('employment_custom_field_objects_revision_positive', sql`${t.revision} > 0`),
    check('employment_custom_field_objects_object_type', sql`${t.objectType} IN ('employment', 'contract')`),
    check(
      'employment_custom_field_objects_value_type',
      sql`${t.valueType} IN ('text', 'integer', 'decimal', 'boolean', 'date')`,
    ),
    check('employment_custom_field_objects_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('employment_custom_field_objects_name_nonempty', sql`btrim(${t.name}) <> ''`),
  ],
);

export const employmentCustomFieldInheritanceVersions = pgTable(
  'employment_custom_field_inheritance_versions',
  {
    id: id(),
    tenantId: tenantId(),
    fieldId: uuid('field_id').notNull(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    inherit: boolean('inherit').notNull().default(true),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_custom_field_inheritance_versions_tenant_id').on(t.tenantId, t.id),
    unique('employment_custom_field_inheritance_versions_field_id').on(t.tenantId, t.fieldId, t.id),
    unique('employment_custom_field_inheritance_versions_number').on(t.tenantId, t.fieldId, t.versionNo),
    reference(
      'employment_custom_field_inheritance_versions_field_fk',
      t.tenantId,
      t.fieldId,
      employmentCustomFieldObjects,
    ),
    foreignKey({
      name: 'employment_custom_field_inheritance_versions_previous_fk',
      columns: [t.tenantId, t.fieldId, t.previousVersionId],
      foreignColumns: [t.tenantId, t.fieldId, t.id],
    }),
    check('employment_custom_field_inheritance_versions_positive', sql`${t.versionNo} > 0`),
    check('employment_custom_field_inheritance_versions_not_self', sql`${t.previousVersionId} <> ${t.id}`),
  ],
);

export const employmentSettings = pgTable(
  'employment_settings',
  {
    tenantId: tenantId().primaryKey(),
    revision: integer('revision').notNull().default(0),
    createdAt: utc(),
  },
  (t) => [check('employment_settings_revision_nonnegative', sql`${t.revision} >= 0`)],
);

export const employmentSettingVersions = pgTable(
  'employment_setting_versions',
  {
    id: id(),
    tenantId: tenantId(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    allowDirectTransfer: boolean('allow_direct_transfer').notNull().default(true),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_setting_versions_tenant_id').on(t.tenantId, t.id),
    unique('employment_setting_versions_number').on(t.tenantId, t.versionNo),
    foreignKey({
      name: 'employment_setting_versions_settings_fk',
      columns: [t.tenantId],
      foreignColumns: [employmentSettings.tenantId],
    }),
    foreignKey({
      name: 'employment_setting_versions_previous_fk',
      columns: [t.tenantId, t.previousVersionId],
      foreignColumns: [t.tenantId, t.id],
    }),
    check('employment_setting_versions_positive', sql`${t.versionNo} > 0`),
    check('employment_setting_versions_not_self', sql`${t.previousVersionId} <> ${t.id}`),
  ],
);

/**
 * 定时生效尝试（R1-T08；DEC-052 失败分支、DEC-112 挂起）：只追加，一条记一次生效尝试的结果。
 * 申请单仍停在「审批通过」（DEC-125），本表不替代状态事件：failed 次数 = outcome='failed' 的条数，
 * 生效失败待办 = 仍为审批通过且最近一次尝试为 failed；suspended 记“因前序业务失败挂起”及挂在哪一条之后。
 */
export const employmentActivationAttempts = pgTable(
  'employment_activation_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    blockedByBusinessId: uuid('blocked_by_business_id'),
    // 尝试当天的租户业务日（DEC-056）；created_at 是 UTC 瞬时
    businessDate: day('business_date').notNull(),
    trigger: text('trigger').notNull(),
    // 定时任务为空（系统），HR 重试为操作人
    actorUserId: uuid('actor_user_id').references(() => users.id),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('employment_activation_attempts_tenant_id').on(t.tenantId, t.id),
    unique('employment_activation_attempts_number').on(t.tenantId, t.businessId, t.attemptNo),
    foreignKey({
      name: 'employment_activation_attempts_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'employment_activation_attempts_blocked_by_fk',
      columns: [t.tenantId, t.employeeId, t.blockedByBusinessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    index('employment_activation_attempts_employee').on(t.tenantId, t.employeeId, t.businessId),
    check('employment_activation_attempts_number_positive', sql`${t.attemptNo} > 0`),
    check('employment_activation_attempts_outcome', sql`${t.outcome} IN ('effective', 'failed', 'suspended')`),
    check(
      'employment_activation_attempts_reason',
      sql`(${t.outcome} = 'effective') = (${t.reason} IS NULL)
        AND (${t.outcome} = 'suspended') = (${t.blockedByBusinessId} IS NOT NULL)`,
    ),
    check('employment_activation_attempts_trigger', sql`${t.trigger} IN ('scheduler', 'retry', 'approval')`),
    check('employment_activation_attempts_detail_object', sql`jsonb_typeof(${t.detail}) = 'object'`),
    check('employment_activation_attempts_command_nonempty', sql`btrim(${t.commandId}) <> ''`),
  ],
);
