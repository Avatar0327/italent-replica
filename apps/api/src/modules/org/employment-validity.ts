import { sql, type Tx } from '@italent/db';

export interface EmploymentDepartmentDisable {
  readonly name: string;
  readonly disabledOn: string;
}

/**
 * DEC-139 / DEC-150：入职与其他新增任职共用整段校验。当前已停用或开始日之后已有停用版本，均不可建立新任职。
 * 同一生效日以最后一个版本为准，恢复启用不会被该日已覆盖的停用版本误拦；开始日前已恢复的历史停用也不拦。
 */
export async function employmentDepartmentDisable(
  tx: Tx,
  tenantId: string,
  departmentId: string,
  startDate: string,
): Promise<EmploymentDepartmentDisable | null> {
  const result = await tx.execute(sql`
    WITH versions AS (
      SELECT DISTINCT ON (start_date) name, enabled, start_date
      FROM org_versions WHERE tenant_id=${tenantId} AND org_id=${departmentId}::uuid
      ORDER BY start_date, version_no DESC
    )
    SELECT name, start_date::text AS "disabledOn" FROM versions
    WHERE NOT enabled AND (start_date>=${startDate}::date OR start_date=(
      SELECT max(start_date) FROM versions WHERE start_date<=${startDate}::date
    )) ORDER BY start_date LIMIT 1
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: EmploymentDepartmentDisable[] }).rows) as
    EmploymentDepartmentDisable[] | undefined;
  return rows?.[0] ?? null;
}
