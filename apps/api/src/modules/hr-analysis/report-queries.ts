/**
 * 人事报表的三组专用查询（F-465a；规格 35 §2.1）：1.06 合同台账、1.07 异动人员明细、1.1.02 员工任职信息。
 * 其余五张名册类报表直接复用 roster-query（同一条读取语句，不另写 SQL）。
 * 数据范围一律是 personScope(ctx) 进 WHERE，先于分页；count 与分页读取共用同一个 FROM / WHERE 构造函数，total 与本页同谓词。
 * 任职历史只读版本链本身（时间轴 + 任职记录），不建“变更前”列。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, ROSTER_EMPLOY_TYPES, ROSTER_EMPLOYEE_STATUSES, type MovementCategory } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { ENTRY_LIKE_KINDS } from '../employment/employee-status.js';
import { partTimeCurrentEndSql } from '../employment/part-time/span-sql.js';
import { personScope, type AccessContext } from '../personnel/access.js';
import { employeeJoins } from '../personnel/employee-read.js';
import { rows, type Row } from '../personnel/store.js';
import { orgDisplays } from '../org/org-display.js';

export interface Page {
  readonly limit: number;
  readonly offset: number;
}
const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const list = (values: readonly (string | number)[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** 人员头：最新档案版本（姓名）。 */
const PERSON_HEAD = sql`employment_employees e LEFT JOIN LATERAL (SELECT v.* FROM personnel_employee_versions v
  WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id ORDER BY v.revision DESC LIMIT 1) v ON true`;
/** 任职记录的最新快照载荷（编辑过的字段以它为准，同 employeeJoins）。 */
const SNAPSHOT = sql`LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
  WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
  ORDER BY p.version_no DESC LIMIT 1) snap ON true`;

const nameFilter = (name: string | undefined): SQL =>
  name ? sql` AND COALESCE(v.name,e.name) ILIKE ${like(name)}` : sql``;

async function withOrganizations(tx: Tx, ctx: AccessContext, asOf: string, data: Row[]) {
  const organizations = await orgDisplays(
    tx,
    ctx.tenantId,
    asOf,
    data.map((row) => row.department_id as string | null),
  );
  return (row: Row) => organizations.get(String(row.department_id))?.fullName ?? null;
}

// ---- 1.06 合同（协议）台账 ----------------------------------------------------------------------------------------
export interface LedgerFilter {
  readonly name?: string;
  readonly number?: string;
}

/**
 * 在职（试用 / 正式，内部员工与实习生）员工名下签订、续签产生的合同：一行一份合同。
 * 变更 / 终止产生的新版本不是签订，不进台账；没有申请单的存量合同（导入）按签订计。
 */
function ledgerFrom(ctx: AccessContext, asOf: string, filter: LedgerFilter): SQL {
  const number = filter.number ? sql` AND k.number ILIKE ${like(filter.number)}` : sql``;
  // employeeJoins 自带最新档案版本 v，不再叠 PERSON_HEAD
  return sql`FROM employment_employees e ${employeeJoins(ctx, asOf)}
    JOIN contract_records k ON k.tenant_id=e.tenant_id AND k.employee_id=e.id
      AND NOT k.deleted AND k.status<>'void' AND k.approval_status='effective'
    LEFT JOIN contract_requests q ON q.tenant_id=k.tenant_id AND q.result_id=k.id AND q.status='effective'
    LEFT JOIN contract_types kt ON kt.tenant_id=k.tenant_id AND kt.id=k.type_id
    LEFT JOIN contract_companies kc ON kc.tenant_id=k.tenant_id AND kc.id=k.company_id
    WHERE e.tenant_id=${ctx.tenantId} AND ${personScope(ctx)}
      AND r.current_employee_status IN (${list(ROSTER_EMPLOYEE_STATUSES)})
      AND r.current_fields->>'employ_type' IN (${list(ROSTER_EMPLOY_TYPES)})
      AND COALESCE(q.operation,'create') IN ('create','renew')${nameFilter(filter.name)}${number}`;
}

export async function countLedger(tx: Tx, ctx: AccessContext, asOf: string, filter: LedgerFilter) {
  const [row] = rows<{ total: string }>(
    await tx.execute(sql`SELECT count(*) AS total ${ledgerFrom(ctx, asOf, filter)}`),
  );
  return Number(row?.total ?? 0);
}

