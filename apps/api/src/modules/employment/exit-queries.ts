/**
 * R2-T03 B5 离职视图与详情的读取（设计 §3.2 / §5.0A D-14 / §9.1）。
 * 四个视图（离职中 / 已完成 / 全部 / 撤销）的谓词只读申请单最新状态、扩展行与撤销记录，不读版本链（DEC-215）；
 * 部门 / 职务取前驱任职记录（最后工作日当天或之前的最后一条）。范围按 DEC-177 的可见谓词在分页之前过滤，
 * 总数与本页在同一条语句、同一份物化结果里取（并发生效时 items 与 total 不会互相越界）。
 * “原定”最后工作日 = 计划生效日（plannedEffectiveDate，§5.0A 唯一来源）− 1 天，不另算。
 */
import { sql, type Tx } from '@italent/db';
import type { OrgId } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { listOrgDescendantsInTransaction } from '../org/hierarchy-reader.js';
import { employmentCreator } from './context.js';
import { personnelHooks } from './personnel-hooks.js';
import { checkPage, rowsOf } from './read-model.js';
import { plannedEffectiveDate } from './timeline.js';
import type { EmploymentScope, EmploymentState, PageQuery } from './types.js';
import { employmentVisibilitySql } from './visibility.js';

export const EXIT_VIEWS = ['in_progress', 'completed', 'all', 'cancellations'] as const;
export type ExitView = (typeof EXIT_VIEWS)[number];

/** 申请单的八个状态（审批状态筛选的取值）。 */
export const EXIT_STATES = [
  'draft',
  'in_review',
  'approved',
  'rejected',
  'disapproved',
  'voided',
  'effective',
  'deleted',
] as const satisfies readonly EmploymentState[];

/** 发起方式筛选：direct = 直接离职（mode=direct），其余按申请的发起人身份（§3.2）。 */
export const EXIT_INITIATIONS = ['hr', 'self', 'manager', 'direct'] as const;
export type ExitInitiationFilter = (typeof EXIT_INITIATIONS)[number];

export interface ExitViewFilter {
  /** 已展开的部门集合（含下级时由 resolveDepartmentIds 展开）。 */
  readonly departmentIds?: readonly string[];
  /** 姓名或工号包含，不区分大小写。 */
  readonly keyword?: string;
  readonly lastWorkDateFrom?: string;
  readonly lastWorkDateTo?: string;
  readonly exitTypeCode?: string;
  readonly reasonCode?: string;
  readonly whereaboutsCode?: string;
  readonly status?: EmploymentState;
  readonly initiation?: ExitInitiationFilter;
}

interface ExitRow {
  id: string;
  employeeId: string;
  code: string;
  name: string;
  departmentId: string | null;
  positionId: string | null;
  lastWorkDate: string;
  plannedLastWorkDate: string;
  effectiveDate: string;
  exitTypeCode: string | null;
  exitTypeName: string | null;
  reasonCode: string | null;
  reasonName: string | null;
  whereaboutsCode: string | null;
  whereaboutsName: string | null;
  status: EmploymentState;
  mode: 'application' | 'direct';
  initiator: 'hr' | 'self' | 'manager';
  initiatorUserId: string;
  batchId: string | null;
  revision: number;
  createdAt: string | Date;
  activationStatus: 'failed' | 'suspended' | null;
  activationReason: string | null;
  blockedByBusinessId: string | null;
  cancellationId: string | null;
  cancellationReason: string | null;
  cancellationCase: string | null;
  cancellationStateBefore: string | null;
  cancellationRevision: number | null;
  cancelledAt: string | Date | null;
  /** 分页包装列（名次、总数），不进响应。 */
  ord?: unknown;
  total?: unknown;
}

