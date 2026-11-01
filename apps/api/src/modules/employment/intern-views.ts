/**
 * 实习四视图（R2 BE-6a；差距表 B34～B37；31 人员信息列表过滤口径、Q-M0-122 ④）：实习中 = 实习生 + 人员状态正式 + 主职
 * 当前生效；实习转正中 = 转正申请审批中 / 审批通过未生效；已转正 = 生效的实习转正任职；已离职 = 实习生身份的离职任职
 * （结束实习归 BE-6b）。列只给 main 现有字段（原站列未取证，PR“未验证”）；状态读记录自己的版本快照。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, type EmployeeStatusCode, type InternView } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { employmentCreator, employmentScopePredicate } from './context.js';
import { personnelHooks } from './personnel-hooks.js';
import { loadProbationVersions, type ProbationVersion } from './entry-probation.js';
import { resolveProbationInfo } from './probation.js';
import { checkPage, rowsOf } from './read-model.js';
import { institutionsOf } from './part-time/institution.js';
import { employeeCodeOf, orgSortRank, sortedBy } from './part-time/view-sort.js';
import type { BusinessKind, EmploymentScope, EmploymentState, EmployType, PageQuery } from './types.js';

export interface InternViewItem {
  /** 任职记录 ID；实习转正中为申请单 ID。 */
  readonly id: string;
  readonly employeeId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: BusinessKind;
  readonly effectiveDate: string;
  /** 实习入职日期（任职周期入职日）。 */
  readonly entryDate: string | null;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly employType: EmployType | null;
  readonly employeeStatus: EmployeeStatusCode;
  readonly revision: number;
  /** 任职记录为 effective；实习转正中为 in_review / approved。 */
  readonly state: EmploymentState;
  readonly lastWorkDate: string | null;
  /** 只有实习中有（F-366）：实习机构按部门今天的行政链上溯派生，与排序同一表达式。 */
  readonly institutionId?: string | null;
  /** 只有实习中有（F-366）：记录快照的直线经理。 */
  readonly directManagerId?: string | null;
  /** 已转正且有试用期时才有（BE-3 试用期版本表）。 */
  readonly probation: { readonly startDate: string; readonly months: number; readonly endDate: string } | null;
}

export interface InternViewFilter {
  readonly departmentId?: string;
  /** 姓名或工号包含，不区分大小写。 */
  readonly keyword?: string;
}

/** F-366：实习中表头只有这三列可排（规格 31 末尾 F-366 补充）；编码即任职记录字段编码，同兼职排序。 */
export const INTERN_SORT_FIELDS = ['institutionId', 'departmentId', 'directManagerId'] as const;
export type InternSortField = (typeof INTERN_SORT_FIELDS)[number];
export interface InternViewSort {
  readonly sortBy: InternSortField;
  readonly direction?: 'asc' | 'desc';
}

interface InternViewQuery {
  readonly view: InternView;
  readonly today: string;
  readonly page: PageQuery;
  readonly filter: InternViewFilter;
  /** 只有实习中收排序（其余三个页签未取证，路由层已 400）。 */
  readonly sort?: InternViewSort;
}

export async function listInternView(
  tx: Tx,
  tenantId: string,
  input: InternViewQuery,
  scope: EmploymentScope | undefined,
): Promise<InternViewItem[]> {
  checkPage(input.page);
  const query = input.view === 'converting' ? convertingQuery : recordQuery;
  const rows = rowsOf<Omit<InternViewItem, 'probation'>>(await tx.execute(query(tenantId, input, scope)));
  const converted = input.view === 'converted';
  const versions = converted
    ? await loadProbationVersions(
        tx,
        tenantId,
        rows.map((row) => row.id),
      )
    : new Map();
  return rows.map((row) => ({ ...row, probation: converted ? regularizedProbation(row, versions.get(row.id)) : null }));
}

