/**
 * 人事分析 - 人事流程看板 24 个组件（docs/02_业务建模/35 B51，R2 BE-13c）。
 * 单一入口：每个组件只有一份“候选行”SQL（id / instance_id / grp / label / series / value / hit / cols），
 * 组件数字 = count(DISTINCT id)，副值 = 命中的 id 数，分组 = 按 (grp, series) 计数；明细 = 同一份候选行的分页。
 * 审批实例先按发起时间窗口、审批类别、流程所属部门筛选，可见 = 审批模块现有披露（参与人或审批管理员范围）∩ 人事分析范围；
 * ④ 的业务单据（任职业务 / Offer / 合同申请）不经审批披露，只按人事分析范围裁剪。存量实例类别为空（DEC-402），不进看板。
 */
import { sql, type Tx } from '@italent/db';
import { HR_PROCESS_COMPONENTS, HR_PROCESS_WAIT_DAYS, type ApprovalCategory } from '@italent/domain';
import type { HrProcessComponentCode } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { employmentCreator } from '../employment/context.js';
import { rowsOf } from '../employment/read-model.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';
import { current, SNAPSHOT, SUBMITTED_OR_DIRECT_JOIN } from './hr-dashboard.js';

/** 看板的计算上下文。approval 是对 approval_instances 别名 i 的审批披露谓词（路由按调用者解析）。 */
export interface ProcessContext {
  readonly tenantId: string;
  readonly asOf: string;
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly scope: ModuleScope;
  readonly approval: SQL;
  readonly category?: ApprovalCategory;
  readonly departmentId?: string;
}

export interface DetailFilter {
  readonly group?: string;
  readonly series?: string;
  readonly hit?: boolean;
}

const NULL = sql`NULL`;
const localDate = (c: ProcessContext, column: SQL) => sql`(${column} AT TIME ZONE ${c.timezone})::date`;
const inWindow = (c: ProcessContext, column: SQL) =>
  sql`${localDate(c, column)} BETWEEN ${c.from}::date AND ${c.to}::date`;
const days = (from: SQL, to: SQL) => sql`(extract(epoch FROM (${to} - ${from})) / 86400)`;
const iso = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const week = (column: SQL) => sql`to_char(date_trunc('week', ${column}::timestamp)::date, 'YYYY-MM-DD')`;
const [WAIT_LONG, WAIT_LONGER] = HR_PROCESS_WAIT_DAYS;

/** 员工 asOf 当天的主职任职（部门、直线经理取记录当前值，同 BE-12b 在职人员口径）。 */
const employmentAt = (c: ProcessContext, employee: SQL) => sql`LEFT JOIN LATERAL (
  SELECT ${current('department_id')} AS department_id, ${current('direct_manager_id')} AS direct_manager_id
  FROM employment_timeline et JOIN employment_records r ON r.tenant_id=et.tenant_id AND r.id=et.record_id
  ${SNAPSHOT}
  WHERE et.tenant_id=${c.tenantId} AND et.employee_id=${employee} AND et.valid_during @> ${c.asOf}::date
    AND r.service_type='primary' ORDER BY et.sort_order LIMIT 1) emp ON true`;

/** 成员关联的员工在 asOf 当天的主职记录是离职 / 退休：即“已离职”。 */
const userLeft = (c: ProcessContext, user: SQL) => sql`EXISTS (SELECT 1 FROM permission_user_person_links pl
  JOIN employment_timeline lt ON lt.tenant_id=pl.tenant_id AND lt.employee_id=pl.employee_id
  JOIN employment_records lr ON lr.tenant_id=lt.tenant_id AND lr.id=lt.record_id
  WHERE pl.tenant_id=${c.tenantId} AND pl.user_id=${user} AND lt.valid_during @> ${c.asOf}::date
    AND lr.service_type='primary' AND lr.kind IN ('leave','retirement'))`;