export interface ExitItem {
  readonly id: string;
  readonly employeeId: string;
  readonly code: string;
  readonly name: string;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  /** 最终最后工作日 L′ / 原定最后工作日 / 最终生效日（迟到顺延后与原定不同）。 */
  readonly lastWorkDate: string;
  readonly plannedLastWorkDate: string;
  readonly effectiveDate: string;
  readonly exitTypeCode: string | null;
  readonly exitTypeName: string | null;
  readonly reasonCode: string | null;
  readonly reasonName: string | null;
  readonly whereaboutsCode: string | null;
  readonly whereaboutsName: string | null;
  readonly status: EmploymentState;
  readonly mode: 'application' | 'direct';
  readonly initiator: 'hr' | 'self' | 'manager';
  readonly initiatorUserId: string;
  readonly batchId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  /** 审批通过但生效失败 / 挂起的标记（最近一次生效尝试）；其余为 null。 */
  readonly activation: {
    readonly status: 'failed' | 'suspended';
    readonly reason: string | null;
    readonly blockedByBusinessId: string | null;
  } | null;
  readonly cancellation: {
    readonly id: string;
    readonly reason: string;
    readonly case: string;
    readonly stateBefore: string;
    readonly revision: number;
    readonly createdAt: string;
  } | null;
}

const iso = (value: string | Date) => new Date(value).toISOString();

function toItem(row: ExitRow): ExitItem {
  const {
    activationStatus,
    activationReason,
    blockedByBusinessId,
    cancellationId,
    cancellationReason,
    cancellationCase,
    cancellationStateBefore,
    cancellationRevision,
    cancelledAt,
    ord: _ord,
    total: _total,
    ...rest
  } = row;
  return {
    ...rest,
    revision: Number(row.revision),
    createdAt: iso(row.createdAt),
    activation: activationStatus ? { status: activationStatus, reason: activationReason, blockedByBusinessId } : null,
    cancellation: cancellationId
      ? {
          id: cancellationId,
          reason: cancellationReason!,
          case: cancellationCase!,
          stateBefore: cancellationStateBefore!,
          revision: Number(cancellationRevision),
          createdAt: iso(cancelledAt!),
        }
      : null,
  };
}

/** 部门筛选的最终集合：includeChildren 时并入行政维度的全部下级（含停用），同合同列表口径。 */
export async function resolveDepartmentIds(
  tx: Tx,
  tenantId: string,
  departmentId: string,
  includeChildren: boolean,
  today: string,
): Promise<string[]> {
  const ids = new Set<string>([departmentId]);
  if (includeChildren) {
    const children = await listOrgDescendantsInTransaction(
      tx,
      { tenantId, orgId: departmentId as OrgId, dimension: 'admin', asOf: today },
      { includeDisabled: true },
    );
    for (const id of children) ids.add(id);
  }
  return [...ids];
}

/** 视图谓词只读最新状态与撤销记录，三个主视图之外的状态（作废 / 删除 / 不同意）只在“全部”里。 */
function viewPredicate(view: ExitView): SQL {
  switch (view) {
    case 'in_progress':
      return sql`s.state IN ('draft','in_review','approved','rejected')`;
    case 'completed':
      return sql`s.state='effective'`;
    case 'all':
      return sql`true`;
    case 'cancellations':
      return sql`c.id IS NOT NULL`;
  }
}

/**
 * 默认排序（§3.2）及其依赖的字段（见“字段依赖表”）：查看人看不到排序键依赖的字段时，改用业务 id（随机 UUID，与任何
 * 业务字段无关）稳定排序，否则借一条已知值的参照记录就能推断其他人的先后；末位 b.id 保证翻页稳定。
 * 最后工作日与生效日只差一天、先后一致，看到其一即可按日期排。
 */
function viewOrder(view: ExitView, show: ExitViewable): SQL {
  const rule = EXIT_SORT_DEPENDENCIES[view];
  return rule.anyOf.some(show.employment) ? rule.order : sql`b.id`;
}

const SHOWN_DEPARTMENT = sql`COALESCE(prev.department_id, p.department_id)`;

