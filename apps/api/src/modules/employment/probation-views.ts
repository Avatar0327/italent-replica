/**
 * 试用期管理视图（R2 BE-3；docs/02_业务建模/29 PB-R1，差距表 B1 / B3 / B4 / B5、R2f B5）：
 * - expiring 即将试用到期：试用中、预计结束日在范围内（默认今天～今天 + 30 天）、未发起转正申请（审批中 / 已通过 / 已生效）；
 * - in_review 转正审批中；all 全部试用员工（当前人员状态 = 试用）；regularized 已转正（本周期有生效的转正记录，含通过未到期）。
 * assessing 考核中（BE-15b1）：本周期有审批中的试用中考核 / 转正考核；即将到期里“未发起转正考核”= 本周期没有审批中或已通过的
 * 转正考核。行以员工为单位，取租户今天的当前主职；只看在职（试用 / 正式）的人。
 * 筛选（R2f B5）：人员（employeeId / keyword 姓名或工号）、预计试用结束日期、部门、职务。列表按任职记录的数据范围裁剪。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import {
  addDays,
  EMPLOYEE_STATUS,
  PROBATION_EXPIRING_DAYS,
  type EmployeeStatusCode,
  type ProbationView,
} from '@italent/domain';
import { employmentCreator, employmentScopePredicate } from './context.js';
import { ENTRY_LIKE_KINDS } from './employee-status.js';
import { personnelHooks } from './personnel-hooks.js';
import { cycleRegularization } from './probation.js';
import { checkPage, rowsOf } from './read-model.js';
import type { EmploymentScope, PageQuery } from './types.js';

export interface ProbationViewFilter {
  readonly employeeId?: string;
  readonly keyword?: string;
  readonly departmentId?: string;
  readonly postId?: string;
  readonly expectedEndFrom?: string;
  readonly expectedEndTo?: string;
}

export interface ProbationViewItem {
  /** 当前主职任职记录。 */
  readonly id: string;
  readonly employeeId: string;
  readonly code: string;
  readonly name: string;
  readonly departmentId: string | null;
  /** 机构（R2f B5、15 OIdOrganization“任职部门对应的机构”）：部门在行政维度上最近的、大类不是“部门”的组织（含部门本身）。 */
  readonly organizationId: string | null;
  readonly postId: string | null;
  readonly employeeStatus: EmployeeStatusCode;
  /** 员工 revision：调整试用信息、转正的 If-Match。 */
  readonly revision: number;
  readonly hasProbation: boolean | null;
  readonly startDate: string | null;
  readonly months: number | null;
  readonly expectedEndDate: string | null;
  readonly regularizationDate: string | null;
  readonly regularizationBusinessId: string | null;
  readonly regularizationState: string | null;
  readonly regularizationMode: string | null;
  readonly probationResult: string | null;
  /** 本周期审批中的考核（BE-15b1，“考核中”视图）：考核 ID 与类型，没有为空；考核内容走考核接口的字段权限。 */
  readonly assessmentId: string | null;
  readonly assessmentType: string | null;
}

/** 视图里不属于任职字段目录的控制键：裁剪前摘下、裁剪后放回（同入职视图的做法）。 */
export const PROBATION_VIEW_CONTROLS = [
  'hasProbation',
  'startDate',
  'months',
  'expectedEndDate',
  'regularizationDate',
  'regularizationBusinessId',
  'regularizationState',
  'regularizationMode',
  'probationResult',
  'assessmentId',
  'assessmentType',
] as const;

function viewPredicate(view: ProbationView, filter: ProbationViewFilter, today: string): SQL {
  const probation = sql`st.employee_status=${EMPLOYEE_STATUS.probation}`;
  const end = (from?: string, to?: string) =>
    sql`${from ? sql`pi.end_date>=${from}::date` : sql`true`}
      AND ${to ? sql`pi.end_date<=${to}::date` : sql`true`}`;
  switch (view) {
    case 'expiring':
      return sql`${probation} AND pick.id IS NULL AND regasm.id IS NULL AND pi.end_date IS NOT NULL
        AND ${end(filter.expectedEndFrom ?? today, filter.expectedEndTo ?? addDays(today, PROBATION_EXPIRING_DAYS))}`;
    case 'assessing':
      return sql`asm.id IS NOT NULL AND ${end(filter.expectedEndFrom, filter.expectedEndTo)}`;
    case 'in_review':
      return sql`pick.state='in_review' AND ${end(filter.expectedEndFrom, filter.expectedEndTo)}`;
    case 'all':
      return sql`${probation} AND ${end(filter.expectedEndFrom, filter.expectedEndTo)}`;
    case 'regularized':
      return sql`reg.id IS NOT NULL AND ${end(filter.expectedEndFrom, filter.expectedEndTo)}`;
  }
}