/** 组织 → asOf 当天行政维度的二级组织（租户根组织的直接下级；根自身没有二级组织）。 */
const SECOND_LEVEL = (c: ProcessContext) => sql`org_now AS (
    SELECT DISTINCT ON (org_id) id, org_id FROM org_versions
    WHERE tenant_id=${c.tenantId} AND start_date<=${c.asOf}::date ORDER BY org_id, start_date DESC, version_no DESC),
  up(org_id, node_id, depth) AS (
    SELECT org_id, org_id, 0 FROM org_now
    UNION ALL
    SELECT u.org_id, l.parent_org_id, u.depth + 1 FROM up u
    JOIN org_now v ON v.org_id=u.node_id
    JOIN org_hierarchy_links l ON l.tenant_id=${c.tenantId} AND l.version_id=v.id AND l.dimension='admin'
    WHERE u.node_id<>${c.tenantId}::uuid AND u.depth < 64),
  org_second AS (
    SELECT u.org_id, u.node_id AS second_id FROM up u
    JOIN org_now v ON v.org_id=u.node_id
    JOIN org_hierarchy_links l ON l.tenant_id=${c.tenantId} AND l.version_id=v.id AND l.dimension='admin'
      AND l.parent_org_id=${c.tenantId}::uuid)`;

/**
 * 审批实例事实表：窗口内发起、有类别、调用者可见。流程所属部门 = Offer 的录用部门，其余取主体员工 asOf 当天的主职部门；
 * 当前审批人取最早到达的待办，“当前审批人已离职”看任一待办的处理人。
 */
function facts(c: ProcessContext): SQL {
  const employment = employmentCreator(c.tenantId, sql`i.business_id`, true);
  const creator = sql`CASE WHEN i.business_type='employment' THEN ${employment}
    WHEN i.business_type='offer' THEN o.created_by ELSE i.initiator_user_id END`;
  const inner = sql`SELECT i.id, i.business_type, i.approval_category AS category, i.business_date, i.status, i.title,
      i.initiator_user_id AS initiator, i.subject_employee_id AS subject, i.created_at, i.completed_at, i.version_id,
      ${localDate(c, sql`i.created_at`)} AS started_on, ${localDate(c, sql`i.completed_at`)} AS completed_on,
      CASE WHEN i.business_type='offer' THEN o.department_id ELSE emp.department_id END AS org_id,
      emp.direct_manager_id, ${creator} AS creator_id,
      cur.assignee_user_id AS approver, cur.created_at AS arrived_at, n.name AS node_name,
      EXISTS (SELECT 1 FROM approval_tasks t WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id
        AND t.status='pending' AND ${userLeft(c, sql`t.assignee_user_id`)}) AS approver_left
    FROM approval_instances i
    LEFT JOIN offers o ON o.tenant_id=i.tenant_id AND o.id=i.business_id AND i.business_type='offer'
    ${employmentAt(c, sql`i.subject_employee_id`)}
    LEFT JOIN LATERAL (SELECT t.assignee_user_id, t.created_at, t.node_key FROM approval_tasks t
      WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id AND t.status='pending'
      ORDER BY t.created_at, t.seq LIMIT 1) cur ON true
    LEFT JOIN approval_process_nodes n ON n.tenant_id=i.tenant_id AND n.version_id=i.version_id
      AND n.node_key=cur.node_key
    WHERE i.tenant_id=${c.tenantId} AND i.approval_category IS NOT NULL AND ${inWindow(c, sql`i.created_at`)}
      AND ${c.approval} AND ${c.category ? sql`i.approval_category=${c.category}` : sql`true`}`;
  const visible = sql`CASE WHEN x.business_type IN ('offer','offer_batch')
    THEN ${scopeSql(c.scope, { org: sql`x.org_id`, creator: sql`x.creator_id` })}
    ELSE ${employmentVisibilitySql(c.scope, {
      employee: sql`x.subject`,
      department: sql`x.org_id`,
      creator: sql`x.creator_id`,
    })} END`;
  return sql`SELECT x.*, s.second_id,
      x.category<>'other' AS core, x.status IN ('running','returned') AS in_flight,
      x.business_date IS NOT NULL AND x.started_on > x.business_date AS late_submit,
      x.business_date IS NOT NULL AND x.completed_on > x.business_date AND x.started_on < x.business_date
        AS late_approval,
      ${c.asOf}::date - ${localDate(c, sql`x.arrived_at`)} AS wait_days
    FROM (${inner}) x LEFT JOIN org_second s ON s.org_id=x.org_id
    WHERE ${visible} AND ${c.departmentId ? sql`x.org_id=${c.departmentId}::uuid` : sql`true`}`;
}