function filterPredicates(tenantId: string, filter: ExitViewFilter): SQL[] {
  const parts: SQL[] = [];
  if (filter.departmentIds) parts.push(sql`${SHOWN_DEPARTMENT}=ANY(${`{${filter.departmentIds.join(',')}}`}::uuid[])`);
  if (filter.keyword) {
    const name = personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`);
    // strpos 而不是 LIKE：关键字里的 % / _ 不当通配符
    parts.push(sql`(strpos(lower(e.code), lower(${filter.keyword}))>0
      OR strpos(lower(${name}), lower(${filter.keyword}))>0)`);
  }
  if (filter.lastWorkDateFrom) parts.push(sql`p.last_work_date>=${filter.lastWorkDateFrom}::date`);
  if (filter.lastWorkDateTo) parts.push(sql`p.last_work_date<=${filter.lastWorkDateTo}::date`);
  if (filter.exitTypeCode) parts.push(sql`lower(x.exit_type_code)=lower(${filter.exitTypeCode})`);
  if (filter.reasonCode) parts.push(sql`lower(x.reason_code)=lower(${filter.reasonCode})`);
  if (filter.whereaboutsCode) parts.push(sql`lower(x.whereabouts_code)=lower(${filter.whereaboutsCode})`);
  if (filter.status) parts.push(sql`s.state=${filter.status}`);
  if (filter.initiation === 'direct') parts.push(sql`x.mode='direct'`);
  else if (filter.initiation) parts.push(sql`(x.mode='application' AND x.initiator=${filter.initiation})`);
  return parts;
}

/**
 * 候选行（范围过滤后、分页前），ord 是 order 下的全局名次。部门 / 职务：前驱任职记录 = 最终最后工作日当天或之前的
 * 最后一条时间轴记录（离职记录自己从最后工作日次日起，不会取到自己），取它最新的记录快照；
 * 单据部门（可见谓词用）优先取离职载荷自己的部门。
 */
function candidates(tenantId: string, scope: EmploymentScope | undefined, where: SQL[], order: SQL): SQL {
  const visible = employmentVisibilitySql(scope, {
    employee: sql`b.employee_id`,
    department: sql`COALESCE(p.department_id, prev.department_id)`,
    creator: employmentCreator(tenantId, sql`b.id`, true),
  });
  const name = personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`);
  const planned = plannedEffectiveDate(tenantId, sql`b.id`, sql`p.effective_date`);
  return sql`
    SELECT b.id, b.employee_id AS "employeeId", e.code, ${name} AS name,
      ${SHOWN_DEPARTMENT} AS "departmentId", prev.position_id AS "positionId",
      p.last_work_date::text AS "lastWorkDate", (${planned} - 1)::text AS "plannedLastWorkDate",
      p.effective_date::text AS "effectiveDate",
      x.exit_type_code AS "exitTypeCode", et.name AS "exitTypeName",
      x.reason_code AS "reasonCode", er.name AS "reasonName",
      x.whereabouts_code AS "whereaboutsCode", ew.name AS "whereaboutsName",
      s.state AS status, x.mode, x.initiator, x.initiator_user_id AS "initiatorUserId", x.batch_id AS "batchId",
      b.revision, b.created_at AS "createdAt",
      CASE WHEN act.outcome IN ('failed','suspended') THEN act.outcome END AS "activationStatus",
      CASE WHEN act.outcome IN ('failed','suspended') THEN act.reason END AS "activationReason",
      CASE WHEN act.outcome='suspended' THEN act.blocked_by_business_id END AS "blockedByBusinessId",
      c.id AS "cancellationId", c.reason AS "cancellationReason", c.cancel_case AS "cancellationCase",
      c.state_before AS "cancellationStateBefore", c.revision AS "cancellationRevision", c.created_at AS "cancelledAt",
      row_number() OVER (ORDER BY ${order}) AS ord
    FROM exit_requests x
    JOIN employment_business_objects b ON b.tenant_id=x.tenant_id AND b.id=x.business_id
    JOIN employment_employees e ON e.tenant_id=b.tenant_id AND e.id=b.employee_id
    JOIN LATERAL (SELECT p.* FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT s.state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN exit_cancellations c ON c.tenant_id=x.tenant_id AND c.business_id=x.business_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(snap.department_id, r.department_id) AS department_id,
        COALESCE(snap.position_id, r.position_id) AS position_id
      FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      LEFT JOIN LATERAL (SELECT v.department_id, v.position_id FROM employment_payload_versions v
        WHERE v.tenant_id=r.tenant_id AND v.business_id=r.id AND v.is_record_snapshot
        ORDER BY v.version_no DESC LIMIT 1) snap ON true
      WHERE t.tenant_id=b.tenant_id AND t.employee_id=b.employee_id AND t.start_date<=p.last_work_date
      ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1
    ) prev ON true
    LEFT JOIN LATERAL (SELECT a.outcome, a.reason, a.blocked_by_business_id FROM employment_activation_attempts a
      WHERE a.tenant_id=b.tenant_id AND a.business_id=b.id ORDER BY a.attempt_no DESC LIMIT 1) act
      ON s.state='approved'
    LEFT JOIN exit_types et ON et.tenant_id=x.tenant_id AND lower(et.code)=lower(x.exit_type_code)
    LEFT JOIN exit_reasons er ON er.tenant_id=x.tenant_id AND lower(er.code)=lower(x.reason_code)
    LEFT JOIN exit_whereabouts ew ON ew.tenant_id=x.tenant_id AND lower(ew.code)=lower(x.whereabouts_code)
    WHERE x.tenant_id=${tenantId} AND p.kind='leave' AND ${visible}
      AND ${sql.join([sql`true`, ...where], sql` AND `)}
  `;
}