function filterPredicate(tenantId: string, filter: ProbationViewFilter): SQL {
  const parts: SQL[] = [sql`true`];
  if (filter.employeeId) parts.push(sql`cr.employee_id=${filter.employeeId}::uuid`);
  if (filter.keyword) {
    const like = `%${filter.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const name = personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`);
    parts.push(sql`(${name} ILIKE ${like} OR e.code ILIKE ${like})`);
  }
  if (filter.departmentId) parts.push(sql`COALESCE(snap.department_id, cr.department_id)=${filter.departmentId}::uuid`);
  if (filter.postId) parts.push(sql`COALESCE(snap.post_id, cr.post_id)=${filter.postId}::uuid`);
  return sql.join(parts, sql` AND `);
}

/**
 * 试用期信息（与 probation.ts loadProbationCycle 同一口径）：没有版本时按开启记录人员状态推断是否有试用期；
 * 入职申请的版本开始日为空，取开启记录实际生效日，预计结束日按 resolveDeferredProbation 的规则（手填不早于开始日才保留，
 * 否则按月数推算：开始日 + 月数 − 1 天，PostgreSQL 的 date + interval 'n month' 与 termEnd 同样取月末）。
 */
const probationInfo = sql`SELECT
    COALESCE(pv.has_probation, ast.employee_status=${EMPLOYEE_STATUS.probation}) AS has_probation,
    CASE WHEN pv.start_date IS NOT NULL THEN pv.start_date
      WHEN COALESCE(pv.has_probation, ast.employee_status=${EMPLOYEE_STATUS.probation}) THEN anchor.start_date
    END AS start_date,
    CASE WHEN pv.start_date IS NOT NULL THEN pv.expected_end_date
      WHEN pv.has_probation AND pv.expected_end_date>=anchor.start_date THEN pv.expected_end_date
      WHEN pv.has_probation AND pv.months IS NOT NULL
        THEN (anchor.start_date + make_interval(months => pv.months::integer))::date - 1
    END AS end_date`;

/**
 * 试用期视图的候选行（FROM … WHERE …，别名 cr / e / st / pi / snap / reg / pick 等）：列表与人事看板（analytics/hr-dashboard，
 * BE-12b）共用，视图谓词只有这一份；今天 = asOf，范围过滤在分页之前。
 */
