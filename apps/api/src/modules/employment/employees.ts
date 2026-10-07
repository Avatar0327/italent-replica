import { personnelHooks } from './personnel-hooks.js';
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { z } from 'zod';
import {
  EMPLOYEE_STATUS_CODES,
  ENTRY_STATUS_CODES,
  type EmployeeStatusCode,
  type EntryStatusCode,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { assertRevision, auditEmployment, employmentScopePredicate, employmentCreator } from './context.js';
import { businessDate } from './fields.js';
import { checkPage, rowsOf } from './read-model.js';
import type { EmploymentContext, EmploymentScope, PageQuery } from './types.js';

/**
 * 员工概要状态（R1 既有口径），F-022 起由当前生效主职版本的人员状态派生（同一口径，不另判业务类型）：
 * 无当前记录或待入职 → pending；离职 → left；退休 → retired；其余 → employed。
 */
export type EmployeeStatus = 'pending' | 'employed' | 'left' | 'retired';
export interface Employee {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly revision: number;
  readonly status: EmployeeStatus;
  /** 当前生效主职版本的人员状态 / 入职状态；无当前记录为空。 */
  readonly employeeStatus: EmployeeStatusCode | null;
  readonly entryStatus: EntryStatusCode | null;
}
export interface EmployeeFilters {
  readonly status?: EmployeeStatus;
  readonly employeeStatus?: number;
  readonly entryStatus?: number;
  readonly code?: string;
  readonly name?: string;
}
const inputSchema = z
  .object({ code: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200) })
  .strict();

export async function createEmployee(tx: Tx, ctx: EmploymentContext, input: { code: string; name: string }) {
  assertRevision(ctx.expectedRevision, 0);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '员工工号和姓名不合法');
  const [duplicate] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id FROM employment_employees
    WHERE tenant_id=${ctx.tenantId} AND lower(code)=lower(${parsed.data.code}) LIMIT 1
  `),
  );
  if (duplicate) throw new AppError('CONFLICT', '工号在当前租户已存在');
  const id = randomUUID();
  // ON CONFLICT 覆盖并发同工号创建；不捕获已中止事务中的唯一约束异常。
  const inserted = rowsOf<{ id: string }>(
    await tx.execute(sql`
    INSERT INTO employment_employees(id,tenant_id,code,name,created_at)
    VALUES(${id},${ctx.tenantId},${parsed.data.code},${parsed.data.name},${ctx.now.toISOString()})
    ON CONFLICT DO NOTHING RETURNING id
  `),
  );
  if (!inserted.length) throw new AppError('CONFLICT', '工号在当前租户已存在');
  const after: Employee = {
    id,
    ...parsed.data,
    revision: 1,
    status: 'pending',
    employeeStatus: null,
    entryStatus: null,
  };
  await auditEmployment(tx, ctx, 'employment.employee.create', 'employment_employee', id, null, after);
  return after;
}

/** 人员当前姓名（人员信息投影优先）；入职时为新建的全局账号取显示名（DEC-128）。 */
export async function employeeName(tx: Tx, tenantId: string, id: string): Promise<string> {
  const [row] = rowsOf<{ name: string }>(
    await tx.execute(sql`
    SELECT ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name
    FROM employment_employees e WHERE e.tenant_id=${tenantId} AND e.id=${id}::uuid
  `),
  );
  if (!row) throw new AppError('NOT_FOUND', '员工不存在');
  return row.name;
}

function employeeQuery(tenantId: string, asOf: string, scope?: EmploymentScope) {
  businessDate(asOf);
  const predicate = employmentScopePredicate(
    scope,
    sql`e.id`,
    sql`r.department_id`,
    employmentCreator(tenantId, sql`e.id`),
  );
  return sql`
    SELECT e.id,e.code,${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,e.revision,
      CASE WHEN r.id IS NULL OR s.employee_status=1 THEN 'pending' WHEN s.employee_status=8 THEN 'left'
        WHEN s.employee_status=6 THEN 'retired' ELSE 'employed' END AS status,
      s.employee_status::integer AS "employeeStatus",s.entry_status::integer AS "entryStatus"
    FROM employment_employees e
    LEFT JOIN employment_timeline t ON t.tenant_id=e.tenant_id AND t.employee_id=e.id
      AND t.valid_during @> ${asOf}::date
    LEFT JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL employment_record_status(e.tenant_id, r.id) s ON true
    WHERE e.tenant_id=${tenantId} AND ${predicate}
  `;
}

export async function getEmployee(
  tx: Tx,
  tenantId: string,
  id: string,
  asOf: string,
  scope?: EmploymentScope,
): Promise<Employee> {
  if (!z.string().uuid().safeParse(id).success) throw new AppError('NOT_FOUND', '员工不存在');
  const [row] = rowsOf<Employee>(await tx.execute(sql`${employeeQuery(tenantId, asOf, scope)} AND e.id=${id} LIMIT 1`));
  if (!row) throw new AppError('NOT_FOUND', '员工不存在');
  return row;
}

export async function listEmployees(
  tx: Tx,
  tenantId: string,
  asOf: string,
  page: PageQuery,
  filters: EmployeeFilters = {},
  scope?: EmploymentScope,
): Promise<Employee[]> {
  checkPage(page);
  if (filters.status && !['pending', 'employed', 'left', 'retired'].includes(filters.status)) {
    throw new AppError('VALIDATION_FAILED', '员工状态不合法');
  }
  if (filters.employeeStatus !== undefined && !EMPLOYEE_STATUS_CODES.includes(filters.employeeStatus as never))
    throw new AppError('VALIDATION_FAILED', '人员状态不合法');
  if (filters.entryStatus !== undefined && !ENTRY_STATUS_CODES.includes(filters.entryStatus as never))
    throw new AppError('VALIDATION_FAILED', '入职状态不合法');
  return rowsOf<Employee>(
    await tx.execute(sql`
    SELECT * FROM (${employeeQuery(tenantId, asOf, scope)}) employee WHERE true
      ${filters.status ? sql`AND status=${filters.status}` : sql``}
      ${filters.employeeStatus === undefined ? sql`` : sql`AND "employeeStatus"=${filters.employeeStatus}`}
      ${filters.entryStatus === undefined ? sql`` : sql`AND "entryStatus"=${filters.entryStatus}`}
      ${filters.code ? sql`AND lower(code)=lower(${filters.code})` : sql``}
      ${filters.name ? sql`AND name ILIKE ${`%${filters.name}%`}` : sql``}
    ORDER BY id LIMIT ${page.limit} OFFSET ${page.offset}
  `),
  );
}