export async function listLedger(tx: Tx, ctx: AccessContext, asOf: string, filter: LedgerFilter, page: Page) {
  const data = rows(
    await tx.execute(sql`SELECT e.id AS employee_id, e.code, COALESCE(v.name,e.name) AS employee_name, k.number,
        kt.name AS type_name, kc.name AS company_name, COALESCE(q.operation,'create') AS operation, k.term_type,
        k.term_months, k.signing_date::text AS signing_date, k.effective_date::text AS effective_date,
        k.end_date::text AS end_date, k.actual_termination_date::text AS actual_termination_date
      ${ledgerFrom(ctx, asOf, filter)}
      ORDER BY e.code COLLATE "C", e.id, k.effective_date, k.version_no, k.id
      LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return data.map((row): Row => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    code: row.code,
    number: row.number,
    typeName: row.type_name ?? null,
    companyName: row.company_name ?? null,
    operation: row.operation,
    termType: row.term_type,
    termMonths: row.term_months ?? null,
    signingDate: row.signing_date ?? null,
    effectiveDate: row.effective_date,
    endDate: row.end_date ?? null,
    actualTerminationDate: row.actual_termination_date ?? null,
  }));
}

// ---- 1.07 异动人员明细 ----------------------------------------------------------------------------------------------
export interface MovementFilter {
  readonly from: string;
  readonly to: string;
  readonly category?: MovementCategory;
  readonly name?: string;
}

/** 异动类别由任职业务类型决定；组织架构调整引起的部门变化不算调动，兼职不在此表。离职类含退休（与人事看板同口径）。 */
const CATEGORY = sql`(CASE
  WHEN r.kind IN (${list(ENTRY_LIKE_KINDS)}) THEN 'entry'
  WHEN r.kind='regularization' THEN 'regularization'
  WHEN r.kind='transfer' THEN 'transfer'
  WHEN r.kind IN ('leave','retirement') THEN 'leave' END)`;

function movementFrom(ctx: AccessContext, filter: MovementFilter): SQL {
  const category = filter.category ? sql` AND ev.category=${filter.category}` : sql``;
  return sql`FROM ${PERSON_HEAD}
    JOIN LATERAL (SELECT r.id AS record_id, ${CATEGORY} AS category,
        -- 离职按最后工作日计（DEC-729），其余按任职生效日
        (CASE WHEN r.kind IN ('leave','retirement') THEN COALESCE(r.last_work_date, t.start_date) ELSE t.start_date END)
          AS event_date, COALESCE(snap.body, to_jsonb(r)) AS fields
      FROM employment_records r JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
      ${SNAPSHOT}
      WHERE r.tenant_id=e.tenant_id AND r.employee_id=e.id AND r.service_type='primary') ev ON true
    WHERE e.tenant_id=${ctx.tenantId} AND ${personScope(ctx)}
      AND ev.category IS NOT NULL AND ev.event_date BETWEEN ${filter.from}::date AND ${filter.to}::date
      -- 尚未入职（待入职）的入职记录不算已发生的入职
      AND NOT (ev.category='entry' AND (ev.fields->>'employee_status')::integer=${EMPLOYEE_STATUS.pendingEntry})
      ${category}${nameFilter(filter.name)}`;
}

export async function countMovements(tx: Tx, ctx: AccessContext, filter: MovementFilter) {
  const [row] = rows<{ total: string }>(await tx.execute(sql`SELECT count(*) AS total ${movementFrom(ctx, filter)}`));
  return Number(row?.total ?? 0);
}

export async function listMovements(tx: Tx, ctx: AccessContext, asOf: string, filter: MovementFilter, page: Page) {
  const data = rows(
    await tx.execute(sql`SELECT e.id AS employee_id, e.code, COALESCE(v.name,e.name) AS employee_name,
        ev.category, ev.event_date::text AS event_date, ev.fields->>'department_id' AS department_id,
        ev.fields->>'employ_type' AS employ_type
      ${movementFrom(ctx, filter)}
      ORDER BY ev.event_date, e.code COLLATE "C", e.id, ev.record_id
      LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const orgName = await withOrganizations(tx, ctx, asOf, data);
  return data.map((row): Row => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    code: row.code,
    category: row.category,
    date: row.event_date,
    orgFullName: orgName(row),
    employType: row.employ_type ?? null,
  }));
}

// ---- 1.1.02 员工任职信息 --------------------------------------------------------------------------------------------
export interface HistoryFilter {
  readonly name?: string;
}

/**
 * 人员的全部任职记录（版本链）：主职取时间轴区间（结束日 = 下一条生效日的前一天，最后一条为空），
 * 兼职取记录开始日与期限链当前期结束日（兼职不进时间轴）。
 */
function historyFrom(ctx: AccessContext, filter: HistoryFilter): SQL {
  return sql`FROM ${PERSON_HEAD}
    JOIN LATERAL (SELECT r.id AS record_id, r.service_type, r.kind, COALESCE(snap.body, to_jsonb(r)) AS fields,
        (CASE WHEN r.service_type='primary' THEN t.start_date ELSE r.start_date END) AS start_date,
        (CASE WHEN r.service_type<>'primary' THEN ${partTimeCurrentEndSql(ctx.tenantId, sql`r.id`)}
          WHEN isempty(t.valid_during) THEN t.start_date - 1
          WHEN upper_inf(t.valid_during) THEN NULL ELSE upper(t.valid_during) - 1 END) AS end_date
      FROM employment_records r LEFT JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
      ${SNAPSHOT}
      WHERE r.tenant_id=e.tenant_id AND r.employee_id=e.id AND (r.service_type<>'primary' OR t.record_id IS NOT NULL)) h
      ON true
    WHERE e.tenant_id=${ctx.tenantId} AND ${personScope(ctx)}${nameFilter(filter.name)}`;
}

export async function countHistory(tx: Tx, ctx: AccessContext, filter: HistoryFilter) {
  const [row] = rows<{ total: string }>(await tx.execute(sql`SELECT count(*) AS total ${historyFrom(ctx, filter)}`));
  return Number(row?.total ?? 0);
}

export async function listHistory(tx: Tx, ctx: AccessContext, asOf: string, filter: HistoryFilter, page: Page) {
  const data = rows(
    await tx.execute(sql`SELECT e.id AS employee_id, e.code, COALESCE(v.name,e.name) AS employee_name,
        h.service_type, h.kind, h.start_date::text AS start_date, h.end_date::text AS end_date,
        h.fields->>'department_id' AS department_id, h.fields->>'employ_type' AS employ_type
      ${historyFrom(ctx, filter)}
      ORDER BY e.code COLLATE "C", e.id, h.start_date, h.record_id
      LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const orgName = await withOrganizations(tx, ctx, asOf, data);
  return data.map((row): Row => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    code: row.code,
    serviceType: row.service_type,
    kind: row.kind,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    orgFullName: orgName(row),
    employType: row.employ_type ?? null,
  }));
}