/** 已通过实例的已同意任务（时效 08 / 09、晚审批 15 的主体）。 */
const doneTasks = (c: ProcessContext) => sql`SELECT t.id, t.instance_id, t.node_key, t.assignee_user_id AS approver,
    n.name AS node_name, ${days(sql`t.created_at`, sql`t.acted_at`)} AS duration, f.core, f.late_approval
  FROM facts f JOIN approval_tasks t ON t.tenant_id=${c.tenantId} AND t.instance_id=f.id AND t.status='approved'
    AND t.acted_at IS NOT NULL AND t.assignee_user_id IS NOT NULL
  LEFT JOIN approval_process_nodes n ON n.tenant_id=t.tenant_id AND n.version_id=f.version_id AND n.node_key=t.node_key
  WHERE f.status='approved'`;

/** 已通过实例 ID（业务单据的“审批总量”：走了流程且审批通过）。 */
const approvedInstance = (c: ProcessContext, type: string, id: SQL) => sql`(SELECT ai.id FROM approval_instances ai
  WHERE ai.tenant_id=${c.tenantId} AND ai.business_type=${type}
    AND ai.business_id=${id} AND ai.status='approved' ORDER BY ai.completed_at DESC LIMIT 1)`;

/**
 * ④ 业务单据：按提交 / 办理（直接办理 = 保存）时刻或 Offer / 合同的创建时刻落入窗口；在途、撤回、作废的不算业务总量。
 * 任职业务按记录部门的二级组织分组，Offer 按录用部门，合同按签约公司。
 */
function businesses(c: ProcessContext): SQL {
  const employment = sql`SELECT b.id, ${approvedInstance(c, 'employment', sql`b.id`)} AS instance_id,
      CASE WHEN p.kind='leave' THEN 'exit' WHEN p.kind='transfer' THEN 'transfer' ELSE 'regularization' END AS kind,
      p.department_id AS org_id, b.employee_id,
      ${employmentVisibilitySql(c.scope, {
        employee: sql`b.employee_id`,
        department: sql`p.department_id`,
        creator: employmentCreator(c.tenantId, sql`b.id`, true),
      })} AS visible
    FROM employment_business_objects b
    JOIN LATERAL (SELECT p.* FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT s.state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    ${SUBMITTED_OR_DIRECT_JOIN}
    WHERE b.tenant_id=${c.tenantId} AND p.kind IN ('transfer','leave','regularization','intern_regularization')
      AND s.state IN ('approved','effective') AND ${inWindow(c, sql`sub.at`)}`;
  const offer = sql`SELECT o.id, ${approvedInstance(c, 'offer', sql`o.id`)} AS instance_id, 'offer' AS kind,
      o.department_id AS org_id, NULL::uuid AS employee_id, o.approval_status='approved' AS approved,
      ${scopeSql(c.scope, { org: sql`o.department_id`, creator: sql`o.created_by` })} AS visible
    FROM offers o WHERE o.tenant_id=${c.tenantId} AND o.status<>'invalid' AND ${inWindow(c, sql`o.created_at`)}`;
  const contract = sql`SELECT q.id, ${approvedInstance(c, 'contract', sql`q.id`)} AS instance_id, 'contract' AS kind,
      emp.department_id AS org_id, q.employee_id, q.company_id,
      ${employmentVisibilitySql(c.scope, {
        employee: sql`q.employee_id`,
        department: sql`emp.department_id`,
        creator: sql`q.created_by`,
      })} AS visible
    FROM contract_requests q ${employmentAt(c, sql`q.employee_id`)}
    WHERE q.tenant_id=${c.tenantId} AND q.status IN ('approved','effective') AND ${inWindow(c, sql`q.created_at`)}`;
  return sql`SELECT u.id, u.instance_id, u.kind, u.org_id, u.hit,
      CASE WHEN u.kind='offer' THEN u.org_id::text WHEN u.kind='contract' THEN u.company_id::text
        ELSE s.second_id::text END AS grp
    FROM (
      SELECT id, instance_id, kind, org_id, NULL::uuid AS company_id, instance_id IS NOT NULL AS hit, visible
        FROM (${employment}) e
      UNION ALL SELECT id, instance_id, kind, org_id, NULL::uuid, approved, visible FROM (${offer}) o
      UNION ALL SELECT id, instance_id, kind, org_id, company_id, instance_id IS NOT NULL, visible FROM (${contract}) q
    ) u LEFT JOIN org_second s ON s.org_id=u.org_id
    WHERE u.visible AND ${c.departmentId ? sql`u.org_id=${c.departmentId}::uuid` : sql`true`}
      AND ${c.category ? sql`u.kind=${c.category}` : sql`true`}`;
}

