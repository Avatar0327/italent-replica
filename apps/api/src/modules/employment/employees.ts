import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { assertRevision, auditEmployment } from './context.js';
import { businessDate } from './fields.js';
import { checkPage, rowsOf } from './read-model.js';
import type { EmploymentContext, PageQuery } from './types.js';

export type EmployeeStatus = 'pending' | 'employed' | 'left' | 'retired';
export interface Employee {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly revision: number;
  readonly status: EmployeeStatus;
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
  const after: Employee = { id, ...parsed.data, revision: 1, status: 'pending' };
  await auditEmployment(tx, ctx, 'employment.employee.create', 'employment_employee', id, null, after);
  return after;
}

function employeeQuery(tenantId: string, asOf: string) {
  businessDate(asOf);
  return sql`
    SELECT e.id,e.code,e.name,e.revision,
      CASE WHEN r.id IS NULL THEN 'pending' WHEN r.kind='leave' THEN 'left'
        WHEN r.kind='retirement' THEN 'retired' ELSE 'employed' END AS status
    FROM employment_employees e
    LEFT JOIN employment_timeline t ON t.tenant_id=e.tenant_id AND t.employee_id=e.id
      AND t.valid_during @> ${asOf}::date
    LEFT JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE e.tenant_id=${tenantId}
  `;
}

export async function getEmployee(tx: Tx, tenantId: string, id: string, asOf: string): Promise<Employee> {
  if (!z.string().uuid().safeParse(id).success) throw new AppError('NOT_FOUND', '员工不存在');
  const [row] = rowsOf<Employee>(await tx.execute(sql`${employeeQuery(tenantId, asOf)} AND e.id=${id} LIMIT 1`));
  if (!row) throw new AppError('NOT_FOUND', '员工不存在');
  return row;
}

export async function listEmployees(
  tx: Tx,
  tenantId: string,
  asOf: string,
  page: PageQuery,
  filters: { status?: EmployeeStatus; code?: string; name?: string } = {},
): Promise<Employee[]> {
  checkPage(page);
  if (filters.status && !['pending', 'employed', 'left', 'retired'].includes(filters.status)) {
    throw new AppError('VALIDATION_FAILED', '员工状态不合法');
  }
  return rowsOf<Employee>(
    await tx.execute(sql`
    SELECT * FROM (${employeeQuery(tenantId, asOf)}) employee WHERE true
      ${filters.status ? sql`AND status=${filters.status}` : sql``}
      ${filters.code ? sql`AND lower(code)=lower(${filters.code})` : sql``}
      ${filters.name ? sql`AND name ILIKE ${`%${filters.name}%`}` : sql``}
    ORDER BY id LIMIT ${page.limit} OFFSET ${page.offset}
  `),
  );
}