/**
 * 一个视图的一页：总数与本页同一条语句、同一份物化候选集（并发生效时不会先数后取而越界）；
 * 越界页返回空 items 与同一 total。
 */
export async function listExitView(
  tx: Tx,
  tenantId: string,
  input: {
    readonly view: ExitView;
    readonly page: PageQuery;
    readonly filter: ExitViewFilter;
    readonly show: ExitViewable;
  },
  scope: EmploymentScope | undefined,
): Promise<{ items: ExitItem[]; total: number }> {
  checkPage(input.page);
  const where = [viewPredicate(input.view), ...filterPredicates(tenantId, input.filter)];
  const rows = rowsOf<ExitRow & { total: number }>(
    await tx.execute(sql`
    WITH base AS MATERIALIZED (${candidates(tenantId, scope, where, viewOrder(input.view, input.show))}),
      counted AS (SELECT count(*)::int AS total FROM base)
    SELECT counted.total, page.* FROM counted
    LEFT JOIN LATERAL (SELECT * FROM base ORDER BY ord LIMIT ${input.page.limit} OFFSET ${input.page.offset}) page
      ON true
    ORDER BY page.ord
  `),
  );
  return { total: Number(rows[0]?.total ?? 0), items: rows.filter((row) => row.id).map(toItem) };
}

/** 扩展行的业务字段（详情用）；金额按数字返回，缺省为 null。 */
export interface ExitExtension {
  readonly attachmentRefs: readonly string[] | null;
  readonly handoverEmployeeId: string | null;
  readonly addToBlacklist: boolean;
  readonly compensationAmount: number | null;
  readonly nonCompeteAmount: number | null;
  readonly lastPayDate: string | null;
  readonly socialInsuranceEndMonth: string | null;
  readonly annualLeaveSettled: boolean | null;
  readonly taxPeriod: string | null;
  readonly taxYear: number | null;
  readonly employerName: string | null;
  readonly actualLeaveDate: string | null;
  readonly dutyTransferTiming: string;
  readonly preReleaseDate: string | null;
}

export interface ExitDetail extends ExitItem, ExitExtension {
  /** 载荷版本：人工版本与系统顺延版本，按版本号升序（原定 / 最终日期的出处）。 */
  readonly versions: readonly {
    readonly versionNo: number;
    readonly effectiveDate: string;
    readonly plannedEffectiveDate: string;
    readonly lastWorkDate: string | null;
    readonly createdAt: string;
  }[];
  readonly events: readonly { readonly eventNo: number; readonly state: string; readonly createdAt: string }[];
  readonly approvalInstanceId: string | null;
  /** 效果台账只给汇总件数，不带目标 ID（目标对象的可见性由各自模块负责）。 */
  readonly effects: readonly { readonly phase: string; readonly kind: string; readonly count: number }[];
  readonly dutyTransfer: { readonly timing: string; readonly transferred: number; readonly failed: number };
}

