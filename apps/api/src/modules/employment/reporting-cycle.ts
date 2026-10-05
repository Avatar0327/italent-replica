/**
 * 员工循环汇报校验（Q-M0-58 附带取证，`19` §3.1 W-443；照搬原站）：调整直线经理会使员工之间的直线汇报线成环时
 * 拒绝保存，提示原文“存在以下循环汇报，请修改。F1 的直线经理汇报线循环：F1→F2→F1”。
 * 按版本判断：自本版本生效日起、至该员工下一条任职开始之前，汇报链上的其他员工取各自在这段时间内的任职。
 * 原站实测只看到生效日当天的拦截；把有效期内他人已排定的未来任职一并算进来，是复刻为不留下未来成环的数据而加严。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { personnelHooks } from './personnel-hooks.js';
import { rowsOf } from './read-model.js';

/** 汇报链深度的防御性上限；成环的路径不会重复经过同一员工，正常组织远达不到。 */
const MAX_CHAIN_DEPTH = 1000;

export interface ReportingCycle {
  /** 员工 ID：本人 → 新经理 → … → 本人。 */
  readonly path: readonly string[];
  /** 最早成环的日期（不早于本版本生效日）。 */
  readonly from: string;
}

/** 任职记录的当前直线经理：被向后更新改写过的记录以最新快照为准（与在岗人读取同一口径）。 */
const currentManager = sql`CASE WHEN latest.id IS NULL THEN r.direct_manager_id ELSE latest.direct_manager_id END`;

export async function findReportingCycle(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  managerId: string,
  effectiveDate: string,
): Promise<ReportingCycle | null> {
  if (managerId === employeeId) return { path: [employeeId, employeeId], from: effectiveDate };
  const [row] = rowsOf<{ path: string[]; from: string }>(
    await tx.execute(sql`
      WITH RECURSIVE chain(employee_id, during, path, depth) AS (
        SELECT ${managerId}::uuid,
          daterange(${effectiveDate}::date, (
            SELECT min(n.start_date) FROM employment_timeline n
            WHERE n.tenant_id=${tenantId} AND n.employee_id=${employeeId}::uuid
              AND n.start_date > ${effectiveDate}::date
          )),
          ARRAY[${employeeId}::uuid], 1
        UNION ALL
        SELECT m.manager_id, c.during * m.valid_during, c.path || c.employee_id, c.depth + 1
        FROM chain c
        JOIN LATERAL (
          SELECT t.valid_during, ${currentManager} AS manager_id
          FROM employment_timeline t
          JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
          LEFT JOIN LATERAL (
            SELECT p.id, p.direct_manager_id FROM employment_payload_versions p
            WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id
              AND p.is_record_snapshot
            ORDER BY p.version_no DESC LIMIT 1
          ) latest ON true
          WHERE t.tenant_id=${tenantId} AND t.employee_id=c.employee_id AND t.valid_during && c.during
            AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary'
        ) m ON m.manager_id IS NOT NULL
        WHERE c.employee_id <> ${employeeId}::uuid AND NOT c.employee_id = ANY(c.path) AND c.depth < ${MAX_CHAIN_DEPTH}
      )
      SELECT (path || employee_id)::text[] AS path, lower(during)::text AS "from" FROM chain
      WHERE employee_id=${employeeId}::uuid ORDER BY lower(during), depth LIMIT 1
    `),
  );
  return row ? { path: row.path, from: row.from } : null;
}

/** 直线经理会使本人汇报线成环时 400；提示照搬原站，成环晚于生效日时补注起始日。 */
export async function assertNoReportingCycle(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  managerId: string | null,
  effectiveDate: string,
): Promise<void> {
  if (!managerId) return;
  const cycle = await findReportingCycle(tx, tenantId, employeeId, managerId, effectiveDate);
  if (!cycle) return;
  const names = await employeeNames(tx, tenantId, cycle.path);
  const line = cycle.path.map((id) => names.get(id) ?? id).join('→');
  const suffix = cycle.from > effectiveDate ? `（自 ${cycle.from} 起）` : '';
  throw new AppError(
    'VALIDATION_FAILED',
    `存在以下循环汇报，请修改。${names.get(employeeId) ?? employeeId} 的直线经理汇报线循环：${line}${suffix}`,
    { reason: 'REPORTING_CYCLE', fields: { directManagerId: '直线经理会形成循环汇报' }, from: cycle.from },
  );
}

async function employeeNames(tx: Tx, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = rowsOf<{ id: string; name: string }>(
    await tx.execute(sql`
      SELECT e.id, ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name
      FROM employment_employees e
      WHERE e.tenant_id=${tenantId} AND e.id = ANY(${`{${[...new Set(ids)].join(',')}}`}::uuid[])
    `),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}
