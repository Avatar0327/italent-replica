/**
 * 实习四视图（R2 BE-6a；差距表 B34～B37；31 §补充“人员信息各列表的过滤口径”与 Q-M0-122 ④；R2f B41）：
 * - 实习中：雇佣关系实习生 + 人员状态正式 + 主职 + 当前生效（TraineeEmploymentRecordList 默认条件）；
 * - 实习转正中：实习转正申请审批中 / 审批通过未生效（实习转正管理“审批状态 ∈ 审批中、审批通过”）；
 * - 已转正：生效的实习转正任职（直接或申请；结束实习不会进来——它是离职、雇佣关系仍是实习生）；
 * - 已离职：实习生身份的离职任职（结束实习归 BE-6b；落地前只读已有离职，可为空集）。
 * 字段沿用 main 现有任职字段与状态；原站列 / 筛选未取证到的不加（PR“未验证”）。字段状态读记录自己的版本快照。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, type EmployeeStatusCode, type InternView } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { employmentCreator, employmentScopePredicate } from './context.js';
import { personnelHooks } from './personnel-hooks.js';
import { checkPage, rowsOf } from './read-model.js';
import type { BusinessKind, EmploymentScope, EmploymentState, EmployType, PageQuery } from './types.js';

export interface InternViewItem {
  /** 任职记录 ID；实习转正中为申请单（业务）ID。 */
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
  /** 业务 revision：后续动作（实习转正申请撤回等）的 If-Match。 */
  readonly revision: number;
  /** 业务状态：任职记录为 effective；实习转正中为 in_review / approved。 */
  readonly state: EmploymentState;
  readonly lastWorkDate: string | null;
  /** 已转正且有试用期时的试用期信息（entry-probation.ts）；其余为 null。 */
  readonly probation: { readonly startDate: string; readonly months: number; readonly endDate: string } | null;
}

export interface InternViewFilter {
  readonly departmentId?: string;
  /** 姓名或工号包含（不区分大小写）。 */
  readonly keyword?: string;
}

interface InternViewQuery {
  readonly view: InternView;
  readonly today: string;
  readonly page: PageQuery;
  readonly filter: InternViewFilter;
}

type Row = Omit<InternViewItem, 'probation'> & {
  probationStartDate: string | null;
  probationMonths: number | null;
  probationEndDate: string | null;
};

export async function listInternView(
  tx: Tx,
  tenantId: string,
  input: InternViewQuery,
  scope: EmploymentScope | undefined,
): Promise<InternViewItem[]> {
  checkPage(input.page);
  const rows = rowsOf<Row>(
    await tx.execute(
      input.view === 'converting' ? convertingQuery(tenantId, input, scope) : recordQuery(tenantId, input, scope),
    ),
  );
  return rows.map(({ probationStartDate, probationMonths, probationEndDate, ...row }) => ({
    ...row,
    probation:
      probationStartDate && probationMonths !== null && probationEndDate
        ? { startDate: probationStartDate, months: probationMonths, endDate: probationEndDate }
        : null,
  }));
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
  return sql`
    SELECT r.id, r.employee_id AS "employeeId", e.code,
      ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      r.kind, t.start_date::text AS "effectiveDate", r.entry_date::text AS "entryDate",
      ${department} AS "departmentId", COALESCE(snap.position_id, r.position_id) AS "positionId",
      ${employType} AS "employType", s.employee_status::integer AS "employeeStatus", b.revision,
      'effective' AS state, r.last_work_date::text AS "lastWorkDate",
      rp.start_date::text AS "probationStartDate", rp.months AS "probationMonths",
      rp.expected_end_date::text AS "probationEndDate"
    FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    JOIN employment_business_objects b ON b.tenant_id=r.tenant_id AND b.id=r.id
    JOIN employment_employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
    LEFT JOIN employment_record_probation rp ON rp.tenant_id=r.tenant_id AND rp.business_id=r.id
    LEFT JOIN LATERAL employment_record_status(r.tenant_id, r.id) s ON true
    LEFT JOIN LATERAL (SELECT p.department_id, p.position_id, p.employ_type FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    WHERE r.tenant_id=${tenantId} AND r.service_type='primary'
      AND ${recordPredicate(input.view as Exclude<InternView, 'converting'>, input.today, employType)}
      AND ${filters(tenantId, input.filter, department, sql`e.id`, sql`e.code`)} AND ${visible}
    ORDER BY t.start_date, r.id LIMIT ${input.page.limit} OFFSET ${input.page.offset}
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
      p.last_work_date::text AS "lastWorkDate",
      NULL AS "probationStartDate", NULL::integer AS "probationMonths", NULL AS "probationEndDate"
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
