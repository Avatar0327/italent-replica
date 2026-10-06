import { sql } from 'drizzle-orm';
import {
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects } from './employment.js';
import { tenants } from './tenancy.js';
import { establishmentObjects } from './establishment.js';

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
    withEstablishment: boolean('with_establishment').notNull().default(false),
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

/** DEC-185：每次字段缺失各有独立待办；关闭只能从空到非空，旧待办不复活。 */
export const transferCompletionTodos = pgTable(
  'transfer_completion_todos',
  {
    id: id(),
    tenantId: tenant(),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    fieldCode: text('field_code').notNull(),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    createdAt: utc(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** 升级回填的上一提醒业务日；新一轮待办不继承。 */
    legacyReminderDate: date('legacy_reminder_date', { mode: 'string' }),
  },
  (t) => [
    unique('transfer_completion_todos_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('transfer_completion_todos_open_field')
      .on(t.tenantId, t.employeeId, t.fieldCode)
      .where(sql`${t.closedAt} IS NULL`),
    foreignKey({
      name: 'transfer_completion_todos_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    check('transfer_completion_todos_field', sql`${t.fieldCode} LIKE 'preset:%'`),
  ],
);

/** DEC-181：业务每次实际增减的分配，回退按此记录反向追加编制版本，不依赖可变职位匹配。 */
export const transferEstablishmentAllocations = pgTable(
  'transfer_establishment_allocations',
  {
    id: id(),
    tenantId: tenant(),
    businessId: uuid('business_id').notNull(),
    capacityId: uuid('capacity_id').notNull(),
    positionId: uuid('position_id'),
    localDelta: integer('local_delta').notNull(),
    inclusiveDelta: integer('inclusive_delta').notNull(),
    reservedLocalDelta: integer('reserved_local_delta').notNull(),
    reservedInclusiveDelta: integer('reserved_inclusive_delta').notNull(),
    reversed: boolean('reversed').notNull().default(false),
    createdAt: utc(),
  },
  (t) => [
    foreignKey({
      name: 'transfer_establishment_allocations_business_fk',
      columns: [t.tenantId, t.businessId],
      foreignColumns: [employmentBusinessObjects.tenantId, employmentBusinessObjects.id],
    }),
    foreignKey({
      name: 'transfer_establishment_allocations_capacity_fk',
      columns: [t.tenantId, t.capacityId],
      foreignColumns: [establishmentObjects.tenantId, establishmentObjects.id],
    }),
    check(
      'transfer_establishment_allocations_unit',
      sql`${t.localDelta} BETWEEN -1 AND 1
      AND ${t.inclusiveDelta} BETWEEN -1 AND 1 AND ${t.reservedLocalDelta} BETWEEN -1 AND 1
      AND ${t.reservedInclusiveDelta} BETWEEN -1 AND 1`,
    ),
  ],
);