const amount = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** 详情的附属读取：扩展行、载荷版本、状态事件、审批实例、效果台账（同一事务内逐条读取）。 */
async function loadDetailParts(tx: Tx, tenantId: string, id: string) {
  const [extension] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT attachment_refs AS "attachmentRefs", handover_employee_id AS "handoverEmployeeId",
      add_to_blacklist AS "addToBlacklist", compensation_amount AS "compensationAmount",
      non_compete_amount AS "nonCompeteAmount", last_pay_date::text AS "lastPayDate",
      social_insurance_end_month AS "socialInsuranceEndMonth", annual_leave_settled AS "annualLeaveSettled",
      tax_period AS "taxPeriod", tax_year AS "taxYear", employer_name AS "employerName",
      actual_leave_date::text AS "actualLeaveDate", duty_transfer_timing AS "dutyTransferTiming",
      pre_release_date::text AS "preReleaseDate"
    FROM exit_requests WHERE tenant_id=${tenantId} AND business_id=${id}::uuid
  `),
  );
  const versions = rowsOf<ExitDetail['versions'][number] & { createdAt: string | Date }>(
    await tx.execute(sql`
    SELECT version_no AS "versionNo", effective_date::text AS "effectiveDate",
      planned_effective_date::text AS "plannedEffectiveDate", last_work_date::text AS "lastWorkDate",
      created_at AS "createdAt"
    FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${id}::uuid ORDER BY version_no
  `),
  );
  const events = rowsOf<ExitDetail['events'][number] & { createdAt: string | Date }>(
    await tx.execute(sql`
    SELECT event_no AS "eventNo", state, created_at AS "createdAt" FROM employment_state_events
    WHERE tenant_id=${tenantId} AND business_id=${id}::uuid ORDER BY event_no
  `),
  );
  const [instance] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id FROM approval_instances WHERE tenant_id=${tenantId} AND business_type='employment'
      AND business_id=${id}::uuid ORDER BY created_at DESC, id DESC LIMIT 1
  `),
  );
  const effects = rowsOf<ExitDetail['effects'][number]>(
    await tx.execute(sql`
    SELECT phase, kind, count(*)::int AS count FROM exit_effects
    WHERE tenant_id=${tenantId} AND business_id=${id}::uuid GROUP BY phase, kind ORDER BY phase, kind
  `),
  );
  return { extension: extension!, versions, events, instance, effects };
}

/** 详情：范围外 / 不存在 / 非离职单一律返回 null（调用方 404）。 */
export async function loadExitDetail(
  tx: Tx,
  tenantId: string,
  id: string,
  scope: EmploymentScope | undefined,
): Promise<ExitDetail | null> {
  const [row] = rowsOf<ExitRow>(
    await tx.execute(sql`SELECT * FROM (${candidates(tenantId, scope, [sql`b.id=${id}::uuid`], sql`b.id`)}) base`),
  );
  if (!row) return null;
  const { extension: ext, versions, events, instance, effects } = await loadDetailParts(tx, tenantId, id);
  const counted = (kind: string) =>
    effects.filter((effect) => effect.kind === kind).reduce((sum, effect) => sum + Number(effect.count), 0);
  return {
    ...toItem(row),
    attachmentRefs: (ext.attachmentRefs as string[] | null | undefined) ?? null,
    handoverEmployeeId: (ext.handoverEmployeeId as string | null) ?? null,
    addToBlacklist: Boolean(ext.addToBlacklist),
    compensationAmount: amount(ext.compensationAmount),
    nonCompeteAmount: amount(ext.nonCompeteAmount),
    lastPayDate: (ext.lastPayDate as string | null) ?? null,
    socialInsuranceEndMonth: (ext.socialInsuranceEndMonth as string | null) ?? null,
    annualLeaveSettled: (ext.annualLeaveSettled as boolean | null) ?? null,
    taxPeriod: (ext.taxPeriod as string | null) ?? null,
    taxYear: (ext.taxYear as number | null) ?? null,
    employerName: (ext.employerName as string | null) ?? null,
    actualLeaveDate: (ext.actualLeaveDate as string | null) ?? null,
    dutyTransferTiming: ext.dutyTransferTiming as string,
    preReleaseDate: (ext.preReleaseDate as string | null) ?? null,
    versions: versions.map((version) => ({ ...version, createdAt: iso(version.createdAt) })),
    events: events.map((event) => ({ ...event, createdAt: iso(event.createdAt) })),
    approvalInstanceId: instance?.id ?? null,
    effects: effects.map((effect) => ({ ...effect, count: Number(effect.count) })),
    dutyTransfer: {
      timing: ext.dutyTransferTiming as string,
      transferred: counted('duty_transferred'),
      failed: counted('duty_failed'),
    },
  };
}

