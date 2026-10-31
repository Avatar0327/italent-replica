/**
 * 人事分析 - 人事看板 23 项指标（docs/02_业务建模/35 §2.1，R2-T10 BE-12b）。
 * 单一入口：每个指标只有一份“候选行”SQL（id / employee_id / org_id / creator_id 四列），数字 = count(候选行)，
 * 明细 = 同一份候选行的分页——数字与明细不会各写一套条件。候选行的谓词复用已合入视图（试用期 BE-3、入职 BE-2b、
 * 离职 BE-4 / 退休 BE-5 的 exitCandidates + billPredicate、合同、Offer 视图），这里只加看板自己的口径差异。
 * 数据范围在候选行之外统一叠加一次（人员 / 任职记录类按 DEC-177 可见谓词，组织类按组织，Offer 按录用部门与创建人）。
 * asOf 是业务有效日：“截至当前 / 本年 / 本月 / 未来 30 天 / 已过期”都相对它算；Offer 没有历史版本，只认当前状态。
 */
import { contractRecords, contractRequests, offers, sql, type Tx } from '@italent/db';
import {
  addDays,
  EMPLOYEE_STATUS,
  HR_DASHBOARD_INDICATORS,
  HR_DASHBOARD_SOON_DAYS,
  offerView,
  type HrDashboardCode,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { settings as contractSettings } from '../contracts/configuration.js';
import { expiredUnrenewedContract, expiringContract } from '../contracts/queries.js';
import { employmentCreator } from '../employment/context.js';
import { entryViewPredicate } from '../employment/entry-views.js';
import { ENTRY_KINDS } from '../employment/employee-status.js';
import { exitCandidates, LEAVE_SOURCE, type CandidateSource } from '../employment/exit-queries.js';
import { probationViewRows } from '../employment/probation-views.js';
import { rowsOf } from '../employment/read-model.js';
import { billPredicate, RETIREMENT_SOURCE, SUBMITTED_AT_JOIN } from '../employment/retirement-views.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import { offerViewConditions } from '../offer/service.js';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';

/** 看板的计算上下文：全部相对 asOf；timezone 只用于把 Offer 发送时刻折成租户当地日期。 */
export interface DashboardAsOf {
  readonly tenantId: string;
  readonly asOf: string;
  readonly timezone: string;
  readonly scope: ModuleScope;
  readonly renewalTypeIds: readonly string[];
}

type Rows = (c: DashboardAsOf) => SQL;
type Visibility = 'employment' | 'org' | 'offer';
interface Metric {
  readonly visibility: Visibility;
  readonly rows: Rows;
}

const NULL_UUID = sql`NULL::uuid`;
/** 候选行的四列约定：明细 ID、所属员工、记录所在部门 / 组织、创建人（Offer / 合同用）。 */
const pick = (id: SQL, employee: SQL = NULL_UUID, org: SQL = NULL_UUID, creator: SQL = NULL_UUID) =>
  sql`${id} AS id, ${employee} AS employee_id, ${org} AS org_id, ${creator} AS creator_id`;
const list = (items: readonly string[]) =>
  sql.join(
    items.map((item) => sql`${item}`),
    sql`, `,
  );
const WORKING_TYPES = ['internal', 'intern'];
const yearStart = (asOf: string) => `${asOf.slice(0, 4)}-01-01`;
const monthStart = (asOf: string) => `${asOf.slice(0, 7)}-01`;
/** asOf 当日结束（次日 0 点，租户时区）：记录时间严格早于它即“asOf 时已知”（同退休视图）。 */
const dayEnd = (c: DashboardAsOf) => sql`((${c.asOf}::date + 1)::timestamp AT TIME ZONE ${c.timezone})`;

// ---- 在职人员（1、2、20、21）：asOf 当天主职时间轴上的非终止、非待入职记录 -----------------------------------------------

export const SNAPSHOT = sql`LEFT JOIN LATERAL (SELECT p.* FROM employment_payload_versions p
  WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
  ORDER BY p.version_no DESC LIMIT 1) snap ON true`;
/** 记录当前值：有最新快照取快照，否则取底表行（同 currentPersons 的口径）。 */
export const current = (column: string) =>
  sql.raw(`CASE WHEN snap.id IS NULL THEN r.${column} ELSE snap.${column} END`);

function inService(c: DashboardAsOf, extra: SQL): SQL {
  return sql`SELECT ${pick(sql`r.employee_id`, sql`r.employee_id`, current('department_id'))}
    FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    ${SNAPSHOT}
    LEFT JOIN LATERAL employment_record_status(r.tenant_id, r.id) s ON true
    WHERE t.tenant_id=${c.tenantId} AND t.valid_during @> ${c.asOf}::date AND r.service_type='primary'
      AND r.kind NOT IN ('leave','retirement') AND s.employee_status<>${EMPLOYEE_STATUS.pendingEntry} AND ${extra}`;
}
const employType = (types: readonly string[]) => sql`${current('employ_type')} IN (${list(types)})`;
const noWorkStartDate = (c: DashboardAsOf) => sql`(SELECT v.work_date FROM personnel_employee_versions v
  WHERE v.tenant_id=r.tenant_id AND v.employee_id=r.employee_id AND v.created_at < ${dayEnd(c)}
  ORDER BY v.revision DESC LIMIT 1) IS NULL`;

// ---- 入职（3、11、12）：入职类任职记录，已入职 / 待入职的判定就是入职视图自己的谓词 -------------------------------------------

function entries(c: DashboardAsOf, view: 'hired' | 'all', since?: string): SQL {
  return sql`SELECT ${pick(sql`r.employee_id`, sql`r.employee_id`, current('department_id'))}
    FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    ${SNAPSHOT}
    LEFT JOIN LATERAL employment_record_status(r.tenant_id, r.id) s ON true
    WHERE r.tenant_id=${c.tenantId} AND r.kind IN (${list(ENTRY_KINDS)}) AND ${entryViewPredicate(view, c.asOf)}
      AND ${
        since
          ? sql`t.start_date BETWEEN ${since}::date AND ${c.asOf}::date AND ${employType(WORKING_TYPES)}`
          : sql`true`
      }`;
}

// ---- 离职 / 退休（4、14、18）：离职视图与退休视图共用的候选集 exitCandidates，一份谓词两种业务 --------------------------------

const CYCLE_JOIN = sql`LEFT JOIN employment_cycles dc ON dc.tenant_id=x.tenant_id AND dc.id=x.staff_id`;
const exitSource = (kind: 'leave' | 'retirement'): CandidateSource =>
  kind === 'leave'
    ? { ...LEAVE_SOURCE, joins: sql`${SUBMITTED_AT_JOIN} ${CYCLE_JOIN}` }
    : { ...RETIREMENT_SOURCE, joins: sql`${RETIREMENT_SOURCE.joins} ${CYCLE_JOIN}` };

function exits(c: DashboardAsOf, where: SQL, byBill: boolean): SQL {
  const part = (kind: 'leave' | 'retirement') =>
    sql`SELECT ${pick(
      byBill ? sql`x.id` : sql`x."employeeId"`,
      sql`x."employeeId"`,
      sql`x."departmentId"`,
    )} FROM (${exitCandidates(c.tenantId, undefined, [where], sql`b.id`, exitSource(kind))}) x`;
  return sql`${part('leave')} UNION ALL ${part('retirement')}`;
}
/** 在途：流程中或审批通过未生效（退休视图的“退休中”谓词，离职同用；草稿 / 驳回 / 撤销不计，DEC-638 A-7）。 */
const processing = (c: DashboardAsOf) => billPredicate('processing', { asOf: c.asOf, timezone: c.timezone });
/** 已离职 / 已退休：状态已生效，最后工作日落在 [since, asOf]，内部 + 实习。 */
const finished = (c: DashboardAsOf, since: string) =>
  sql`s.state='effective' AND p.last_work_date BETWEEN ${since}::date AND ${c.asOf}::date
    AND dc.employ_type IN (${list(WORKING_TYPES)})`;

// ---- 其他任职业务（13、16、17）：按业务类型取最新载荷与最新状态 -----------------------------------------------------------

/**
 * 直接办理的调动 / 转正没有审批事件，保存即 effective（生效日在未来 = 已落地待执行，审批通过未生效的同一语义），
 * 所以“已提交”的时点取首个 in_review / approved / effective 事件；退休 / 离职走门禁，一定先经审批事件。
 */
export const SUBMITTED_OR_DIRECT_JOIN = sql`LEFT JOIN LATERAL (SELECT min(ev.created_at) AS at
  FROM employment_state_events ev
  WHERE ev.tenant_id=b.tenant_id AND ev.business_id=b.id
    AND ev.state IN ('in_review','approved','effective')) sub ON true`;

function business(c: DashboardAsOf, kind: 'transfer' | 'regularization', where: SQL, byEmployee = false): SQL {
  return sql`SELECT ${pick(byEmployee ? sql`b.employee_id` : sql`b.id`, sql`b.employee_id`, sql`p.department_id`)}
    FROM employment_business_objects b
    JOIN LATERAL (SELECT p.* FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT s.state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    ${SUBMITTED_OR_DIRECT_JOIN}
    WHERE b.tenant_id=${c.tenantId} AND p.kind=${kind} AND ${where}`;
}

// ---- 试用期（5、7）：试用期视图（BE-3）的候选行，窗口用视图自己的“预计结束日期”筛选 -------------------------------------------

function probation(c: DashboardAsOf, window: { expectedEndFrom?: string; expectedEndTo: string }): SQL {
  const department = sql`COALESCE(snap.department_id, cr.department_id)`;
  return sql`SELECT ${pick(sql`cr.employee_id`, sql`cr.employee_id`, department)}
    ${probationViewRows(c.tenantId, { view: 'all', today: c.asOf, filter: window }, undefined)}`;
}

// ---- 合同（6、8、19）：合同列表视图的谓词 -------------------------------------------------------------------------------

function contracts(a: DashboardAsOf, where: SQL): SQL {
  const rec = contractRecords;
  return sql`SELECT ${pick(sql`${rec.id}`, sql`${rec.employeeId}`, NULL_UUID, sql`${rec.createdBy}`)}
    FROM contract_records WHERE ${rec.tenantId}=${a.tenantId} AND NOT ${rec.deleted} AND ${where}`;
}
const config = (a: DashboardAsOf) => ({ renewalTypeIds: [...a.renewalTypeIds] });

// ---- Offer（9、10、15）：Offer 列表视图的状态 / 审批子状态条件 -----------------------------------------------------------

function offerRows(a: DashboardAsOf, where: SQL): SQL {
  return sql`SELECT ${pick(sql`${offers.id}`, NULL_UUID, sql`${offers.departmentId}`, sql`${offers.createdBy}`)}
    FROM offers WHERE ${offers.tenantId}=${a.tenantId} AND ${where}`;
}
const viewIs = (key: string) => sql.join(offerViewConditions(offerView(key)!), sql` AND `);

// ---- 组织（22、23）：asOf 当天的现行版本，启用的“部门”大类，不含租户根组织 -------------------------------------------------

function departments(a: DashboardAsOf, empty: 'person_in_charge_id' | 'hrbp_id'): SQL {
  return sql`SELECT ${pick(sql`v.org_id`, NULL_UUID, sql`v.org_id`)}
    FROM (SELECT DISTINCT ON (org_id) org_id, enabled, stop_date, broad_type, person_in_charge_id, hrbp_id
      FROM org_versions WHERE tenant_id=${a.tenantId} AND start_date<=${a.asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC) v
    WHERE v.org_id<>${a.tenantId}::uuid AND v.enabled AND v.stop_date>=${a.asOf}::date AND v.broad_type='部门'
      AND v.${sql.raw(empty)} IS NULL`;
}

const soonEnd = (a: DashboardAsOf) => addDays(a.asOf, HR_DASHBOARD_SOON_DAYS);

const METRICS: Readonly<Record<HrDashboardCode, Metric>> = {
  regularEmployees: { visibility: 'employment', rows: (a) => inService(a, employType(['internal'])) },
  interns: { visibility: 'employment', rows: (a) => inService(a, employType(['intern'])) },
  entriesThisYear: { visibility: 'employment', rows: (a) => entries(a, 'hired', yearStart(a.asOf)) },
  leavesThisYear: {
    visibility: 'employment',
    rows: (a) => exits(a, finished(a, yearStart(a.asOf)), false),
  },
  probationExpiring30: {
    visibility: 'employment',
    rows: (a) => probation(a, { expectedEndFrom: a.asOf, expectedEndTo: soonEnd(a) }),
  },
  contractExpiring30: {
    visibility: 'employment',
    rows: (a) => contracts(a, expiringContract(a.asOf, HR_DASHBOARD_SOON_DAYS, config(a), true)),
  },
  probationOverdue: {
    visibility: 'employment',
    rows: (a) => probation(a, { expectedEndTo: addDays(a.asOf, -1) }),
  },
  contractOverdue: {
    visibility: 'employment',
    rows: (a) => contracts(a, expiredUnrenewedContract(a.asOf, config(a), true)),
  },
  offerPending: { visibility: 'offer', rows: (a) => offerRows(a, viewIs('pending')) },
  offerSentThisMonth: {
    visibility: 'offer',
    rows: (a) =>
      offerRows(
        a,
        sql`${viewIs('sent')} AND (${offers.sentAt} AT TIME ZONE ${a.timezone})::date
          BETWEEN ${monthStart(a.asOf)}::date AND ${a.asOf}::date`,
      ),
  },
  entriesThisMonth: { visibility: 'employment', rows: (a) => entries(a, 'hired', monthStart(a.asOf)) },
  pendingEntries: { visibility: 'employment', rows: (a) => entries(a, 'all') },
  regularizedThisMonth: {
    visibility: 'employment',
    rows: (a) =>
      business(
        a,
        'regularization',
        sql`s.state='effective' AND p.effective_date BETWEEN ${monthStart(a.asOf)}::date AND ${a.asOf}::date`,
        true,
      ),
  },
  leavesThisMonth: {
    visibility: 'employment',
    rows: (a) => exits(a, finished(a, monthStart(a.asOf)), false),
  },
  offerApproving: {
    visibility: 'offer',
    rows: (a) => offerRows(a, sql`((${viewIs('approving')}) OR (${viewIs('approved')}))`),
  },
  regularizationInProgress: {
    visibility: 'employment',
    rows: (a) => business(a, 'regularization', processing(a)),
  },
  transferInProgress: { visibility: 'employment', rows: (a) => business(a, 'transfer', processing(a)) },
  exitInProgress: { visibility: 'employment', rows: (a) => exits(a, processing(a), true) },
  contractApproving: {
    visibility: 'employment',
    rows: (a) => {
      const q = contractRequests;
      return sql`SELECT ${pick(sql`${q.id}`, sql`${q.employeeId}`, NULL_UUID, sql`${q.createdBy}`)}
        FROM contract_requests WHERE ${q.tenantId}=${a.tenantId} AND ${q.status} IN ('in_review','approved')`;
    },
  },
  noDirectManager: {
    visibility: 'employment',
    rows: (a) => inService(a, sql`${employType(WORKING_TYPES)} AND ${current('direct_manager_id')} IS NULL`),
  },
  noWorkStartDate: {
    visibility: 'employment',
    rows: (a) => inService(a, sql`${employType(WORKING_TYPES)} AND ${noWorkStartDate(a)}`),
  },
  departmentNoHead: { visibility: 'org', rows: (a) => departments(a, 'person_in_charge_id') },
  departmentNoHrbp: { visibility: 'org', rows: (a) => departments(a, 'hrbp_id') },
};

/** 数据范围叠加一次：任职类按 DEC-177 可见谓词（记录部门或员工当前部门），组织类按组织，Offer 按录用部门 + 创建人。 */
function visible(a: DashboardAsOf, kind: Visibility): SQL {
  if (kind === 'org') return scopeSql(a.scope, { org: sql`m.org_id` });
  if (kind === 'offer') return scopeSql(a.scope, { org: sql`m.org_id`, creator: sql`m.creator_id` });
  return employmentVisibilitySql(a.scope, {
    employee: sql`m.employee_id`,
    department: sql`m.org_id`,
    creator: sql`COALESCE(m.creator_id, ${employmentCreator(a.tenantId, sql`m.employee_id`)})`,
  });
}

/**
 * 一个指标在调用者范围内的候选集合：先按候选记录做范围过滤（范围看每条记录所在部门），再按指标主体 ID 去重
 * （同一个人年内多条入职 / 离职记录只算一次，跨部门也一样）；数字与明细都从这里取，分页的 ID 因此唯一。
 */
export function indicatorRows(code: HrDashboardCode, a: DashboardAsOf): SQL {
  const metric = METRICS[code];
  return sql`SELECT DISTINCT ON (m.id) m.id, m.employee_id, m.org_id FROM (${metric.rows(a)}) m
    WHERE ${visible(a, metric.visibility)} ORDER BY m.id, m.org_id`;
}

/** 23 个数字：一条语句、同一快照。 */
export async function hrDashboardCounts(tx: Tx, a: DashboardAsOf): Promise<Map<HrDashboardCode, number>> {
  const parts = HR_DASHBOARD_INDICATORS.map(
    ({ code }) => sql`SELECT ${code} AS code, count(*)::int AS value FROM (${indicatorRows(code, a)}) rows`,
  );
  const rows = rowsOf<{ code: HrDashboardCode; value: number }>(await tx.execute(sql.join(parts, sql` UNION ALL `)));
  return new Map(rows.map((row) => [row.code, Number(row.value)]));
}

/** 明细一页：总数与本页在同一条语句、同一份物化结果里取。 */
export async function hrDashboardPage(
  tx: Tx,
  code: HrDashboardCode,
  a: DashboardAsOf,
  page: { readonly limit: number; readonly offset: number },
) {
  const rows = rowsOf<{ total: number; id: string | null; employeeId: string | null }>(
    await tx.execute(sql`
    WITH base AS MATERIALIZED (${indicatorRows(code, a)}),
      counted AS (SELECT count(*)::int AS total FROM base)
    SELECT counted.total, page.id, page.employee_id AS "employeeId" FROM counted
    LEFT JOIN LATERAL (SELECT * FROM base ORDER BY id LIMIT ${page.limit} OFFSET ${page.offset}) page ON true
    ORDER BY page.id`),
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    items: rows.filter((row) => row.id).map((row) => ({ id: row.id!, employeeId: row.employeeId })),
  };
}

/** 合同的“续签类型”配置（合同列表的“即将到期 / 过期未续签”判定要用）。 */
export async function dashboardRenewalTypes(tx: Tx, tenantId: string): Promise<string[]> {
  return (await contractSettings(tx, tenantId)).renewalTypeIds;
}