interface Pick {
  readonly id?: SQL;
  readonly instance?: SQL;
  readonly grp?: SQL;
  readonly label?: SQL;
  readonly series?: SQL;
  readonly value?: SQL;
  readonly hit?: SQL;
  readonly cols?: SQL;
}
/** 候选行的统一列（UNION ALL 各组件时列序一致）。 */
const select = (code: HrProcessComponentCode, p: Pick, from: SQL) =>
  sql`SELECT ${code}::text AS code, (${p.id ?? sql`f.id`})::text AS id,
    (${p.instance ?? sql`f.id`})::text AS instance_id,
    (${p.grp ?? NULL})::text AS grp, (${p.label ?? NULL})::text AS label, (${p.series ?? NULL})::text AS series,
    (${p.value ?? NULL})::numeric AS value, (${p.hit ?? NULL})::boolean AS hit, (${p.cols ?? NULL})::jsonb AS cols
    ${from}`;

const IN_FLIGHT = sql`FROM facts f WHERE f.core AND f.in_flight`;
const APPROVED = sql`FROM facts f WHERE f.status='approved'`;
const QUALITY = sql`FROM facts f WHERE f.status='approved' AND f.core`;
const LAGGED = sql`FROM facts f WHERE f.status='approved' AND f.core AND f.business_date IS NOT NULL`;
const DURATION = days(sql`f.created_at`, sql`f.completed_at`);
const SUBMIT_LAG = sql`f.started_on - f.business_date`;
const APPROVE_LAG = sql`f.completed_on - f.business_date`;
const task = (p: Pick, where: SQL) => ({
  id: sql`t.id`,
  instance: sql`t.instance_id`,
  value: sql`t.duration`,
  ...p,
  from: sql`FROM done_tasks t WHERE ${where}`,
});
const usage = (kind: string) => ({
  id: sql`b.id`,
  instance: sql`b.instance_id`,
  grp: sql`b.grp`,
  hit: sql`b.hit`,
  from: sql`FROM businesses b WHERE b.kind=${kind}`,
});

/** 7.2.05 明细 14 列（实例 ID、名称、类别、当前节点 / 审批人 / 人员状态、部门、直线经理、发起人、时刻、业务日期、异常、等待段、审批计数）。 */
function listColumns(c: ProcessContext): SQL {
  return sql`jsonb_build_object('instanceId', f.id, 'title', f.title, 'category', f.category,
    'currentNode', f.node_name, 'currentApproverUserId', f.approver,
    'approverStatus', CASE WHEN f.approver IS NULL THEN NULL WHEN ${userLeft(c, sql`f.approver`)} THEN 'left'
      ELSE 'active' END,
    'departmentId', f.org_id, 'directManagerId', f.direct_manager_id, 'initiatorUserId', f.initiator,
    'startedAt', ${iso(sql`f.created_at`)}, 'arrivedAt', ${iso(sql`f.arrived_at`)},
    'businessDate', f.business_date::text,
    'abnormalTypes', to_jsonb(array_remove(ARRAY[CASE WHEN f.approver_left THEN 'approverLeft' END,
      CASE WHEN f.business_date < ${c.asOf}::date THEN 'expired' END], NULL)),
    'waitBucket', CASE WHEN f.wait_days > ${WAIT_LONGER} THEN 'gt7' WHEN f.wait_days > ${WAIT_LONG} THEN 'gt3'
      ELSE 'le3' END,
    'approvedCount', (SELECT count(*) FROM approval_tasks t WHERE t.tenant_id=${c.tenantId} AND t.instance_id=f.id
      AND t.status='approved'))`;
}

