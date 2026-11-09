/**
 * 职责转交菜单记录（R2-T09a；DEC-602② / DEC-726 / F-408；规格 `30` §补充“职责转交记录结构”）。
 * 照北森 DutyTransferCommon 的字段口径，但用明确的列代替关键字槽位（AGENTS §7）：组织角色存 org_id + org_role，
 * 下属存 subordinate_id + relation。状态只有 0 未完成 / 1 已完成 / 2 作废 / 3 草稿，没有单独的“待生效”：
 * 指定日期到期前 = 未完成 + 转交时间空 + 带转交日期（F-408）。离职 / 调动内转交仍记在 transfer_linkage_items，
 * 记录页签只读联合，不迁移旧数据。所有行带 tenant_id、FORCE RLS（迁移里 enable_tenant_isolation）。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { orgObjects } from './org.js';
import { tenantMemberships, tenants } from './tenancy.js';

const utc = (name: string) => timestamp(name, { withTimezone: true });

export const dutyTransferRecords = pgTable(
  'duty_transfer_records',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid('employee_id').notNull(),
    /** 清空接收人即撤回：作废记录保留原接收人，便于在“全部”页签回看。离职 / 退休落地清空（来源 2 / 4）的记录没有接收人。 */
    receiverId: uuid('receiver_id'),
    /** 1 组织角色 / 2 下属员工。 */
    dutyType: smallint('duty_type').notNull(),
    orgId: uuid('org_id'),
    orgRole: text('org_role'),
    subordinateId: uuid('subordinate_id'),
    relation: text('relation'),
    dutyDetails: text('duty_details').notNull(),
    /** 0 未完成 / 1 已完成 / 2 作废 / 3 草稿（复刻不写入）。 */
    status: smallint('status').notNull(),
    transferDate: date('transfer_date', { mode: 'string' }).notNull(),
    transferAt: utc('transfer_at'),
    batchId: uuid('batch_id').notNull(),
    /**
     * 1 菜单；2 离职 / 4 退休：落地时仍持有又没有接收人的职责被清空（R2-T09b DT-R5），写一条无接收人的未完成记录。
     * 有接收人的离职 / 调动内转交仍记在联动子项里（3 调动不写本表）。
     */
    source: smallint('source').notNull().default(1),
    /** 菜单操作人；系统清空（来源 2 / 4）没有。 */
    operatorId: uuid('operator_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    failureRule: text('failure_rule'),
    lastAttemptAt: utc('last_attempt_at'),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('duty_transfer_records_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'duty_transfer_records_employee_fk',
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'duty_transfer_records_receiver_fk',
      columns: [t.tenantId, t.receiverId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'duty_transfer_records_subordinate_fk',
      columns: [t.tenantId, t.subordinateId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'duty_transfer_records_org_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    foreignKey({
      name: 'duty_transfer_records_operator_fk',
      columns: [t.tenantId, t.operatorId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    /** 同一被转交人同一职责至多一条待生效菜单记录：再次设置即覆盖（F-408）；清空记录（来源 2 / 4）不参与。 */
    uniqueIndex('duty_transfer_records_one_pending')
      .on(
        t.tenantId,
        t.employeeId,
        sql`COALESCE(${t.orgId}, ${t.subordinateId})`,
        sql`COALESCE(${t.orgRole}, ${t.relation})`,
      )
      .where(sql`${t.status} = 0 AND ${t.source} = 1`),
    index('duty_transfer_records_due').on(t.tenantId, t.status, t.transferDate),
    index('duty_transfer_records_employee').on(t.tenantId, t.employeeId, t.createdAt),
    check('duty_transfer_records_status', sql`${t.status} IN (0, 1, 2, 3)`),
    check('duty_transfer_records_source', sql`${t.source} IN (1, 2, 4)`),
    // 菜单记录必须有接收人和操作人；系统清空记录（来源 2 / 4）必须没有接收人，且只能是未完成
    check(
      'duty_transfer_records_party',
      sql`(${t.source} = 1 AND ${t.receiverId} IS NOT NULL AND ${t.operatorId} IS NOT NULL)
        OR (${t.source} IN (2, 4) AND ${t.receiverId} IS NULL AND ${t.status} = 0)`,
    ),
    check(
      'duty_transfer_records_target',
      sql`(${t.dutyType} = 1 AND ${t.orgId} IS NOT NULL AND ${t.orgRole} IN ('person_in_charge', 'shop_owner', 'hrbp')
        AND ${t.subordinateId} IS NULL AND ${t.relation} IS NULL)
      OR (${t.dutyType} = 2 AND ${t.subordinateId} IS NOT NULL AND ${t.relation} IN ('direct', 'dotted')
        AND ${t.orgId} IS NULL AND ${t.orgRole} IS NULL)`,
    ),
    check('duty_transfer_records_completed', sql`(${t.status} = 1) = (${t.transferAt} IS NOT NULL)`),
    check('duty_transfer_records_counts', sql`${t.attemptCount} >= 0 AND ${t.revision} > 0`),
  ],
);
