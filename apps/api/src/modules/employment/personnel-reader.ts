import { isUuid, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { businessDate } from './fields.js';
import { checkPage, rowsOf } from './read-model.js';

export interface PositionIncumbent {
  readonly employeeId: string;
  readonly recordId: string;
  readonly staffId: string;
  readonly directManagerId: string | null;
}
interface IncumbentQuery {
  readonly tenantId: string;
  readonly positionId: string;
  readonly asOf: string;
  readonly limit?: number;
  readonly offset?: number;
}
function query(input: IncumbentQuery) {
  businessDate(input.asOf);
  if (!isUuid(input.tenantId) || !isUuid(input.positionId))
    throw new AppError('VALIDATION_FAILED', '租户与职位标识必须是UUID');
  return sql`
    SELECT r.employee_id AS "employeeId",r.id AS "recordId",r.staff_id AS "staffId",
      r.direct_manager_id AS "directManagerId"
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${input.tenantId} AND t.valid_during @> ${input.asOf}::date
      AND r.position_id=${input.positionId} AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary'
  `;
}

/** TODO(R1-T04 接入)：只提供真实任职投影读取，不修改既有职位/编制占位行为（DEC-074）。 */
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

export async function hasPositionIncumbents(tx: Tx, input: Omit<IncumbentQuery, 'limit' | 'offset'>): Promise<boolean> {
  const [row] = rowsOf<{ exists: boolean }>(await tx.execute(sql`SELECT EXISTS(${query(input)} LIMIT 1) AS exists`));
  return row?.exists ?? false;
}
