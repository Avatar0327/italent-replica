/**
 * R2-T04 BE-5d1 退休五视图与详情的读取（docs/08_设计/R2-T04_退休设计.md §10）。
 * 即将退休 / 过期未退休按员工取行（人事 P 在 asOf 时已知的最新版本 + asOf 当天主职时间轴 + 当前周期的退休单），
 * 退休中 / 已完成 / 全部 / 撤销按退休单取行；离职视图的候选集、分页、字段裁剪都复用 exit-queries.ts（DEC-431①），
 * 这里只加退休的谓词、列与响应路径。所有视图在分页前叠加 employmentVisibilitySql（DEC-177）。
 * asOf 是业务有效日：状态、载荷、时间轴都取查询时的当前数据，只有“已提交 / 已存在”与人事版本按 asOf 当日结束（租户时区）折算。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, type RetirementBillView, type RetirementPersonView } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { employmentCreator } from './context.js';
import {
  exitCandidates,
  EXIT_RESPONSE_DEPENDENCIES,
  EXIT_SORT_DEPENDENCIES,
  exitDetailPayload,
  loadExitDetail,
  on,
  pageOfCandidates,
  toItem,
  trimWith,
  type CandidateSource,
  type Dependency,
  type ExitDetail,
  type ExitRow,
  type ExitViewable,
  viewPredicate,
} from './exit-queries.js';
import { personnelHooks } from './personnel-hooks.js';
import type { EmploymentScope, PageQuery } from './types.js';
import { employmentVisibilitySql } from './visibility.js';

export interface RetirementAsOf {
  /** 业务有效日 YYYY-MM-DD。 */
  readonly asOf: string;
  readonly timezone: string;
}

/** asOf 当日结束（次日 0 点，租户时区）的时刻：记录时间严格早于它即“asOf 时已知”。 */
const dayEnd = ({ asOf, timezone }: RetirementAsOf): SQL =>
  sql`((${asOf}::date + 1)::timestamp AT TIME ZONE ${timezone})`;

// ---- 退休单行（退休中 / 已完成 / 全部）--------------------------------------------------------------------------------

/** 退休单在离职候选集之上的追加：退休扩展行与“首个 in_review / approved 事件”的时间（已提交的事实依据）。 */
export const RETIREMENT_SOURCE: CandidateSource = {
  kind: 'retirement',
  columns: sql`rr.retire_type AS "retireType", rr.re_employed AS "reEmployed",
      rr.expected_retirement_date::text AS "expectedRetirementDate", sub.at AS "submittedAt",`,
  joins: sql`LEFT JOIN retirement_requests rr ON rr.tenant_id=x.tenant_id AND rr.business_id=x.business_id
    LEFT JOIN LATERAL (SELECT min(ev.created_at) AS at FROM employment_state_events ev
      WHERE ev.tenant_id=b.tenant_id AND ev.business_id=b.id AND ev.state IN ('in_review','approved')) sub ON true`,
};

/** 撤销视图（设计第 357 行）：额外取值，不计入五视图常量；行集合与排序沿用离职撤销视图（#432），只按 kind 限定退休。 */
export const RETIREMENT_CANCELLED_VIEW = 'cancelled';
export type RetirementListedBillView = RetirementBillView | typeof RETIREMENT_CANCELLED_VIEW;

/** 谓词表（§10.2）：processing = 流程中，或 effective 且 E′ > asOf 且已提交；completed = effective 且 E′ ≤ asOf。 */
function billPredicate(view: RetirementListedBillView, at: RetirementAsOf): SQL {
  const end = dayEnd(at);
  switch (view) {
    case 'processing':
      return sql`sub.at < ${end} AND (s.state IN ('in_review','approved')
        OR (s.state='effective' AND p.effective_date>${at.asOf}::date))`;
    case 'completed':
      return sql`s.state='effective' AND p.effective_date<=${at.asOf}::date`;
    case 'all':
      return sql`b.created_at < ${end}`;
    case RETIREMENT_CANCELLED_VIEW:
      // 不按 asOf 过滤（同离职撤销视图）：撤销记录只增不删，撤销是已发生的事实
      return viewPredicate('cancellations');
  }
}

/** 默认排序沿用离职对应视图（退休中 = 离职中的最后工作日升序，已完成降序，全部按创建时间降序）。 */
const BILL_SORT = {
  processing: EXIT_SORT_DEPENDENCIES.in_progress,
  completed: EXIT_SORT_DEPENDENCIES.completed,
  all: EXIT_SORT_DEPENDENCIES.all,
  cancelled: EXIT_SORT_DEPENDENCIES.cancellations,
} as const;

interface RetirementRow extends ExitRow {
  retireType: string | null;
  reEmployed: boolean | null;
  expectedRetirementDate: string | null;
  submittedAt: string | Date | null;
}

