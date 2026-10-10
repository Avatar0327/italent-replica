/**
 * 继任者候选搜索（设计 §2.2 #3a，DEC-308）：全租户在职人员按姓名 / 邮箱关键词搜索，**不按操作人的员工范围裁剪**
 * （继任者可以是范围外的人）；含待入职，排除调出 4 / 退休 6 / 离职 8；最多 30 条，按姓名稳定排序。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from './read-sql.js';

export const CANDIDATE_MAX = 30;
export const CANDIDATE_DEFAULT = 10;

export interface Candidate {
  readonly employeeId: string;
  readonly name: string;
  readonly email: string | null;
  /** 人员状态（§4.1）：待入职 = 1，其余按当日任职状态。 */
  readonly status: number;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export async function searchCandidates(
  tx: Tx,
  tenantId: string,
  today: string,
  keyword: string,
  limit: number,
): Promise<Candidate[]> {
  const pattern = `%${escapeLike(keyword)}%`;
  const rows = rowsOf<{ id: string; name: string; email: string | null; status: number | null }>(
    await tx.execute(sql`
      SELECT * FROM (
        SELECT e.id, COALESCE(v.name, e.name) AS name, COALESCE(v.work_email, v.email, acc.email) AS email,
          s.employee_status::int AS status
        FROM employment_employees e
        LEFT JOIN LATERAL (SELECT pv.name, pv.email, pv.work_email FROM personnel_employee_versions pv
          WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
        LEFT JOIN permission_user_person_links l ON l.tenant_id = e.tenant_id AND l.employee_id = e.id
        LEFT JOIN LATERAL tenant_member_accounts(ARRAY[l.user_id]) acc ON l.user_id IS NOT NULL
        LEFT JOIN employment_timeline t ON t.tenant_id = e.tenant_id AND t.employee_id = e.id
          AND t.valid_during @> ${today}::date
        LEFT JOIN employment_records r ON r.tenant_id = t.tenant_id AND r.id = t.record_id
        LEFT JOIN LATERAL employment_record_status(e.tenant_id, r.id) s ON true
        WHERE e.tenant_id = ${tenantId}::uuid
      ) p
      WHERE (p.status IS NULL OR p.status NOT IN (4, 6, 8))
        AND (p.name ILIKE ${pattern} ESCAPE '\\' OR p.email ILIKE ${pattern} ESCAPE '\\')
      ORDER BY p.name, p.id LIMIT ${limit}`),
  );
  return rows.map((row) => ({ employeeId: row.id, name: row.name, email: row.email, status: row.status ?? 1 }));
}