type Spec = Pick & { readonly from: SQL };
function specs(c: ProcessContext): Readonly<Record<HrProcessComponentCode, Spec>> {
  const abnormal = sql`CROSS JOIN LATERAL (VALUES ('approverLeft', f.approver_left),
    ('expired', f.business_date < ${c.asOf}::date)) a(type, matched)`;
  return {
    inFlightCount: { hit: sql`f.in_flight`, from: sql`FROM facts f WHERE f.core` },
    inFlightAbnormal: {
      grp: sql`a.type`,
      from: sql`FROM facts f ${abnormal} WHERE f.core AND f.in_flight AND a.matched`,
    },
    inFlightWaiting: { hit: sql`f.wait_days > ${WAIT_LONGER}`, from: sql`${IN_FLIGHT} AND f.wait_days > ${WAIT_LONG}` },
    inFlightByApprover: {
      grp: sql`t.assignee_user_id`,
      series: sql`f.category`,
      from: sql`FROM facts f JOIN approval_tasks t ON t.tenant_id=${c.tenantId} AND t.instance_id=f.id
        AND t.status='pending' WHERE f.core AND f.in_flight`,
    },
    inFlightList: { cols: listColumns(c), from: IN_FLIGHT },
    durationByWeek: { grp: week(sql`f.started_on`), value: DURATION, from: APPROVED },
    durationByCategory: { grp: sql`f.category`, value: DURATION, from: APPROVED },
    taskDurationByNode: task({ grp: sql`t.node_key`, label: sql`t.node_name` }, sql`true`),
    taskDurationByApprover: task({ grp: sql`t.approver` }, sql`true`),
    durationByOrg: { grp: sql`f.second_id`, value: DURATION, from: APPROVED },
    nonCompliantByWeek: { grp: week(sql`f.started_on`), hit: sql`f.late_submit OR f.late_approval`, from: QUALITY },
    lateSubmitByCategory: { grp: sql`f.category`, from: sql`${QUALITY} AND f.late_submit` },
    lateSubmitByInitiator: { grp: sql`f.initiator`, from: sql`${QUALITY} AND f.late_submit` },
    lateApprovalByCategory: { grp: sql`f.category`, from: sql`${QUALITY} AND f.late_approval` },
    lateApprovalByApprover: task({ grp: sql`t.approver`, value: NULL }, sql`t.core AND t.late_approval`),
    submitLag: { value: SUBMIT_LAG, from: LAGGED },
    submitLagByCategory: { grp: sql`f.category`, value: SUBMIT_LAG, from: LAGGED },
    approveLag: { value: APPROVE_LAG, from: LAGGED },
    approveLagByCategory: { grp: sql`f.category`, value: APPROVE_LAG, from: LAGGED },
    offerApprovalRate: usage('offer'),
    transferApprovalRate: usage('transfer'),
    exitApprovalRate: usage('exit'),
    regularizationApprovalRate: usage('regularization'),
    contractApprovalRate: usage('contract'),
  };
}

/** 有副值的组件（副值 = 命中的明细数，rate = 副值 ÷ 主值）。 */
const WITH_HITS = new Set<HrProcessComponentCode>([
  'inFlightCount',
  'inFlightWaiting',
  'nonCompliantByWeek',
  'offerApprovalRate',
  'transferApprovalRate',
  'exitApprovalRate',
  'regularizationApprovalRate',
  'contractApprovalRate',
]);