// ---- 字段依赖表（§9.1；#409 第 4～6 轮，DEC-431①）----------------------------------------------------------------
//
// 三类“依赖某个字段”的输出统一登记在这里，裁剪、筛选检查、排序回退都只读这几张表，不在各处单独判断：
//   1. 响应路径（EXIT_RESPONSE_DEPENDENCIES）：**默认拒绝**——响应里的每一个路径（顶层键、嵌套键、数组、数组元素、
//      容器）都必须在表里登记，没登记的一律不输出（无论是标量、空数组、空对象还是 null）；始终可见的路径也要显式登记为
//      field: null 并写明理由（“无需字段权”），不存在“没登记就放行”。登记的字段是任职记录字段目录里的编码
//      （MODULE_OBJECTS.employmentRecord，含 EXIT_REQUEST_SYSTEM_FIELDS；姓名 / 工号属人员对象）；由某个字段派生的值
//      （显示名、case、原定日期）跟随它的字段。容器登记整体依赖时先判整体权，无权整个键缺席（不留空壳）。
//   2. 筛选（EXIT_FILTER_DEPENDENCIES）：按它筛选等于探测它的值，须先能看到依赖的字段。
//   3. 排序（EXIT_SORT_DEPENDENCIES）：排序键依赖的字段；看不到时改用 id 排序。
// 视图归属（离职中 / 已完成 / 撤销）由视图名这一显式查询参数决定，是业务入口本身（设计 §3.2），不另按状态字段权拦截。

type Dependency =
  { readonly field: string; readonly object?: 'employee' } | { readonly field: null; readonly why: string };

const independent = (why: string): Dependency => ({ field: null, why });
const on = (field: string): Dependency => ({ field });
const CONTAINER = independent('容器本身不含值，其中每个叶子在表里各有登记的规则');

/** 键名就是任职记录字段编码的顶层叶子（逐个列出）。 */
const OWN_FIELDS = [
  'id',
  'employeeId',
  'departmentId',
  'positionId',
  'lastWorkDate',
  'effectiveDate',
  'exitTypeCode',
  'reasonCode',
  'whereaboutsCode',
  'status',
  'mode',
  'initiator',
  'initiatorUserId',
  'batchId',
  'revision',
  'createdAt',
  'handoverEmployeeId',
  'addToBlacklist',
  'compensationAmount',
  'nonCompeteAmount',
  'lastPayDate',
  'socialInsuranceEndMonth',
  'annualLeaveSettled',
  'taxPeriod',
  'taxYear',
  'employerName',
  'actualLeaveDate',
  'dutyTransferTiming',
  'preReleaseDate',
] as const;

