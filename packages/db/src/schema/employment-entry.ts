/**
 * 待入职状态动作日志（R2 BE-2a；34 EN-R8 / R9）：取消入职的原因与说明、改期入职的新旧日期与备注；
 * F-188 增加“编辑”（行内编辑换日期，同样替换记录）。
 * 只追加：取消 / 改期 / 编辑各写一行，不原地改；改期会替换待入职记录（任职记录不可改日期），previous_business_id 串起前后两条。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentBusinessObjects } from './employment.js';
import { tenants } from './tenancy.js';

export const employmentEntryActions = pgTable(
  'employment_entry_actions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    /** 动作之后存活的待入职业务：取消为被取消的业务本身，改期为替换后的新业务。 */
    businessId: uuid('business_id').notNull(),
    previousBusinessId: uuid('previous_business_id'),
    action: text('action').notNull(),
    reasonCode: text('reason_code'),
    remark: text('remark'),
    fromDate: date('from_date', { mode: 'string' }),
    toDate: date('to_date', { mode: 'string' }),
    commandId: text('command_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employment_entry_actions_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'employment_entry_actions_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    index('employment_entry_actions_business').on(t.tenantId, t.businessId, t.createdAt),
    check('employment_entry_actions_action', sql`${t.action} IN ('cancel', 'postpone', 'edit')`),
    check('employment_entry_actions_reason', sql`${t.reasonCode} IS NULL OR btrim(${t.reasonCode}) <> ''`),
    check(
      'employment_entry_actions_postpone_dates',
      sql`${t.action} NOT IN ('postpone', 'edit') OR ${t.toDate} IS NOT NULL`,
    ),
  ],
);

/**
 * 待入职阶段的“是否有试用期”（F-188，DEC-546② R2e8）：跟随待入职记录保存，办理入职时才决定人员状态。
 * 以待入职业务 ID 为键；改期 / 编辑换日期替换记录时在同事务内把值搬到新业务；办理入职、删除后不再保留。
 * 没填过就没有行（读出为 null，DEC-402 不回填）。
 */
export const employmentPendingEntryProbation = pgTable(
  'employment_pending_entry_probation',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    probation: boolean('probation').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'employment_pending_entry_probation_pk', columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'employment_pending_entry_probation_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
  ],
);

/**
 * 任职试用期信息（R2 BE-6a，直接实习转正；补证结论 R2f B41“试用期管理可读回起止日”）：选了“有试用期”的任职记录才有行，
 * 开始 = 转正日（记录生效日）、预计结束按月数算（可手改）。以业务 ID 为键，随记录一次写入、不原地改；记录删除后行仍保留，
 * 读取一律经现存任职记录关联（删掉的记录读不到）。BE-3 的任职试用期字段先合入时改并到 BE-3 的存储，不另留两套（03 协调 10-17）。
 */
export const employmentRecordProbation = pgTable(
  'employment_record_probation',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    months: integer('months').notNull(),
    expectedEndDate: date('expected_end_date', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'employment_record_probation_pk', columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'employment_record_probation_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    check('employment_record_probation_months', sql`${t.months} > 0`),
    check('employment_record_probation_dates', sql`${t.expectedEndDate} >= ${t.startDate}`),
  ],
);

/**
 * 待入职劳动合同（F-194，DEC-550 R2e9 §5 / §7.5）：待入职阶段挂在待入职记录上的“临时合同”，不是合同模块的正式合同
 * （不进 contracts 表、不出现在合同列表）。以待入职业务 ID 为键，记录进入待入职时生成（起始日 = 计划入职日期，终止日为空）；
 * 改期入职同步起始日，行内编辑不动它；改期 / 编辑换日期替换记录时在同事务内搬到新业务；办理入职、删除待入职后清除。
 * 没有行 = 存量待入职（DEC-402 不回填），读出 null。
 */
export const employmentPendingEntryContract = pgTable(
  'employment_pending_entry_contract',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    businessId: uuid('business_id').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'employment_pending_entry_contract_pk', columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'employment_pending_entry_contract_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    check('employment_pending_entry_contract_dates', sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);
