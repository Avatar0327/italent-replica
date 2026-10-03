import { NO_SORT_RANKS, sortRankColumns, sortRankJoins, type SortRanks } from './sorting.js';
import { sql, type Tx } from '@italent/db';
import { ageOn, computeTenure, EMPLOYEE_FIELDS, tenantLocalDate, type TenureInterval } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { camel, rows, type PersonnelContext, type Row } from './store.js';

export function employeeJoins(ctx: PersonnelContext, ranks: SortRanks): SQL {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`
    LEFT JOIN LATERAL (SELECT v.* FROM personnel_employee_versions v
      WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id ORDER BY revision DESC LIMIT 1) v ON true
    LEFT JOIN permission_user_person_links u ON u.tenant_id=e.tenant_id AND u.employee_id=e.id
    LEFT JOIN LATERAL (SELECT r.*,COALESCE(p.body,to_jsonb(r)) AS current_fields FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1) p ON true
      WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.start_date<=${asOf}::date
      ORDER BY t.start_date DESC,t.sort_order DESC LIMIT 1) r ON true
    LEFT JOIN LATERAL (SELECT min(entry_date) AS first_entry_date, max(entry_date) AS latest_entry_date
      FROM employment_records c JOIN employment_timeline ct ON ct.tenant_id=c.tenant_id AND ct.record_id=c.id
      WHERE c.tenant_id=e.tenant_id AND c.employee_id=e.id
      AND c.kind IN ('hire','rehire','retire_rehire') AND c.entry_date<=${asOf}::date) cycles ON true
    ${jobJoin('job_level_versions', 'jl', 'level_id', asOf)}
    ${jobJoin('job_grade_versions', 'jg', 'grade_id', asOf)}
    ${jobJoin('job_position_versions', 'jp', 'position_id', asOf)}
    ${jobJoin('job_post_versions', 'jpost', 'post_id', asOf)}
    ${sortRankJoins(ranks)}
  `;
}
function jobJoin(table: string, alias: string, field: string, date: string) {
  return sql`LEFT JOIN LATERAL (SELECT j.* FROM ${sql.identifier(table)} j WHERE j.tenant_id=e.tenant_id
    AND j.object_id=(r.current_fields->>${field})::uuid AND j.start_date<=${date}::date
    ORDER BY j.start_date DESC,j.version_no DESC LIMIT 1) ${sql.identifier(alias)} ON true`;
}
export function employeeAttributes(ranks: SortRanks): SQL {
  return sql`e.code,COALESCE(v.name,e.name) AS employee_name,u.user_id,
  cycles.first_entry_date::text,cycles.latest_entry_date::text,r.entry_date::text,r.last_work_date::text,
  ${sortRankColumns(ranks)},
  jl.level AS level_sort_number,jg.grade AS grade_sort_number,jp.display_order AS position_sort_number`;
}
export function employeeDto(row: Row, ctx: PersonnelContext): Row {
  const profile = (row.profile ?? {}) as Row;
  const dto = camel(profile);
  const attrs = camel(row);
  delete attrs.profile;
  delete attrs.employeeName;
  // TODO(需取证 Q-M0-36)：长整数排序编码的分段宽度及溢出无规格，暂不伪造编码。
  return {
    ...Object.fromEntries(EMPLOYEE_FIELDS.map((f) => [f.code, null])),
    ...dto,
    ...attrs,
    id: row.id,
    name: profile.name ?? row.employee_name,
    displayName: profile.display_name ?? profile.name ?? row.employee_name,
    revision: Number(profile.revision ?? 0),
    orderCode: null,
    age: ageOn(profile.birthday as string | null, tenantLocalDate(ctx.now, ctx.timezone)),
  };
}
export async function readEmployee(tx: Tx, ctx: PersonnelContext, employeeId: string) {
  const [row] = rows(
    await tx.execute(sql`SELECT e.id,${employeeAttributes(NO_SORT_RANKS)},to_jsonb(v) AS profile
    FROM employment_employees e ${employeeJoins(ctx, NO_SORT_RANKS)}
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=${employeeId}::uuid LIMIT 1`),
  );
  if (!row) throw new AppError('NOT_FOUND', '人员不存在');
  return employeeDto(row, ctx);
}
export async function readTenure(tx: Tx, ctx: PersonnelContext, employeeId: string, asOf: string) {
  const intervals = rows<TenureInterval>(
    await tx.execute(sql`
    SELECT t.staff_id AS "staffId", t.start_date::text AS "startDate",
      (CASE WHEN upper_inf(t.valid_during) THEN NULL ELSE upper(t.valid_during)::text END) AS "stopDate",
      COALESCE(p.body,to_jsonb(r))->>'post_id' AS "postId",
      COALESCE(p.body,to_jsonb(r))->>'level_id' AS "levelId",
      COALESCE(p.body,to_jsonb(r))->>'position_id' AS "positionId"
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) p ON true
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid
      AND r.kind NOT IN ('leave','retirement') AND NOT isempty(t.valid_during) AND t.start_date<=${asOf}::date
    ORDER BY t.start_date LIMIT 2001`),
  );
  if (intervals.length > 2000) throw new AppError('PAYLOAD_TOO_LARGE', '任职区间超过单次计算上限');
  // TODO(R1-T08)：调度器按租户业务日期调用此计算；当前按需读取，不伪称已每日刷新。
  return computeTenure(intervals, asOf);
}
