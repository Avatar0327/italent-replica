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
    WITH position_candidates AS (
      SELECT id FROM employment_records
      WHERE tenant_id=${input.tenantId} AND position_id=${input.positionId}
      UNION
      SELECT business_id AS id FROM employment_payload_versions
      WHERE tenant_id=${input.tenantId} AND position_id=${input.positionId} AND is_record_snapshot
    )
    SELECT r.employee_id AS "employeeId",r.id AS "recordId",r.staff_id AS "staffId",
      CASE WHEN latest.id IS NULL THEN r.direct_manager_id ELSE latest.direct_manager_id END AS "directManagerId"
    FROM position_candidates candidate
    JOIN employment_records r ON r.tenant_id=${input.tenantId} AND r.id=candidate.id
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    LEFT JOIN LATERAL (
      SELECT p.id,p.position_id,p.direct_manager_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id
        AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1
    ) latest ON true
    WHERE t.tenant_id=${input.tenantId} AND t.valid_during @> ${input.asOf}::date
      AND (CASE WHEN latest.id IS NULL THEN r.position_id ELSE latest.position_id END)=${input.positionId}
      AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary'
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