/** 路径写法：顶层键 `key`、嵌套 `a.b`、数组 `a` 与其元素 `a[]`、元素内的键 `a[].b`。 */
export const EXIT_RESPONSE_DEPENDENCIES: Readonly<Record<string, Dependency>> = {
  ...Object.fromEntries(OWN_FIELDS.map((field) => [field, on(field)])),
  name: { field: 'name', object: 'employee' },
  code: { field: 'code', object: 'employee' },
  // 派生显示名 / 原定日期：跟随所属字段
  plannedLastWorkDate: on('lastWorkDate'),
  exitTypeName: on('exitTypeCode'),
  reasonName: on('reasonCode'),
  whereaboutsName: on('whereaboutsCode'),
  // 附件元数据 ID：数组与元素同一字段权；空数组、未填写也是该字段的值，无权时整个键缺席
  attachmentRefs: on('attachmentRefs'),
  'attachmentRefs[]': on('attachmentRefs'),
  // 生效失败 / 挂起标记（最近一次生效尝试）
  activation: on('activation'),
  'activation.status': on('activation'),
  'activation.reason': on('activation'),
  'activation.blockedByBusinessId': on('activation'),
  // 撤销信息：case 由撤销前状态决定（设计 §7.1 四种撤销情形与撤销前状态一一对应），跟随 status
  cancellation: independent('有无撤销记录由撤销视图的归属决定（视图名是显式查询参数，设计 §3.2 DM-R5）；叶子各有规则'),
  'cancellation.id': on('id'),
  'cancellation.stateBefore': on('status'),
  'cancellation.case': on('status'),
  'cancellation.revision': on('revision'),
  'cancellation.createdAt': on('createdAt'),
  'cancellation.reason': independent(
    '撤销原因文本：字段目录无独立编码，与离职原因字典的 reasonCode 无关，不派生自受控字段',
  ),
  // 详情的载荷版本（原定 / 最终日期的出处）
  versions: CONTAINER,
  'versions[]': CONTAINER,
  'versions[].versionNo': on('versionNo'),
  'versions[].createdAt': on('createdAt'),
  'versions[].effectiveDate': on('effectiveDate'),
  'versions[].plannedEffectiveDate': on('effectiveDate'),
  'versions[].lastWorkDate': on('lastWorkDate'),
  // 状态事件
  events: CONTAINER,
  'events[]': CONTAINER,
  'events[].eventNo': independent('第几次状态流转的序号，不含状态值，不派生自受控字段'),
  'events[].state': on('status'),
  'events[].createdAt': on('createdAt'),
  // 日期块（原定 / 最终）
  dates: CONTAINER,
  'dates.planned': CONTAINER,
  'dates.final': CONTAINER,
  'dates.planned.lastWorkDate': on('lastWorkDate'),
  'dates.final.lastWorkDate': on('lastWorkDate'),
  'dates.planned.effectiveDate': on('effectiveDate'),
  'dates.final.effectiveDate': on('effectiveDate'),
  // 审批实例 / 效果台账 / 职责转交：来自其他对象，只给标识或汇总件数（不带目标 ID）
  approvalInstanceId: independent('审批中心实例标识，不是任职字段，不派生自受控字段'),
  effects: CONTAINER,
  'effects[]': CONTAINER,
  'effects[].phase': independent('效果台账汇总（阶段）：来自 exit_effects，不派生自受控字段；目标对象可见性归各自模块'),
  'effects[].kind': independent('效果台账汇总（种类）：同上'),
  'effects[].count': independent('效果台账汇总（件数）：同上'),
  dutyTransfer: CONTAINER,
  'dutyTransfer.timing': on('dutyTransferTiming'),
  'dutyTransfer.transferred': independent('职责转交成功件数：来自 exit_effects 汇总，不派生自受控字段'),
  'dutyTransfer.failed': independent('职责转交失败件数：同上'),
};

/** 姓名 / 工号属人员对象，其余按任职记录对象的字段权限；无权限的键缺席（不是 null）。 */
export interface ExitViewable {
  readonly employee: (field: string) => boolean;
  readonly employment: (field: string) => boolean;
}

const DROPPED = Symbol('dropped');

const allows = (rule: Dependency, show: ExitViewable) =>
  rule.field === null || (rule.object === 'employee' ? show.employee : show.employment)(rule.field);

/**
 * 按路径规则递归裁剪，默认拒绝（#409 第 6 轮）：
 * 1. 每个路径（标量、null、空数组、空对象、数组、数组元素、容器）都必须在表里登记，没登记的不输出；
 * 2. 登记了字段依赖的路径（含容器）先判权，无权整个键缺席，不进入递归；
 * 3. 裁剪前有成员、裁剪后一个不剩的容器整体缺席——不留 {} / []；裁剪前本来就是空的容器（有权时的 []）原样保留。
 */