/** 离职专用列对退休恒为空（设计 §2.2），不进响应。 */
const LEAVE_ONLY_KEYS = [
  'exitTypeCode',
  'exitTypeName',
  'reasonCode',
  'reasonName',
  'whereaboutsCode',
  'whereaboutsName',
  'compensationAmount',
  'nonCompeteAmount',
  'lastPayDate',
  'socialInsuranceEndMonth',
  'annualLeaveSettled',
  'taxPeriod',
  'taxYear',
  'employerName',
  'actualLeaveDate',
  'attachmentRefs',
] as const;

function withoutLeaveOnly<T extends object>(value: T): Record<string, unknown> {
  const kept = { ...value } as Record<string, unknown>;
  for (const key of LEAVE_ONLY_KEYS) delete kept[key];
  return kept;
}

function toRetirementItem(row: RetirementRow) {
  const { retireType, reEmployed, expectedRetirementDate, submittedAt: _submittedAt, ...exit } = row;
  return withoutLeaveOnly({
    ...toItem(exit),
    retireType,
    reEmployed: reEmployed ?? false,
    expectedRetirementDate,
  });
}

/** 退休单响应路径 = 离职路径表 + 退休扩展字段（退休类型、是否同时返聘、创建时快照的预计退休日期；任职记录字段权）。 */
export const RETIREMENT_RESPONSE_DEPENDENCIES: Readonly<Record<string, Dependency>> = {
  ...EXIT_RESPONSE_DEPENDENCIES,
  retireType: on('retireType'),
  reEmployed: on('reEmployed'),
  expectedRetirementDate: on('expectedRetirementDate'),
};

export async function listRetirementBills(
  tx: Tx,
  tenantId: string,
  input: {
    readonly view: RetirementListedBillView;
    readonly at: RetirementAsOf;
    readonly page: PageQuery;
    readonly show: ExitViewable;
  },
  scope: EmploymentScope | undefined,
) {
  const rule = BILL_SORT[input.view];
  const order = rule.anyOf.some(input.show.employment) ? rule.order : sql`b.id`;
  const { rows, total } = await pageOfCandidates<RetirementRow>(
    tx,
    exitCandidates(tenantId, scope, [billPredicate(input.view, input.at)], order, RETIREMENT_SOURCE),
    input.page,
  );
  const trim = (row: RetirementRow) => trimWith(RETIREMENT_RESPONSE_DEPENDENCIES, toRetirementItem(row), input.show);
  return { total, items: rows.filter((row) => row.id).map(trim) };
}

/** 详情：范围外 / 不存在 / 非退休单一律 null（调用方 404）；离职专用列不输出。 */
export async function loadRetirementDetail(
  tx: Tx,
  tenantId: string,
  id: string,
  scope: EmploymentScope | undefined,
): Promise<
  (ExitDetail & { retireType: string | null; reEmployed: boolean; expectedRetirementDate: string | null }) | null
> {
  const detail = await loadExitDetail(tx, tenantId, id, scope, RETIREMENT_SOURCE);
  if (!detail) return null;
  const { retireType, reEmployed, expectedRetirementDate } = detail as unknown as RetirementRow;
  return { ...detail, retireType, reEmployed: reEmployed ?? false, expectedRetirementDate };
}

export function trimRetirementDetail(
  detail: NonNullable<Awaited<ReturnType<typeof loadRetirementDetail>>>,
  show: ExitViewable,
) {
  const { submittedAt: _submittedAt, ...payload } = exitDetailPayload(detail) as ReturnType<
    typeof exitDetailPayload
  > & {
    submittedAt?: unknown;
  };
  return trimWith(RETIREMENT_RESPONSE_DEPENDENCIES, withoutLeaveOnly(payload), show);
}

// ---- 员工行（即将退休 / 过期未退休）-----------------------------------------------------------------------------------

const PERSON_FIELD = (field: string): Dependency => ({ field, object: 'employee' });

/** 员工行的响应路径：人事 P / 弹性上下限按人员对象字段权，到期天数由 P 派生、跟随 P；部门 / 职务按任职记录字段权。 */
export const RETIREMENT_PERSON_DEPENDENCIES: Readonly<Record<string, Dependency>> = {
  employeeId: on('employeeId'),
  name: PERSON_FIELD('name'),
  code: PERSON_FIELD('code'),
  departmentId: on('departmentId'),
  positionId: on('positionId'),
  expectedRetirementDate: PERSON_FIELD('expectedRetirementDate'),
  daysToRetirement: PERSON_FIELD('expectedRetirementDate'),
  earliestRetirementDate: PERSON_FIELD('earliestRetirementDate'),
  latestRetirementDate: PERSON_FIELD('latestRetirementDate'),
};

