import { isUuid, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { businessDate } from './fields.js';
import { checkPage, rowsOf } from './read-model.js';

export interface PositionIncumbent {
  readonly employeeId: string;
  readonly recordId: string;
  readonly staffId: string;
  readonly directManagerId: string | null;
}
/** 写入方（职务模块同步直线经理）还需要员工 revision 与当前部门，用于 409 校验与范围验权。 */
export interface PositionAssignment extends PositionIncumbent {
  readonly employeeRevision: number;
  readonly departmentId: string | null;
}
interface IncumbentQuery {
  readonly tenantId: string;
  readonly positionId: string;
  readonly asOf: string;
  readonly limit?: number;
  readonly offset?: number;
}
const INCUMBENT_COLUMNS = sql`r.employee_id AS "employeeId",r.id AS "recordId",r.staff_id AS "staffId",
  CASE WHEN latest.id IS NULL THEN r.direct_manager_id ELSE latest.direct_manager_id END AS "directManagerId"`;
const ASSIGNMENT_COLUMNS = sql`${INCUMBENT_COLUMNS},
  (SELECT e.revision FROM employment_employees e WHERE e.tenant_id=r.tenant_id AND e.id=r.employee_id)
    AS "employeeRevision",
  CASE WHEN latest.id IS NULL THEN r.department_id ELSE latest.department_id END AS "departmentId"`;

function query(input: IncumbentQuery, columns: SQL = INCUMBENT_COLUMNS) {
  businessDate(input.asOf);
  if (!isUuid(input.tenantId) || !isUuid(input.positionId))
    throw new AppError('VALIDATION_FAILED', '租户与职位标识必须是UUID');
  return sql`
    WITH position_candidates AS (
      SELECT id FROM employment_records
      WHERE tenant_id=${input.tenantId} AND position_id=${input.positionId}
      UNION
      SELECT business_id AS id FROM employment_payload_versions
      WHERE tenant_id=${input.tenantId} AND position_id=${input.positionId} AND is_record_snapshot
    )
    SELECT ${columns}
    FROM position_candidates candidate
    JOIN employment_records r ON r.tenant_id=${input.tenantId} AND r.id=candidate.id
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    LEFT JOIN LATERAL (
      SELECT p.id,p.position_id,p.direct_manager_id,p.department_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id
        AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1
    ) latest ON true
    WHERE t.tenant_id=${input.tenantId} AND t.valid_during @> ${input.asOf}::date
      AND (CASE WHEN latest.id IS NULL THEN r.position_id ELSE latest.position_id END)=${input.positionId}
      AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary'
  `;
}

/**
 * 生效日在职位上的真实任职（主职、生效、非离职 / 退休；Q-M0-15 在岗口径）。职务模块的停用校验（DEC-016）
 * 与职位变更同步直线经理（DEC-011）经 job/employment-port.ts 读取；编制占位尚未接入（R1-T09）。
 */
export async function readPositionIncumbents(tx: Tx, input: IncumbentQuery) {
  const page = { limit: input.limit ?? 50, offset: input.offset ?? 0 };
  checkPage(page);
  const rows = rowsOf<PositionIncumbent>(
    await tx.execute(sql`
    ${query(input)} ORDER BY r.employee_id,r.id LIMIT ${page.limit + 1} OFFSET ${page.offset}
  `),
  );
  return { items: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
}

/** 同 readPositionIncumbents，另带员工 revision 与当前部门；按员工 ID 排序，写入方据此统一取锁顺序。 */
export async function readPositionAssignments(tx: Tx, input: IncumbentQuery) {
  const page = { limit: input.limit ?? 50, offset: input.offset ?? 0 };
  checkPage(page);
  const rows = rowsOf<PositionAssignment>(
    await tx.execute(sql`
    ${query(input, ASSIGNMENT_COLUMNS)} ORDER BY r.employee_id,r.id LIMIT ${page.limit + 1} OFFSET ${page.offset}
  `),
  );
  return {
    items: rows.slice(0, page.limit).map((row) => ({ ...row, employeeRevision: Number(row.employeeRevision) })),
    hasMore: rows.length > page.limit,
  };
}

export async function hasPositionIncumbents(tx: Tx, input: Omit<IncumbentQuery, 'limit' | 'offset'>): Promise<boolean> {
  const [row] = rowsOf<{ exists: boolean }>(await tx.execute(sql`SELECT EXISTS(${query(input)} LIMIT 1) AS exists`));
  return row?.exists ?? false;
}
