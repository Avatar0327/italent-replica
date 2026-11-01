/**
 * 员工时点花名册的读取（规格 35 §2.2、AC-HA-03）：任职、合同、组织同取 asOf 当天的版本。
 * 人员 / 任职 / 职务沿用 personnel 列表的 employeeJoins(ctx, asOf)（单一入口，不另写时间轴查询），
 * 名册在它之上只加：在职过滤、任职区间、直线经理、本周期试用信息、asOf 当天有效的合同、组织名称与一～三级组织。
 * 范围先于分页（personScope 进 WHERE，total 与本页同一谓词）；字段权在路由层按列裁剪。
 */
import { sql, type Tx } from '@italent/db';
import { ageOn, ROSTER_EMPLOY_TYPES, ROSTER_EMPLOYEE_STATUSES, tenureYears, type RosterColumn } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { ENTRY_LIKE_KINDS } from '../employment/employee-status.js';
import { probationInfo } from '../employment/probation-views.js';
import { cycleRegularization } from '../employment/probation.js';
import { personScope, type AccessContext } from '../personnel/access.js';
import { employeeJoins } from '../personnel/employee-read.js';
import { camel, rows, type Row } from '../personnel/store.js';
import { rosterOrganizations } from './roster-org.js';

export interface RosterFilter {
  readonly name?: string;
  readonly email?: string;
  readonly workDateFrom?: string;
  readonly workDateTo?: string;
  readonly employeeStatus?: number;
  readonly employType?: string;
}