function statement(c: ProcessContext, codes: readonly HrProcessComponentCode[], tail: SQL): SQL {
  const all = specs(c);
  const rows = codes.map((code) => select(code, all[code], all[code].from));
  return sql`WITH RECURSIVE ${SECOND_LEVEL(c)},
    facts AS MATERIALIZED (${facts(c)}),
    done_tasks AS MATERIALIZED (${doneTasks(c)}),
    businesses AS MATERIALIZED (${businesses(c)}),
    candidates AS (${sql.join(rows, sql` UNION ALL `)})
    ${tail}`;
}

const round = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const ratio = (hits: number | null, total: number) =>
  hits === null || total === 0 ? null : Math.round((hits / total) * 10_000) / 10_000;

interface Aggregate {
  code: HrProcessComponentCode;
  whole: number;
  grp: string | null;
  series: string | null;
  label: string | null;
  count: number;
  hits: number;
  average: string | null;
}

/** 24 个组件的主数、副值、平均值与分组：一条语句、同一快照。 */
export async function hrProcessOverview(tx: Tx, c: ProcessContext) {
  const codes = HR_PROCESS_COMPONENTS.map((item) => item.code);
  const rows = rowsOf<Aggregate>(
    await tx.execute(
      statement(
        c,
        codes,
        sql`SELECT code, GROUPING(grp, series)::int AS whole, grp, series, max(label) AS label,
          count(DISTINCT id)::int AS count, (count(DISTINCT id) FILTER (WHERE hit))::int AS hits,
          round(avg(value), 2)::text AS average
        FROM candidates GROUP BY GROUPING SETS ((code), (code, grp, series)) ORDER BY code, grp, series`,
      ),
    ),
  );
  return HR_PROCESS_COMPONENTS.map((component) => {
    const mine = rows.filter((row) => row.code === component.code);
    const whole = mine.find((row) => Number(row.whole) !== 0);
    const total = Number(whole?.count ?? 0);
    const hits = WITH_HITS.has(component.code) ? Number(whole?.hits ?? 0) : null;
    const groups = mine
      .filter((row) => Number(row.whole) === 0 && row.grp !== null)
      .map((row) => {
        const groupHits = hits === null ? null : Number(row.hits);
        return {
          key: row.grp!,
          label: row.label,
          series: row.series,
          count: Number(row.count),
          hits: groupHits,
          rate: ratio(groupHits, Number(row.count)),
          average: round(row.average),
        };
      });
    return { ...component, total, hits, rate: ratio(hits, total), average: round(whole?.average), groups };
  });
}

interface DetailRow {
  total: number;
  id: string | null;
  instance_id: string | null;
  grp: string | null;
  series: string | null;
  value: string | null;
  hit: boolean | null;
  cols: Record<string, unknown> | null;
}

/** 组件明细一页：按组 / 系列 / 是否命中过滤后按 id 去重；总数与本页在同一条语句、同一份物化结果里取。 */
export async function hrProcessPage(
  tx: Tx,
  code: HrProcessComponentCode,
  c: ProcessContext,
  filter: DetailFilter,
  page: { readonly limit: number; readonly offset: number },
) {
  const where = [
    filter.group === undefined ? sql`true` : sql`grp=${filter.group}`,
    filter.series === undefined ? sql`true` : sql`series=${filter.series}`,
    filter.hit === undefined ? sql`true` : sql`hit=${filter.hit}`,
  ];
  const rows = rowsOf<DetailRow>(
    await tx.execute(
      statement(
        c,
        [code],
        sql`, picked AS MATERIALIZED (SELECT DISTINCT ON (id) * FROM candidates WHERE ${sql.join(where, sql` AND `)}
            ORDER BY id, grp, series),
          counted AS (SELECT count(*)::int AS total FROM picked)
        SELECT counted.total, page.* FROM counted
        LEFT JOIN LATERAL (SELECT * FROM picked ORDER BY id LIMIT ${page.limit} OFFSET ${page.offset}) page ON true
        ORDER BY page.id`,
      ),
    ),
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    items: rows
      .filter((row) => row.id)
      .map((row) => ({
        id: row.id!,
        instanceId: row.instance_id,
        group: row.grp,
        series: row.series,
        value: round(row.value),
        hit: row.hit,
        ...(row.cols ?? {}),
      })),
  };
}
