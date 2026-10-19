/**
 * R2-T04 退休：薄扩展行（docs/08_设计/R2-T04_退休设计.md §2.2）。退休本体是任职业务 kind='retirement'，
 * 离职机制（exit_requests）整套复用；这里只放退休特有的快照与派生值，与 exit_requests 1:1。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { exitRequests } from './exit.js';

export const retirementRequests = pgTable(
  'retirement_requests',
  {
    tenantId: uuid('tenant_id').notNull(),
    businessId: uuid('business_id').notNull(),
    /** 冗余：范围谓词与审计。 */
    employeeId: uuid('employee_id').notNull(),
    /** 创建时快照的人员“预计退休日期”P（派生依据，不随后续重算变化，DEC-638 A-3）。 */
    expectedRetirementDate: date('expected_retirement_date', { mode: 'string' }),
    /** early / normal / delayed，由最后工作日 L 与快照 P 派生；不可手改，系统顺延改变 L 时按快照 P 重派生。 */
    retireType: text('retire_type'),
    /** 是否同时返聘（规格 IsReEmployed）；5a 期间恒为 false，5b 开放。 */
    reEmployed: boolean('re_employed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.businessId] }),
    foreignKey({
      name: 'retirement_requests_exit_fk',
      columns: [t.tenantId, t.businessId],
      foreignColumns: [exitRequests.tenantId, exitRequests.businessId],
    }),
    index('retirement_requests_employee').on(t.tenantId, t.employeeId),
    check(
      'retirement_requests_type',
      sql`${t.retireType} IS NULL OR ${t.retireType} IN ('early', 'normal', 'delayed')`,
    ),
    // 类型只在有 P 快照时存在
    check(
      'retirement_requests_type_needs_expected',
      sql`${t.retireType} IS NULL OR ${t.expectedRetirementDate} IS NOT NULL`,
    ),
  ],
);
