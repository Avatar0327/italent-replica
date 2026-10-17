/**
 * 试用期管理视图（R2 BE-3；docs/02_业务建模/29 PB-R1，差距表 B1 / B3 / B4 / B5、R2f B5）：
 * - expiring 即将试用到期：试用中、预计结束日在范围内（默认今天～今天 + 30 天）、未发起转正申请（审批中 / 已通过 / 已生效）；
 * - in_review 转正审批中；all 全部试用员工（当前人员状态 = 试用）；regularized 已转正（本周期有生效的转正记录，含通过未到期）。
 * “考核中”（B2）与“未发起转正考核”的判定归 BE-15。行以员工为单位，取租户今天的当前主职；只看在职（试用 / 正式）的人。
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
] as const;

function viewPredicate(view: ProbationView, filter: ProbationViewFilter, today: string): SQL {
  const probation = sql`st.employee_status=${EMPLOYEE_STATUS.probation}`;
  const end = (from?: string, to?: string) =>
    sql`${from ? sql`pv.expected_end_date>=${from}::date` : sql`true`}
      AND ${to ? sql`pv.expected_end_date<=${to}::date` : sql`true`}`;
  switch (view) {
    case 'expiring':
      return sql`${probation} AND pick.id IS NULL AND pv.expected_end_date IS NOT NULL
        AND ${end(filter.expectedEndFrom ?? today, filter.expectedEndTo ?? addDays(today, PROBATION_EXPIRING_DAYS))}`;
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
  return rowsOf<ProbationViewItem>(
    await tx.execute(sql`
    SELECT cr.id, cr.employee_id AS "employeeId", e.code,
      ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      ${department} AS "departmentId", COALESCE(snap.post_id, cr.post_id) AS "postId",
      st.employee_status::integer AS "employeeStatus", e.revision,
      COALESCE(pv.has_probation, CASE WHEN ast.employee_status IS NULL THEN NULL
        ELSE ast.employee_status=${EMPLOYEE_STATUS.probation} END) AS "hasProbation",
      pv.start_date::text AS "startDate", pv.months::integer AS months,
      pv.expected_end_date::text AS "expectedEndDate", reg.effective_date AS "regularizationDate",
      pick.id AS "regularizationBusinessId", pick.state AS "regularizationState",
      pick.mode AS "regularizationMode", pick.result_code AS "probationResult"
    FROM employment_timeline cur
    JOIN employment_records cr ON cr.tenant_id=cur.tenant_id AND cr.id=cur.record_id
    JOIN employment_employees e ON e.tenant_id=cr.tenant_id AND e.id=cr.employee_id
    LEFT JOIN LATERAL employment_record_status(cr.tenant_id, cr.id) st ON true
    LEFT JOIN LATERAL (SELECT p.department_id, p.post_id FROM employment_payload_versions p
      WHERE p.tenant_id=cr.tenant_id AND p.business_id=cr.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    LEFT JOIN LATERAL (SELECT a.id FROM employment_records a
      JOIN employment_timeline at ON at.tenant_id=a.tenant_id AND at.record_id=a.id
      WHERE a.tenant_id=cr.tenant_id AND a.employee_id=cr.employee_id AND a.staff_id=cr.staff_id
        AND a.kind IN (${kinds}) AND at.start_date<=${input.today}::date
      ORDER BY at.start_date DESC, at.sort_order DESC LIMIT 1) anchor ON true
    LEFT JOIN LATERAL employment_record_status(cr.tenant_id, anchor.id) ast ON true
    LEFT JOIN LATERAL (SELECT v.* FROM employment_probation_versions v
      WHERE v.tenant_id=cr.tenant_id AND v.business_id=anchor.id ORDER BY v.version_no DESC LIMIT 1) pv ON true
    LEFT JOIN LATERAL (${cycleRegularization(tenantId, sql`cr.employee_id`, sql`cr.staff_id`, false)}) pick ON true
    LEFT JOIN LATERAL (${cycleRegularization(tenantId, sql`cr.employee_id`, sql`cr.staff_id`, true)}) reg ON true
    WHERE cur.tenant_id=${tenantId} AND cur.valid_during @> ${input.today}::date
      AND st.employee_status IN (${EMPLOYEE_STATUS.probation}, ${EMPLOYEE_STATUS.regular})
      AND ${viewPredicate(input.view, input.filter, input.today)}
      AND ${filterPredicate(tenantId, input.filter)} AND ${visible}
    ORDER BY pv.expected_end_date NULLS LAST, cr.employee_id
    LIMIT ${input.page.limit} OFFSET ${input.page.offset}
  `),
  );
}