/** 本周期（S）已有“流程中”或 effective 的退休单：员工不再是“即将 / 过期”（§10.2 周期限定）。 */
function blockedByBill(at: RetirementAsOf): SQL {
  return sql`EXISTS (SELECT 1 FROM exit_requests x
    JOIN LATERAL (SELECT v.kind FROM employment_payload_versions v WHERE v.tenant_id=x.tenant_id
      AND v.business_id=x.business_id ORDER BY v.version_no DESC LIMIT 1) bp ON true
    JOIN LATERAL (SELECT ev.state FROM employment_state_events ev WHERE ev.tenant_id=x.tenant_id
      AND ev.business_id=x.business_id ORDER BY ev.event_no DESC LIMIT 1) bs ON true
    WHERE x.tenant_id=t.tenant_id AND x.employee_id=t.employee_id AND x.staff_id=t.staff_id AND bp.kind='retirement'
      AND (bs.state='effective' OR (bs.state IN ('in_review','approved') AND EXISTS (SELECT 1
        FROM employment_state_events ev WHERE ev.tenant_id=x.tenant_id AND ev.business_id=x.business_id
          AND ev.state IN ('in_review','approved') AND ev.created_at < ${dayEnd(at)}))))`;
}

function personCandidates(
  tenantId: string,
  scope: EmploymentScope | undefined,
  input: { readonly view: RetirementPersonView; readonly at: RetirementAsOf; readonly upcomingDays: number },
  order: SQL,
): SQL {
  const { asOf } = input.at;
  const department = sql`COALESCE(snap.department_id, r.department_id)`;
  const window =
    input.view === 'overdue'
      ? sql`pv.expected_retirement_date < ${asOf}::date`
      : sql`pv.expected_retirement_date BETWEEN ${asOf}::date AND ${asOf}::date + ${input.upcomingDays}::int`;
  const visible = employmentVisibilitySql(scope, {
    employee: sql`e.id`,
    department,
    creator: employmentCreator(tenantId, sql`e.id`),
  });
  return sql`
    SELECT e.id AS "employeeId", e.code, ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      ${department} AS "departmentId", COALESCE(snap.position_id, r.position_id) AS "positionId",
      pv.expected_retirement_date::text AS "expectedRetirementDate",
      (pv.expected_retirement_date - ${asOf}::date)::int AS "daysToRetirement",
      pv.earliest_retirement_date::text AS "earliestRetirementDate",
      pv.latest_retirement_date::text AS "latestRetirementDate",
      row_number() OVER (ORDER BY ${order}) AS ord
    FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    JOIN employment_employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id
    JOIN employment_cycles c ON c.tenant_id=t.tenant_id AND c.employee_id=t.employee_id AND c.id=t.staff_id
    LEFT JOIN LATERAL employment_record_status(r.tenant_id, r.id) s ON true
    LEFT JOIN LATERAL (SELECT v.department_id, v.position_id FROM employment_payload_versions v
      WHERE v.tenant_id=r.tenant_id AND v.business_id=r.id AND v.is_record_snapshot
      ORDER BY v.version_no DESC LIMIT 1) snap ON true
    JOIN LATERAL (SELECT v.* FROM personnel_employee_versions v WHERE v.tenant_id=t.tenant_id
      AND v.employee_id=t.employee_id AND v.created_at < ${dayEnd(input.at)}
      ORDER BY v.revision DESC LIMIT 1) pv ON true
    WHERE t.tenant_id=${tenantId} AND t.valid_during @> ${asOf}::date AND r.service_type='primary'
      AND r.kind NOT IN ('leave','retirement') AND s.employee_status <> ${EMPLOYEE_STATUS.pendingEntry}
      AND pv.expected_retirement_date >= c.entry_date AND ${window}
      AND NOT ${blockedByBill(input.at)} AND ${visible}
  `;
}

export async function listRetirementPersons(
  tx: Tx,
  tenantId: string,
  input: {
    readonly view: RetirementPersonView;
    readonly at: RetirementAsOf;
    readonly upcomingDays: number;
    readonly page: PageQuery;
    readonly show: ExitViewable;
  },
  scope: EmploymentScope | undefined,
) {
  // 看不到 P 的人不能借排序反推 P：改用员工 ID 稳定排序（同离职视图的排序回退）
  const order = input.show.employee('expectedRetirementDate') ? sql`pv.expected_retirement_date, e.id` : sql`e.id`;
  const { rows, total } = await pageOfCandidates<Record<string, unknown>>(
    tx,
    personCandidates(tenantId, scope, input, order),
    input.page,
  );
  const items = rows
    .filter((row) => row.employeeId)
    .map(({ ord: _ord, total: _total, ...item }) => trimWith(RETIREMENT_PERSON_DEPENDENCIES, item, input.show));
  return { total, items };
}
