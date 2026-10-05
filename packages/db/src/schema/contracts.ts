import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';
import { employmentEmployees } from './employment.js';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const strings = (name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);
const master = (name: string) =>
  pgTable(
    name,
    {
      id: id(),
      tenantId: tenantId(),
      code: text('code').notNull(),
      name: text('name').notNull(),
      revision: integer('revision').notNull().default(1),
      enabled: boolean('enabled').notNull().default(true),
    },
    (t) => [unique(`${name}_tenant_id`).on(t.tenantId, t.id), unique(`${name}_code`).on(t.tenantId, t.code)],
  );
export const contractTypes = master('contract_types');
export const contractCompanies = master('contract_companies');
export const contractPortfolios = pgTable(
  'contract_portfolios',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    revision: integer('revision').notNull().default(0),
  },
  (t) => [
    unique('contract_portfolio_employee').on(t.tenantId, t.employeeId),
    foreignKey({
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
  ],
);
const fields = () => ({
  number: text('number').notNull(),
  typeId: uuid('type_id').notNull(),
  companyId: uuid('company_id').notNull(),
  termType: text('term_type').notNull(),
  termMonths: integer('term_months'),
  signingDate: date('signing_date'),
  effectiveDate: date('effective_date').notNull(),
  endDate: date('end_date'),
  actualTerminationDate: date('actual_termination_date'),
  probationStartDate: date('probation_start_date'),
  probationEndDate: date('probation_end_date'),
  probationSalary: numeric('probation_salary'),
  regularSalary: numeric('regular_salary'),
  signingCount: integer('signing_count').notNull(),
  employmentRecordId: uuid('employment_record_id'),
  sourceCode: text('source_code'),
  customFields: jsonb('custom_fields').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
});
export const contractRecords = pgTable(
  'contract_records',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    ...fields(),
    previousContractId: uuid('previous_contract_id'),
    rootContractId: uuid('root_contract_id').notNull(),
    versionNo: integer('version_no').notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull().default('valid'),
    approvalStatus: text('approval_status').notNull().default('effective'),
    deleted: boolean('deleted').notNull().default(false),
    createdBy: uuid('created_by').notNull(),
    createdAt: utc(),
  },
  (t) => [
    unique('contract_records_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('contract_records_number')
      .on(t.tenantId, t.number)
      .where(sql`NOT ${t.deleted} AND ${t.status}<>'void'`),
    foreignKey({
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({ columns: [t.tenantId, t.typeId], foreignColumns: [contractTypes.tenantId, contractTypes.id] }),
    foreignKey({
      columns: [t.tenantId, t.companyId],
      foreignColumns: [contractCompanies.tenantId, contractCompanies.id],
    }),
    index('contract_records_employee').on(t.tenantId, t.employeeId, t.effectiveDate),
    index('contract_records_due').on(t.tenantId, t.endDate),
    check('contract_records_status', sql`${t.status} IN ('valid','terminated','void')`),
    check('contract_records_dates', sql`${t.endDate} IS NULL OR ${t.endDate} > ${t.effectiveDate}`),
    check('contract_records_term', sql`${t.termType} IN ('fixed','indefinite','task')`),
  ],
);
export const contractRequests = pgTable(
  'contract_requests',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    ...fields(),
    operation: text('operation').notNull(),
    mode: text('mode').notNull(),
    targetId: uuid('target_id'),
    targetRevision: integer('target_revision'),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull(),
    resultId: uuid('result_id'),
    createdBy: uuid('created_by').notNull(),
    systemInitiated: boolean('system_initiated').notNull().default(false),
    createdAt: utc(),
  },
  (t) => [
    unique('contract_requests_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({ columns: [t.tenantId, t.targetId], foreignColumns: [contractRecords.tenantId, contractRecords.id] }),
    foreignKey({ columns: [t.tenantId, t.typeId], foreignColumns: [contractTypes.tenantId, contractTypes.id] }),
    foreignKey({
      columns: [t.tenantId, t.companyId],
      foreignColumns: [contractCompanies.tenantId, contractCompanies.id],
    }),
    index('contract_requests_due').on(t.tenantId, t.status, t.effectiveDate),
    check(
      'contract_requests_status',
      sql`${t.status} IN ('in_review','approved','returned','withdrawn','effective','declined')`,
    ),
  ],
);
export const contractChanges = pgTable(
  'contract_changes',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    organizationId: uuid('organization_id'),
    beforeContractId: uuid('before_contract_id').notNull(),
    afterContractId: uuid('after_contract_id').notNull(),
    requestId: uuid('request_id').notNull(),
    createdAt: utc(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.beforeContractId],
      foreignColumns: [contractRecords.tenantId, contractRecords.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.afterContractId],
      foreignColumns: [contractRecords.tenantId, contractRecords.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.requestId],
      foreignColumns: [contractRequests.tenantId, contractRequests.id],
    }),
  ],
);
export const contractSettings = pgTable('contract_settings', {
  tenantId: tenantId().primaryKey(),
  revision: integer('revision').notNull().default(1),
  autoRenew: boolean('auto_renew').notNull().default(false),
  autoTerminate: boolean('auto_terminate').notNull().default(false),
  autoNumber: boolean('auto_number').notNull().default(true),
  accumulateRehire: boolean('accumulate_rehire').notNull().default(true),
  postExitTypeIds: strings('post_exit_type_ids'),
  renewalTypeIds: strings('renewal_type_ids'),
  indefiniteTypeIds: strings('indefinite_type_ids'),
  uniqueFields: strings('unique_fields'),
});
export const contractRenewalRules = pgTable(
  'contract_renewal_rules',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    priority: integer('priority').notNull(),
    revision: integer('revision').notNull().default(1),
    orgIds: strings('org_ids'),
    personIds: strings('person_ids'),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [unique('contract_rules_tenant_id').on(t.tenantId, t.id)],
);
export const contractRenewalDetails = pgTable(
  'contract_renewal_details',
  {
    id: id(),
    tenantId: tenantId(),
    ruleId: uuid('rule_id').notNull(),
    typeId: uuid('type_id').notNull(),
    months: integer('months').notNull(),
    initiatorId: uuid('initiator_id').notNull(),
    daysBefore: integer('days_before').notNull(),
    skipTypeIds: strings('skip_type_ids'),
  },
  (t) => [
    unique('contract_detail_type').on(t.tenantId, t.ruleId, t.typeId),
    foreignKey({
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [contractRenewalRules.tenantId, contractRenewalRules.id],
    }),
    foreignKey({ columns: [t.tenantId, t.typeId], foreignColumns: [contractTypes.tenantId, contractTypes.id] }),
  ],
);
export const contractJobAttempts = pgTable(
  'contract_job_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    objectId: uuid('object_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    error: text('error'),
    commandId: text('command_id').notNull(),
    createdAt: utc(),
  },
  (t) => [index('contract_job_lookup').on(t.tenantId, t.objectId, t.kind)],
);
export const contractOutbox = pgTable('contract_outbox', {
  id: id(),
  tenantId: tenantId(),
  objectId: uuid('object_id').notNull(),
  eventType: text('event_type').notNull(),
  commandId: text('command_id').notNull(),
  payload: jsonb('payload').notNull(),
  state: text('state').notNull().default('pending'),
  createdAt: utc(),
});
