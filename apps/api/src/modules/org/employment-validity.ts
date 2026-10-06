import { sql, type Tx } from '@italent/db';

export interface EmploymentDepartmentDisable {
  readonly name: string;
  readonly disabledOn: string;
}

/**
 * DEC-139 / DEC-150 / DEC-161：当前或开始日之后出现停用 / 失效区间，均不可建立新任职。
 * stop_date 当天仍可用；次日若没有新版本无缝接续，则与 enabled=false 同样开始一个不可用段。
 * 同一生效日以最后一个版本为准，恢复启用不会被该日已覆盖的停用版本误拦；开始日前已恢复的历史停用也不拦。
 * 停用后的更名等版本延续同一次停用，提示日期须取该连续停用段的起日；复启后再次停用重新计日。
 */
export async function employmentDepartmentDisable(
  tx: Tx,
  tenantId: string,
  departmentId: string,
  startDate: string,
): Promise<EmploymentDepartmentDisable | null> {
  const result = await tx.execute(sql`
    WITH versions AS (
      SELECT DISTINCT ON (start_date) name, enabled, start_date, stop_date
      FROM org_versions WHERE tenant_id=${tenantId} AND org_id=${departmentId}::uuid
      ORDER BY start_date, version_no DESC
    ), intervals AS (
      SELECT *, lead(start_date) OVER (ORDER BY start_date) AS next_start FROM versions
    ), boundaries AS (
      SELECT name, enabled, start_date FROM versions
      UNION ALL
      SELECT name, false, stop_date + 1 FROM intervals
      WHERE enabled AND stop_date < '9999-12-31'::date
        AND (next_start IS NULL OR stop_date + 1 < next_start)
    ), transitions AS (
      SELECT *, lag(enabled, 1, true) OVER (ORDER BY start_date) AS previously_enabled
      FROM boundaries
    ), dated AS (
      SELECT name, enabled, start_date,
        max(CASE WHEN NOT enabled AND previously_enabled THEN start_date END)
          OVER (ORDER BY start_date) AS disabled_on
      FROM transitions
    )
    SELECT name, disabled_on::text AS "disabledOn" FROM dated
    WHERE NOT enabled AND (start_date>=${startDate}::date OR start_date=(
      SELECT max(start_date) FROM boundaries WHERE start_date<=${startDate}::date
    )) ORDER BY start_date LIMIT 1
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: EmploymentDepartmentDisable[] }).rows) as
    EmploymentDepartmentDisable[] | undefined;
  return rows?.[0] ?? null;
}