/**
 * 已转正行的试用期（DEC-585，BE-3 的试用期版本链）：这条实习转正就是开启本段试用的记录，直接按行自己的记录 ID 读，
 * 不再按“员工 + 转正日”重新定位锚点——同一天退休又返聘时，当天最后的周期不是这一行（PR #386 第 3 轮 P2-1）。
 * 整页一次批量读取版本；无试用期为 null。
 */
function regularizedProbation(row: Omit<InternViewItem, 'probation'>, version: ProbationVersion | undefined) {
  const info = resolveProbationInfo(version ?? null, row);
  if (!info.hasProbation) return null;
  return { startDate: info.startDate!, months: info.months!, endDate: info.expectedEndDate! };
}

function filters(tenantId: string, filter: InternViewFilter, department: SQL, employee: SQL, code: SQL): SQL {
  const parts: SQL[] = [];
  if (filter.departmentId) parts.push(sql`${department}=${filter.departmentId}::uuid`);
  if (filter.keyword) {
    const name = personnelHooks.currentName(tenantId, employee, sql`e.name`);
    // strpos 而不是 LIKE：关键字里的 % / _ 不当通配符
    parts.push(sql`(strpos(lower(${code}), lower(${filter.keyword}))>0
      OR strpos(lower(${name}), lower(${filter.keyword}))>0)`);
  }
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
}

function recordPredicate(view: Exclude<InternView, 'converting'>, today: string, employType: SQL): SQL {
  switch (view) {
    case 'interning':
      return sql`t.valid_during @> ${today}::date AND r.kind NOT IN ('leave','retirement')
        AND ${employType}='intern' AND s.employee_status=${EMPLOYEE_STATUS.regular}`;
    case 'converted':
      return sql`r.kind='intern_regularization'`;
    case 'left':
      return sql`r.kind='leave' AND ${employType}='intern' AND t.start_date<=${today}::date`;
  }
}

/**
 * 实习中的机构 / 直线经理列与顺序（F-366）。原站默认 OrderCode 升序 + 实习开始日期降序；复刻没有 OrderCode 对应字段
 * （时间轴 sort_order 是同日次序，不是它），退化为实习开始日期（实习入职日）降序、同日按记录 id 升序。表头单列排序
 * 复用兼职的取值：机构 / 部门按 DEC-089 名次，直线经理按工号；值 方向 NULLS LAST，再 id 升序。
 */
function interningExtras(tenantId: string, input: InternViewQuery, department: SQL) {
  const manager = sql`(CASE WHEN snap.present IS NULL THEN r.direct_manager_id ELSE snap.direct_manager_id END)`;
  // 与兼职机构派生同一规则（part-time/institution.ts）：今天的行政链上溯到最近“机构”，没有回落租户根；部门为空则为空
  const institution = sql`(CASE WHEN ${department} IS NULL THEN NULL
    ELSE COALESCE(inst.institution_id, ${tenantId}::uuid) END)`;
  const origins = sql`SELECT DISTINCT org_id AS origin FROM org_versions WHERE tenant_id=${tenantId}`;
  const values: Record<InternSortField, SQL> = {
    institutionId: orgSortRank(tenantId, input.today, institution),
    departmentId: orgSortRank(tenantId, input.today, department),
    directManagerId: employeeCodeOf(tenantId, manager),
  };
  return {
    columns: sql`, ${institution} AS "institutionId", ${manager} AS "directManagerId"`,
    // 显示与排序同一表达式；映射整次请求只算一次，不逐行递归
    join: sql`LEFT JOIN (${institutionsOf(tenantId, origins, input.today)}) inst ON inst.origin=${department}`,
    order: input.sort
      ? sortedBy(values[input.sort.sortBy], input.sort.direction, sql`r.id`)
      : sql`r.entry_date DESC, r.id ASC`,
  };
}

