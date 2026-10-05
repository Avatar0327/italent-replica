/**
 * 员工循环汇报校验（Q-M0-58 附带取证，`19` §3.1 W-443；照搬原站）：调整直线经理会使员工之间的直线汇报线成环时
 * 拒绝保存，提示原文“存在以下循环汇报，请修改。F1 的直线经理汇报线循环：F1→F2→F1”。
 * 按记录在时间轴上实际生效的区间判断（DEC-108 含同日操作先后；PR #54 P2-B）：汇报链上的其他员工取各自在这段时间内
 * 的任职；被同日在后的记录取代、区间为空的记录，经理当天就不生效，不校验。
 * 原站实测只看到生效日当天的拦截；把有效期内他人已排定的未来任职一并算进来，是复刻为不留下未来成环的数据而加严。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { personnelHooks } from './personnel-hooks.js';
import { rowsOf } from './read-model.js';
import { employmentTimelineNeighbors } from './timeline.js';
import type { EmploymentContext } from './types.js';

/** 汇报链深度的防御性上限；成环的路径不会重复经过同一员工，正常组织远达不到。 */
const MAX_CHAIN_DEPTH = 1000;

export interface ReportingCycle {
  /** 员工 ID：本人 → 新经理 → … → 本人。 */
  readonly path: readonly string[];
  /** 最早成环的日期（不早于被校验记录的生效日）。 */
  readonly from: string;
}

/** 被校验的任职在时间轴上实际生效的区间 [from, to)；to 为空表示其后没有记录。 */
export interface ReportingWindow {
  readonly from: string;
  readonly to: string | null;
}

/** 新记录插在 next 之前时的有效区间；next 与它同日（插在当日操作更晚的记录之前）时为空，返回 null。 */
export function windowBefore(date: string, next: { readonly startDate: string } | undefined): ReportingWindow | null {
  return next?.startDate === date ? null : { from: date, to: next?.startDate ?? null };
}

/**
 * 新记录（新增业务、申请保存时的预检、申请到期落地）插入时间轴后的有效区间。不给 recordId 时按排在当日最后
 * （新的一次操作，DEC-108）；给了按该业务的操作先后定插入点（与落地时 timeline.ts 的规则相同）。
 */
export async function insertedWindow(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  recordId?: string,
): Promise<ReportingWindow | null> {
  return windowBefore(date, (await employmentTimelineNeighbors(tx, ctx, employeeId, date, recordId)).next);
}

/** 时间轴上已有记录的有效区间；被同日在后的记录取代（区间为空）或不在时间轴上时返回 null。 */
export async function recordWindow(tx: Tx, tenantId: string, recordId: string): Promise<ReportingWindow | null> {
  const [row] = rowsOf<{ from: string; to: string | null }>(
    await tx.execute(sql`
      SELECT lower(valid_during)::text AS "from", upper(valid_during)::text AS "to" FROM employment_timeline
      WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid AND NOT isempty(valid_during)
    `),
  );
  return row ? { from: row.from, to: row.to } : null;
}

/** 任职记录的当前直线经理：被向后更新改写过的记录以最新快照为准（与在岗人读取同一口径）。 */
const currentManager = sql`CASE WHEN latest.id IS NULL THEN r.direct_manager_id ELSE latest.direct_manager_id END`;

export async function findReportingCycle(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  managerId: string,
  window: ReportingWindow,
): Promise<ReportingCycle | null> {
  if (managerId === employeeId) return { path: [employeeId, employeeId], from: window.from };
  const [row] = rowsOf<{ path: string[]; from: string }>(
    await tx.execute(sql`
      WITH RECURSIVE chain(employee_id, during, path, depth) AS (
        SELECT ${managerId}::uuid, daterange(${window.from}::date, ${window.to}::date), ARRAY[${employeeId}::uuid], 1
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

/** 直线经理会使本人汇报线成环时 400；提示照搬原站，成环晚于记录生效日时补注起始日。区间为空不校验。 */
export async function assertNoReportingCycle(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  managerId: string | null,
  window: ReportingWindow | null,
): Promise<void> {
  if (!managerId || !window) return;
  const cycle = await findReportingCycle(tx, tenantId, employeeId, managerId, window);
  if (!cycle) return;
  const names = await employeeNames(tx, tenantId, cycle.path);
  const line = cycle.path.map((id) => names.get(id) ?? id).join('→');
  const suffix = cycle.from > window.from ? `（自 ${cycle.from} 起）` : '';
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