const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const list = (values: readonly (string | number)[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** 名册人员范围（与试用 / 离职 / 退休视图同一口径）：asOf 当天主职任职在职（试用 / 正式），雇佣关系为内部员工或实习生。 */
function population(ctx: AccessContext, filter: RosterFilter): SQL {
  const parts: SQL[] = [
    sql`e.tenant_id=${ctx.tenantId}`,
    personScope(ctx),
    sql`r.current_employee_status IN (${list(ROSTER_EMPLOYEE_STATUSES)})`,
    sql`r.current_fields->>'employ_type' IN (${list(ROSTER_EMPLOY_TYPES)})`,
  ];
  if (filter.name) parts.push(sql`COALESCE(v.name,e.name) ILIKE ${like(filter.name)}`);
  if (filter.email) parts.push(sql`v.email ILIKE ${like(filter.email)}`);
  if (filter.workDateFrom) parts.push(sql`v.work_date>=${filter.workDateFrom}::date`);
  if (filter.workDateTo) parts.push(sql`v.work_date<=${filter.workDateTo}::date`);
  if (filter.employeeStatus) parts.push(sql`r.current_employee_status=${filter.employeeStatus}`);
  if (filter.employType) parts.push(sql`r.current_fields->>'employ_type'=${filter.employType}`);
  return sql.join(parts, sql` AND `);
}

function rosterJoins(ctx: AccessContext, asOf: string): SQL {
  const kinds = list(ENTRY_LIKE_KINDS);
  return sql`${employeeJoins(ctx, asOf)}
    LEFT JOIN LATERAL (SELECT (upper(ct.valid_during) - 1)::text AS end_date FROM employment_timeline ct
      WHERE ct.tenant_id=r.tenant_id AND ct.record_id=r.id AND NOT upper_inf(ct.valid_during)) cur_end ON true
    LEFT JOIN LATERAL (SELECT lr.last_work_date::text AS last_work_date FROM employment_timeline lt
      JOIN employment_records lr ON lr.tenant_id=lt.tenant_id AND lr.id=lt.record_id
      WHERE lt.tenant_id=e.tenant_id AND lt.employee_id=e.id AND lr.staff_id=r.staff_id
        AND lr.kind IN ('leave','retirement') AND lt.start_date>${asOf}::date
      ORDER BY lt.start_date LIMIT 1) nx ON true
    LEFT JOIN employment_employees dm ON dm.tenant_id=e.tenant_id
      AND dm.id=(r.current_fields->>'direct_manager_id')::uuid
    LEFT JOIN LATERAL (SELECT m.name, m.work_email FROM personnel_employee_versions m
      WHERE m.tenant_id=dm.tenant_id AND m.employee_id=dm.id ORDER BY m.revision DESC LIMIT 1) dmv ON true
    LEFT JOIN LATERAL (SELECT a.id, at.start_date FROM employment_records a
      JOIN employment_timeline at ON at.tenant_id=a.tenant_id AND at.record_id=a.id
      WHERE a.tenant_id=r.tenant_id AND a.employee_id=r.employee_id AND a.staff_id=r.staff_id
        AND a.kind IN (${kinds}) AND at.start_date<=${asOf}::date
      ORDER BY at.start_date DESC, at.sort_order DESC LIMIT 1) anchor ON true
    LEFT JOIN LATERAL employment_record_status(r.tenant_id, anchor.id) ast ON true
    LEFT JOIN LATERAL (SELECT pv.* FROM employment_probation_versions pv
      WHERE pv.tenant_id=r.tenant_id AND pv.business_id=anchor.id ORDER BY pv.version_no DESC LIMIT 1) pv ON true
    LEFT JOIN LATERAL (${probationInfo}) pi ON true
    LEFT JOIN LATERAL (${cycleRegularization(ctx.tenantId, sql`e.id`, sql`r.staff_id`, true)}) reg ON true
    LEFT JOIN LATERAL (SELECT k.*, kt.name AS type_name FROM contract_records k
      LEFT JOIN contract_types kt ON kt.tenant_id=k.tenant_id AND kt.id=k.type_id
      WHERE k.tenant_id=e.tenant_id AND k.employee_id=e.id AND NOT k.deleted AND k.status<>'void'
        AND k.approval_status='effective' AND k.effective_date<=${asOf}::date
        AND COALESCE(k.actual_termination_date, k.end_date, 'infinity'::date)>=${asOf}::date
      ORDER BY k.effective_date DESC, k.version_no DESC LIMIT 1) ct ON true`;
}

export async function countRoster(tx: Tx, ctx: AccessContext, asOf: string, filter: RosterFilter) {
  const [row] = rows<{ total: string }>(
    await tx.execute(sql`SELECT count(*) AS total FROM employment_employees e ${rosterJoins(ctx, asOf)}
      WHERE ${population(ctx, filter)}`),
  );
  return Number(row?.total ?? 0);
}

/** 一页名册（默认按工号排序）；值是未经字段权裁剪的全量列，裁剪由调用方按可见列做。 */
export async function listRoster(
  tx: Tx,
  ctx: AccessContext,
  asOf: string,
  filter: RosterFilter,
  page: { readonly limit: number; readonly offset: number },
): Promise<Row[]> {
  const data = rows(
    await tx.execute(sql`SELECT e.id, e.code, COALESCE(v.name,e.name) AS employee_name, to_jsonb(v) AS profile,
        r.entry_date::text AS entry_date, r.start_date::text AS start_date, cur_end.end_date,
        r.current_employee_status AS employee_status, r.last_work_date::text AS own_last_work_date,
        nx.last_work_date AS next_last_work_date, jl.name AS level_name,
        r.current_fields->>'department_id' AS department_id, r.current_fields->>'place' AS place,
        (SELECT et.name FROM employment_types et WHERE et.tenant_id=${ctx.tenantId}
          AND et.id::text=r.current_fields->>'employment_type') AS employment_type,
        r.current_fields->>'employment_form' AS employment_form,
        COALESCE(dmv.name, dm.name) AS direct_manager_name, dmv.work_email AS direct_manager_email,
        pi.has_probation, pi.start_date::text AS probation_start_date, pi.end_date::text AS probation_end_date,
        pv.months::integer AS probation_months, reg.effective_date AS regularization_date,
        ct.type_name AS contract_type, ct.term_type AS contract_term_type,
        ct.effective_date::text AS contract_effective_date, ct.end_date::text AS contract_end_date,
        ct.term_months AS contract_term_months, ct.actual_termination_date::text AS contract_actual_termination_date
      FROM employment_employees e ${rosterJoins(ctx, asOf)}
      WHERE ${population(ctx, filter)}
      ORDER BY e.code COLLATE "C", e.id
      LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const organizations = await rosterOrganizations(
    tx,
    ctx.tenantId,
    asOf,
    data.map((row) => row.department_id as string | null),
  );
  return data.map((row) => rosterRow(row, asOf, organizations));
}

/** 一行的全量列（键 = ROSTER_COLUMNS 的 key）；年龄 / 司龄 / 工龄按 asOf 计算。 */
function rosterRow(row: Row, asOf: string, organizations: Awaited<ReturnType<typeof rosterOrganizations>>): Row {
  const profile = camel((row.profile ?? {}) as Row);
  const org = organizations.get(String(row.department_id));
  return {
    employeeId: row.id,
    employeeName: row.employee_name,
    code: row.code,
    level: row.level_name ?? null,
    ...Object.fromEntries(
      [
        'gender',
        'birthday',
        'educationLevel',
        'lastSchool',
        'graduateDate',
        'major',
        'mobilePhone',
        'idNumber',
        'backupMail',
        'registAddress',
        'householdAddress',
        'householdCategory',
        'nation',
        'marryCategory',
        'politicalStatus',
        'workDate',
        'emergencyContact',
        'emergencyRelationship',
        'emergencyPhone',
      ].map((key) => [key, profile[key] ?? null]),
    ),
    age: ageOn((profile.birthday as string | null) ?? null, asOf),
    partyJoinDate: null,
    entryDate: row.entry_date,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    directManagerName: row.direct_manager_name ?? null,
    directManagerEmail: row.direct_manager_email ?? null,
    employmentType: row.employment_type ?? null,
    companyTenureYears: tenureYears(row.entry_date as string, asOf),
    workTenureYears: tenureYears((profile.workDate as string | null) ?? null, asOf),
    place: row.place ?? null,
    employmentForm: row.employment_form ?? null,
    employeeStatus: Number(row.employee_status),
    hasProbation: row.has_probation ?? null,
    probationStartDate: row.probation_start_date ?? null,
    probationExpectedEndDate: row.probation_end_date ?? null,
    probationMonths: row.probation_months ?? null,
    regularizationDate: row.regularization_date ?? null,
    lastWorkDate: row.own_last_work_date ?? row.next_last_work_date ?? null,
    orgFullName: org?.fullName ?? null,
    orgLevel1: org?.levels[0] ?? null,
    orgLevel2: org?.levels[1] ?? null,
    orgLevel3: org?.levels[2] ?? null,
    contractType: row.contract_type ?? null,
    contractTermType: row.contract_term_type ?? null,
    contractEffectiveDate: row.contract_effective_date ?? null,
    contractEndDate: row.contract_end_date ?? null,
    contractTermMonths: row.contract_term_months ?? null,
    contractActualTerminationDate: row.contract_actual_termination_date ?? null,
  };
}

/** 按可见列裁剪：键不在可见列里的整列缺席（不是 null）。employeeId 是行标识，始终保留。 */
export function trimRosterRow(row: Row, visible: readonly RosterColumn[]): Row {
  const keys = new Set(visible.map((column) => column.key));
  return Object.fromEntries(Object.entries(row).filter(([key]) => key === 'employeeId' || keys.has(key)));
}