/** 实习中 / 已转正 / 已离职：按任职时间轴上现存的记录取数（删除的记录不出现），范围按写入口径谓词（同入职四视图）。 */
function recordQuery(tenantId: string, input: InternViewQuery, scope: EmploymentScope | undefined): SQL {
  const department = sql`COALESCE(snap.department_id, r.department_id)`;
  const employType = sql`COALESCE(snap.employ_type, r.employ_type)`;
  const visible = employmentScopePredicate(
    scope,
    sql`r.employee_id`,
    department,
    employmentCreator(tenantId, sql`r.id`, true),
  );
  // 其余三个页签的顺序未取证，维持原状（F-366 只改实习中）
  const extras =
    input.view === 'interning'
      ? interningExtras(tenantId, input, department)
      : { columns: sql``, join: sql``, order: sql`t.start_date, r.id` };
  return sql`
    SELECT r.id, r.employee_id AS "employeeId", e.code,
      ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      r.kind, t.start_date::text AS "effectiveDate", r.entry_date::text AS "entryDate",
      ${department} AS "departmentId", COALESCE(snap.position_id, r.position_id) AS "positionId",
      ${employType} AS "employType", s.employee_status::integer AS "employeeStatus", b.revision,
      'effective' AS state, r.last_work_date::text AS "lastWorkDate"${extras.columns}
    FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    JOIN employment_business_objects b ON b.tenant_id=r.tenant_id AND b.id=r.id
    JOIN employment_employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
    LEFT JOIN LATERAL employment_record_status(r.tenant_id, r.id) s ON true
    LEFT JOIN LATERAL (SELECT true AS present, p.department_id, p.position_id, p.employ_type, p.direct_manager_id
      FROM employment_payload_versions p WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    ${extras.join}
    WHERE r.tenant_id=${tenantId} AND r.service_type='primary'
      AND ${recordPredicate(input.view as Exclude<InternView, 'converting'>, input.today, employType)}
      AND ${filters(tenantId, input.filter, department, sql`e.id`, sql`e.code`)} AND ${visible}
    ORDER BY ${extras.order} LIMIT ${input.page.limit} OFFSET ${input.page.offset}
  `;
}

/**
 * 实习转正中：最新载荷为实习转正申请、最新状态审批中 / 审批通过、尚未落地。原站此时已有“内部员工 / 入职 / 实习转正”
 * 中间态记录（31 Q-M0-122 ④）；复刻申请到生效日才落地（DEC-234 / 241），雇佣关系按落地后的内部员工给出。
 */
function convertingQuery(tenantId: string, input: InternViewQuery, scope: EmploymentScope | undefined): SQL {
  const department = sql`p.department_id`;
  const visible = employmentScopePredicate(
    scope,
    sql`b.employee_id`,
    department,
    employmentCreator(tenantId, sql`b.id`, true),
  );
  return sql`
    SELECT b.id, b.employee_id AS "employeeId", e.code,
      ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      p.kind, p.effective_date::text AS "effectiveDate", c.entry_date::text AS "entryDate",
      ${department} AS "departmentId", p.position_id AS "positionId", 'internal' AS "employType",
      p.employee_status::integer AS "employeeStatus", b.revision, s.state,
      p.last_work_date::text AS "lastWorkDate"
    FROM employment_business_objects b
    JOIN employment_employees e ON e.tenant_id=b.tenant_id AND e.id=b.employee_id
    JOIN LATERAL (SELECT * FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
      AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
      AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_cycles c ON c.tenant_id=b.tenant_id AND c.id=p.selected_staff_id
    WHERE b.tenant_id=${tenantId} AND p.kind='intern_regularization' AND p.mode='application'
      AND s.state IN ('in_review','approved')
      AND NOT EXISTS (SELECT 1 FROM employment_records r WHERE r.tenant_id=b.tenant_id AND r.id=b.id)
      AND ${filters(tenantId, input.filter, department, sql`e.id`, sql`e.code`)} AND ${visible}
    ORDER BY p.effective_date, b.id LIMIT ${input.page.limit} OFFSET ${input.page.offset}
  `;
}
