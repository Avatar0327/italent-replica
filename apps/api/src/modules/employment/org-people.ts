/**
 * 组织模块读取的在职人员投影（F-005）：DEC-135 负责人等字段的候选与保存校验、DEC-129 停用组织前的整支在职人数。
 * 只读，不按调用方数据范围过滤；由组织模块决定返回哪些字段（DEC-057 最少字段）。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { businessDate } from './fields.js';
import { personnelHooks } from './personnel-hooks.js';
import { checkPage, rowsOf } from './read-model.js';

export interface OrgPersonCandidate {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
}

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** 记录的当前快照：被向后更新改写过的生效记录以最新快照为准（与人员读取同一口径）。 */
const latestSnapshot = sql`LEFT JOIN LATERAL (
    SELECT p.id, p.department_id FROM employment_payload_versions p
    WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
    ORDER BY p.version_no DESC LIMIT 1
  ) latest ON true`;
const currentDepartment = sql`CASE WHEN latest.id IS NULL THEN r.department_id ELSE latest.department_id END`;

/**
 * DEC-135 / DEC-128：生效日在职的“内部员工”= 有人员档案、当天任职不是离职 / 退休。外部用户没有人员档案，
 * 不会出现在这里（DEC-128）；同日多条取最后一次操作（DEC-108，同日在前的记录区间为空）。
 */
function activeEmployees(tenantId: string, asOf: string): SQL {
  return sql`
    SELECT e.id, e.code, ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      ${currentDepartment} AS department_id
    FROM employment_employees e
    JOIN employment_timeline t ON t.tenant_id=e.tenant_id AND t.employee_id=e.id
      AND t.valid_during @> ${asOf}::date
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    ${latestSnapshot}
    WHERE e.tenant_id=${tenantId} AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary'
  `;
}

function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** DEC-135 人员选择器：全租户生效日在职员工，按工号排序；关键字匹配姓名或工号。 */
export async function listOrgPersonCandidates(
  tx: Tx,
  input: { tenantId: string; asOf: string; keyword?: string; limit: number; offset: number },
): Promise<OrgPersonCandidate[]> {
  businessDate(input.asOf);
  checkPage(input);
  const keyword = input.keyword?.trim();
  const filter = keyword
    ? sql`(c.name ILIKE ${likePattern(keyword)} ESCAPE '\\' OR c.code ILIKE ${likePattern(keyword)} ESCAPE '\\')`
    : sql`true`;
  return rowsOf<OrgPersonCandidate>(
    await tx.execute(sql`
      SELECT c.id, c.name, c.code, c.department_id AS "departmentId", d.name AS "departmentName"
      FROM (${activeEmployees(input.tenantId, input.asOf)}) c
      LEFT JOIN LATERAL (
        SELECT v.name FROM org_versions v
        WHERE v.tenant_id=${input.tenantId} AND v.org_id=c.department_id AND v.start_date <= ${input.asOf}::date
        ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
      ) d ON true
      WHERE ${filter}
      ORDER BY c.code, c.id LIMIT ${input.limit} OFFSET ${input.offset}
    `),
  );
}

/** DEC-135 保存校验：返回不是本租户生效日在职员工的 ID（不区分原因，不泄露人员状态）。 */
export async function ineligibleOrgPeople(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  asOf: string,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  businessDate(asOf);
  const eligible = new Set(
    rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT c.id FROM (${activeEmployees(tenantId, asOf)}) c WHERE c.id = ANY(${uuidArray(unique)})`,
      ),
    ).map((row) => row.id),
  );
  return unique.filter((id) => !eligible.has(id));
}

/**
 * DEC-129：自 from 起（含 from 之后才生效的调入）仍在这些部门在职的人数，按部门对员工去重。
 * 只计已生效的任职；审批中的申请生效时另按部门停用校验（DEC-125 申请只存单据）。
 */
export async function countDepartmentStaff(
  tx: Tx,
  tenantId: string,
  orgIds: readonly string[],
  from: string,
): Promise<Map<string, number>> {
  if (!orgIds.length) return new Map();
  businessDate(from);
  const rows = rowsOf<{ orgId: string; count: number }>(
    await tx.execute(sql`
      WITH candidates AS (
        SELECT id FROM employment_records WHERE tenant_id=${tenantId} AND department_id = ANY(${uuidArray(orgIds)})
        UNION
        SELECT business_id FROM employment_payload_versions
        WHERE tenant_id=${tenantId} AND department_id = ANY(${uuidArray(orgIds)}) AND is_record_snapshot
      ), staffed AS (
        SELECT r.employee_id, ${currentDepartment} AS department_id
        FROM candidates candidate
        JOIN employment_records r ON r.tenant_id=${tenantId} AND r.id=candidate.id
        JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
        ${latestSnapshot}
        WHERE t.valid_during && daterange(${from}::date, NULL, '[)')
          AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary'
      )
      SELECT department_id AS "orgId", count(DISTINCT employee_id)::int AS count FROM staffed
      WHERE department_id = ANY(${uuidArray(orgIds)}) GROUP BY department_id
    `),
  );
  return new Map(rows.map((row) => [row.orgId, Number(row.count)]));
}
