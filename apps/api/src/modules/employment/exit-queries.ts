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

/** 默认排序（§3.2）；末位 b.id 保证翻页稳定。 */
function viewOrder(view: ExitView): SQL {
  switch (view) {
    case 'in_progress':
      return sql`p.last_work_date ASC, b.id`;
    case 'completed':
      return sql`p.last_work_date DESC, b.id`;
    case 'all':
      return sql`b.created_at DESC, b.id DESC`;
    case 'cancellations':
      return sql`c.created_at DESC, c.id DESC`;
  }
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
  input: { readonly view: ExitView; readonly page: PageQuery; readonly filter: ExitViewFilter },
  scope: EmploymentScope | undefined,
): Promise<{ items: ExitItem[]; total: number }> {
  checkPage(input.page);
  const where = [viewPredicate(input.view), ...filterPredicates(tenantId, input.filter)];
  const rows = rowsOf<ExitRow & { total: number }>(
    await tx.execute(sql`
    WITH base AS MATERIALIZED (${candidates(tenantId, scope, where, viewOrder(input.view))}),
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
  readonly attachmentRefs: unknown;
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
    attachmentRefs: ext.attachmentRefs ?? null,
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

// ---- 字段裁剪（§9.1）-------------------------------------------------------------------------------------------

/** 响应键 → 任职记录对象的字段编码；不在表里的键（ID、状态、revision、效果汇总等）是行可见即可见的控制项。 */
const RECORD_FIELD: Readonly<Record<string, string>> = {
  departmentId: 'departmentId',
  positionId: 'positionId',
  lastWorkDate: 'lastWorkDate',
  plannedLastWorkDate: 'lastWorkDate',
  effectiveDate: 'effectiveDate',
  exitTypeCode: 'exitTypeCode',
  exitTypeName: 'exitTypeCode',
  reasonCode: 'reasonCode',
  reasonName: 'reasonCode',
  whereaboutsCode: 'whereaboutsCode',
  whereaboutsName: 'whereaboutsCode',
  mode: 'mode',
  initiator: 'initiator',
  initiatorUserId: 'initiator',
  handoverEmployeeId: 'handoverEmployeeId',
  addToBlacklist: 'addToBlacklist',
  compensationAmount: 'compensationAmount',
  nonCompeteAmount: 'nonCompeteAmount',
  lastPayDate: 'lastPayDate',
  socialInsuranceEndMonth: 'socialInsuranceEndMonth',
  annualLeaveSettled: 'annualLeaveSettled',
  taxPeriod: 'taxPeriod',
  taxYear: 'taxYear',
  employerName: 'employerName',
  actualLeaveDate: 'actualLeaveDate',
  attachmentRefs: 'attachmentRefs',
};

/** 姓名 / 工号属人员对象，其余按任职记录对象的字段权限；无权限的键缺席（不是 null）。 */
export interface ExitViewable {
  readonly employee: (field: string) => boolean;
  readonly employment: (field: string) => boolean;
}

/** 筛选参数用到的字段（关键字 = 姓名 + 工号），用来在筛选前确认查看人能看到它们（不让筛选成为探针）。 */
export function filterFieldsOf(filter: ExitViewFilter): { employee: string[]; employment: string[] } {
  const employment: string[] = [];
  if (filter.departmentIds) employment.push('departmentId');
  if (filter.lastWorkDateFrom || filter.lastWorkDateTo) employment.push('lastWorkDate');
  if (filter.exitTypeCode) employment.push('exitTypeCode');
  if (filter.reasonCode) employment.push('reasonCode');
  if (filter.whereaboutsCode) employment.push('whereaboutsCode');
  if (filter.initiation) employment.push('mode', 'initiator');
  return { employee: filter.keyword ? ['name', 'code'] : [], employment };
}

export function trimExit<T extends ExitItem>(item: T, show: ExitViewable): Partial<T> {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => {
      if (key === 'name' || key === 'code') return show.employee(key);
      const field = RECORD_FIELD[key];
      return field === undefined || show.employment(field);
    }),
  ) as Partial<T>;
}

/** 详情：在 trimExit 之上加日期块与版本列表（日期各按 lastWorkDate / effectiveDate 的字段权限逐项裁剪）。 */
export function trimExitDetail(detail: ExitDetail, show: ExitViewable) {
  const { versions, ...rest } = detail;
  const lastWork = show.employment('lastWorkDate');
  const effective = show.employment('effectiveDate');
  const dates = (lastWorkDate: string | null, effectiveDate: string) => ({
    ...(lastWork && lastWorkDate !== null ? { lastWorkDate } : {}),
    ...(effective ? { effectiveDate } : {}),
  });
  const planned = new Date(`${detail.plannedLastWorkDate}T00:00:00Z`);
  planned.setUTCDate(planned.getUTCDate() + 1);
  return {
    ...trimExit(rest, show),
    dates: {
      planned: dates(detail.plannedLastWorkDate, planned.toISOString().slice(0, 10)),
      final: dates(detail.lastWorkDate, detail.effectiveDate),
    },
    versions: versions.map((version) => ({
      versionNo: version.versionNo,
      createdAt: version.createdAt,
      ...(effective
        ? { effectiveDate: version.effectiveDate, plannedEffectiveDate: version.plannedEffectiveDate }
        : {}),
      ...(lastWork ? { lastWorkDate: version.lastWorkDate } : {}),
    })),
  };
}