function trimNode(value: unknown, path: string, show: ExitViewable): unknown {
  if (path !== '') {
    const rule = EXIT_RESPONSE_DEPENDENCIES[path];
    if (!rule || !allows(rule, show)) return DROPPED;
  }
  if (Array.isArray(value)) {
    const kept = value.map((item) => trimNode(item, `${path}[]`, show)).filter((item) => item !== DROPPED);
    return value.length > 0 && kept.length === 0 ? DROPPED : kept;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const kept = entries
      .map(([key, item]) => [key, trimNode(item, path ? `${path}.${key}` : key, show)] as const)
      .filter(([, item]) => item !== DROPPED);
    return entries.length > 0 && kept.length === 0 ? DROPPED : Object.fromEntries(kept);
  }
  return value;
}

export function trimExit<T extends ExitItem>(item: T, show: ExitViewable): Partial<T> {
  return trimNode(item, '', show) as Partial<T>;
}

/** 详情裁剪前的完整输出：补上原定 / 最终日期块（测试的“裁剪前路径”守卫读它）。 */
export type ExitDetailPayload = ReturnType<typeof exitDetailPayload>;
export function exitDetailPayload(detail: ExitDetail) {
  const planned = new Date(`${detail.plannedLastWorkDate}T00:00:00Z`);
  planned.setUTCDate(planned.getUTCDate() + 1);
  return {
    ...detail,
    dates: {
      planned: { lastWorkDate: detail.plannedLastWorkDate, effectiveDate: planned.toISOString().slice(0, 10) },
      final: { lastWorkDate: detail.lastWorkDate, effectiveDate: detail.effectiveDate },
    },
  };
}

/** 详情：与列表走同一张表裁剪。 */
export function trimExitDetail(detail: ExitDetail, show: ExitViewable) {
  return trimNode(exitDetailPayload(detail), '', show) as Record<string, unknown>;
}

/** 筛选 → 依赖的字段（Record 覆盖 ExitViewFilter 的每个键：新增筛选必须登记）。 */
type FilterDependency = { readonly employee?: readonly string[]; readonly employment?: readonly string[] };
export const EXIT_FILTER_DEPENDENCIES: Readonly<Record<keyof ExitViewFilter, FilterDependency>> = {
  departmentIds: { employment: ['departmentId'] },
  keyword: { employee: ['name', 'code'] },
  lastWorkDateFrom: { employment: ['lastWorkDate'] },
  lastWorkDateTo: { employment: ['lastWorkDate'] },
  exitTypeCode: { employment: ['exitTypeCode'] },
  reasonCode: { employment: ['reasonCode'] },
  whereaboutsCode: { employment: ['whereaboutsCode'] },
  // 审批状态也是字段：无权看状态的人不能按它筛选，否则能反推隐藏的状态
  status: { employment: ['status'] },
  initiation: { employment: ['mode', 'initiator'] },
};

/** 用到的筛选所依赖的字段，用来在筛选前确认查看人能看到它们（不让筛选成为探针）。 */
export function filterFieldsOf(filter: ExitViewFilter): { employee: string[]; employment: string[] } {
  const used = (Object.keys(EXIT_FILTER_DEPENDENCIES) as (keyof ExitViewFilter)[]).filter(
    (key) => filter[key] !== undefined,
  );
  return {
    employee: used.flatMap((key) => EXIT_FILTER_DEPENDENCIES[key].employee ?? []),
    employment: used.flatMap((key) => EXIT_FILTER_DEPENDENCIES[key].employment ?? []),
  };
}

/** 各视图默认排序的键依赖的字段（任一可见即可用设计排序）及设计排序；撤销视图按撤销记录的创建时间（createdAt）。 */
export const EXIT_SORT_DEPENDENCIES: Readonly<Record<ExitView, { readonly anyOf: readonly string[]; order: SQL }>> = {
  in_progress: { anyOf: ['lastWorkDate', 'effectiveDate'], order: sql`p.last_work_date ASC, b.id` },
  completed: { anyOf: ['lastWorkDate', 'effectiveDate'], order: sql`p.last_work_date DESC, b.id` },
  all: { anyOf: ['createdAt'], order: sql`b.created_at DESC, b.id DESC` },
  cancellations: { anyOf: ['createdAt'], order: sql`c.created_at DESC, c.id DESC` },
};