export function probationViewRows(
  tenantId: string,
  input: { readonly view: ProbationView; readonly today: string; readonly filter: ProbationViewFilter },
  scope: EmploymentScope | undefined,
): SQL {
  const department = sql`COALESCE(snap.department_id, cr.department_id)`;
  const visible = employmentScopePredicate(
    scope,
    sql`cr.employee_id`,
    department,
    employmentCreator(tenantId, sql`cr.id`, true),
  );
  const kinds = sql.join(
    ENTRY_LIKE_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql`
    FROM employment_timeline cur
    JOIN employment_records cr ON cr.tenant_id=cur.tenant_id AND cr.id=cur.record_id
    JOIN employment_employees e ON e.tenant_id=cr.tenant_id AND e.id=cr.employee_id
    LEFT JOIN LATERAL employment_record_status(cr.tenant_id, cr.id) st ON true
    LEFT JOIN LATERAL (SELECT p.department_id, p.post_id FROM employment_payload_versions p
      WHERE p.tenant_id=cr.tenant_id AND p.business_id=cr.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    LEFT JOIN LATERAL (SELECT a.id, at.start_date FROM employment_records a
      JOIN employment_timeline at ON at.tenant_id=a.tenant_id AND at.record_id=a.id
      WHERE a.tenant_id=cr.tenant_id AND a.employee_id=cr.employee_id AND a.staff_id=cr.staff_id
        AND a.kind IN (${kinds}) AND at.start_date<=${input.today}::date
      ORDER BY at.start_date DESC, at.sort_order DESC LIMIT 1) anchor ON true
    LEFT JOIN LATERAL employment_record_status(cr.tenant_id, anchor.id) ast ON true
    LEFT JOIN LATERAL (SELECT v.* FROM employment_probation_versions v
      WHERE v.tenant_id=cr.tenant_id AND v.business_id=anchor.id ORDER BY v.version_no DESC LIMIT 1) pv ON true
    LEFT JOIN LATERAL (${probationInfo}) pi ON true
    LEFT JOIN LATERAL (SELECT a.id::text AS id, a.assessment_type FROM employment_probation_assessments a
      WHERE a.tenant_id=cr.tenant_id AND a.employee_id=cr.employee_id AND a.anchor_id=anchor.id
        AND a.status='in_review' ORDER BY a.assessment_date, a.id LIMIT 1) asm ON true
    LEFT JOIN LATERAL (SELECT a.id FROM employment_probation_assessments a
      WHERE a.tenant_id=cr.tenant_id AND a.employee_id=cr.employee_id AND a.anchor_id=anchor.id
        AND a.assessment_type='regularization' AND a.status IN ('in_review', 'approved') LIMIT 1) regasm ON true
    LEFT JOIN LATERAL (${cycleRegularization(tenantId, sql`cr.employee_id`, sql`cr.staff_id`, false)}) pick ON true
    LEFT JOIN LATERAL (${cycleRegularization(tenantId, sql`cr.employee_id`, sql`cr.staff_id`, true)}) reg ON true
    WHERE cur.tenant_id=${tenantId} AND cur.valid_during @> ${input.today}::date
      AND st.employee_status IN (${EMPLOYEE_STATUS.probation}, ${EMPLOYEE_STATUS.regular})
      AND ${viewPredicate(input.view, input.filter, input.today)}
      AND ${filterPredicate(tenantId, input.filter)} AND ${visible}`;
}

export async function listProbationView(
  tx: Tx,
  tenantId: string,
  input: {
    readonly view: ProbationView;
    readonly today: string;
    readonly page: PageQuery;
    readonly filter: ProbationViewFilter;
  },
  scope: EmploymentScope | undefined,
): Promise<ProbationViewItem[]> {
  checkPage(input.page);
  const department = sql`COALESCE(snap.department_id, cr.department_id)`;
  const items = rowsOf<Omit<ProbationViewItem, 'organizationId'>>(
    await tx.execute(sql`
    SELECT cr.id, cr.employee_id AS "employeeId", e.code,
      ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      ${department} AS "departmentId", COALESCE(snap.post_id, cr.post_id) AS "postId",
      st.employee_status::integer AS "employeeStatus", e.revision,
      pi.has_probation AS "hasProbation", pi.start_date::text AS "startDate", pv.months::integer AS months,
      pi.end_date::text AS "expectedEndDate", reg.effective_date AS "regularizationDate",
      pick.id AS "regularizationBusinessId", pick.state AS "regularizationState",
      pick.mode AS "regularizationMode", pick.result_code AS "probationResult",
      asm.id AS "assessmentId", asm.assessment_type AS "assessmentType"
    ${probationViewRows(tenantId, input, scope)}
    ORDER BY pi.end_date NULLS LAST, cr.employee_id
    LIMIT ${input.page.limit} OFFSET ${input.page.offset}
  `),
  );
  const organizations = await organizationsOf(tx, tenantId, items, input.today);
  return items.map((item) => ({
    ...item,
    organizationId: item.departmentId ? (organizations.get(item.departmentId) ?? null) : null,
  }));
}

/**
 * 本页各部门所属的机构（按租户今天的组织版本，行政维度向上找第一个大类不是“部门”的组织，含部门本身；找不到为空）。
 * 原站“修改任职部门后系统自动赋值”的取值规则未取证，复刻按组织大类推（PR #391 未决 / 假设）。
 */
async function organizationsOf(
  tx: Tx,
  tenantId: string,
  items: readonly { readonly departmentId: string | null }[],
  asOf: string,
): Promise<Map<string, string>> {
  const departments = [...new Set(items.map((item) => item.departmentId).filter((id): id is string => !!id))];
  if (!departments.length) return new Map();
  const rows = rowsOf<{ departmentId: string; organizationId: string }>(
    await tx.execute(sql`
    WITH RECURSIVE current_versions AS (
      SELECT DISTINCT ON (org_id) id, org_id, broad_type, stop_date FROM org_versions
      WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC
    ), chain AS (
      SELECT v.org_id AS department_id, v.org_id, v.id AS version_id, v.broad_type, ARRAY[v.org_id] AS path, 0 AS depth
      FROM current_versions v WHERE v.org_id = ANY(${`{${departments.join(',')}}`}::uuid[])
      UNION ALL
      SELECT chain.department_id, parent.org_id, parent.id, parent.broad_type, chain.path || parent.org_id,
        chain.depth + 1
      FROM chain
      JOIN org_hierarchy_links link ON link.tenant_id=${tenantId} AND link.dimension='admin'
        AND link.version_id=chain.version_id
      JOIN current_versions parent ON parent.org_id=link.parent_org_id AND parent.stop_date>=${asOf}::date
      WHERE chain.broad_type='部门' AND NOT parent.org_id = ANY(chain.path)
    )
    SELECT DISTINCT ON (department_id) department_id AS "departmentId", org_id AS "organizationId"
    FROM chain WHERE broad_type<>'部门' ORDER BY department_id, depth
  `),
  );
  return new Map(rows.map((row) => [row.departmentId, row.organizationId]));
}
