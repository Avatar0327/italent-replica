/**
 * 兼职六视图与详情的期限链 / 申请历史（docs/08_设计/R2-T05_兼职设计.md §6.1 / §6.2 / §6.3，PT-5）。
 * 视图归属只写一处（viewPredicate：view → 谓词）：记录视图委托 span-sql.ts 的 SQL 镜像（与 domain 纯函数逐点等价），in_approval 读兼职
 * 申请最新状态 = in_review；today 取租户今天（DEC-056）。范围按 DEC-177 两项并集在分页前过滤（范围为空 → 空集）；总数与本页取自
 * 同一条语句、同一份物化候选集，并发写入时 items 与 total 不会互相越界。主职部门读取时取员工当前主职，只在操作人看得到该主职记录
 * 时给出（与申请详情的主职分组同口径，PB-46）。
 */
import { sql, type Tx } from '@italent/db';
import {
  PART_TIME_KIND,
  partTimeServiceStatus,
  type PartTimeRequestState,
  type PartTimeRequestType,
  type PartTimeServiceStatus,
  type PartTimeView,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { employmentCreator } from '../context.js';
import { personnelHooks } from '../personnel-hooks.js';
import { checkPage, rowsOf } from '../read-model.js';
import type { CustomFields, EmploymentContext, PageQuery, PresetFields } from '../types.js';
import { employmentVisibilitySql } from '../visibility.js';
import {
  dto,
  PART_TIME_DEPARTMENT,
  PART_TIME_DIRECT_MANAGER,
  PART_TIME_END,
  PART_TIME_START,
  partTimeColumns,
  partTimeFrom,
  partTimeToday,
  partTimeVisible,
  type PartTimeRecordDto,
} from './read.js';
import { partTimeCurrentEndSql, partTimeViewSql } from './span-sql.js';
import { currentDepartment, latestSnapshot, uuidArray } from './store.js';

export interface PartTimeViewFilter {
  /** 姓名或工号包含，不区分大小写。 */
  readonly keyword?: string;
  /** 已展开的兼职部门集合（含下级时由调用方展开）。 */
  readonly departmentIds?: readonly string[];
  readonly serviceType?: string;
  readonly startFrom?: string;
  readonly startTo?: string;
  readonly endFrom?: string;
  readonly endTo?: string;
  readonly directManagerId?: string;
}

export interface PartTimeViewInput {
  readonly view: PartTimeView;
  /** 即将到期的天数（1～365，默认 30）。 */
  readonly days: number;
  readonly page: PageQuery;
  readonly filter: PartTimeViewFilter;
}

interface Shared {
  readonly employee: { readonly code: string; readonly name: string };
  /** 员工当前主职部门；操作人看不到该主职记录时缺席。 */
  readonly primaryDepartmentId?: string;
}

/** 记录视图的行：兼职记录读形状（与员工页签、详情同源）。 */
export type PartTimeRecordItem = PartTimeRecordDto & Shared;

/** in_approval 的行：申请读形状（沿用申请详情的键）+ 申请类型 / 审批状态 / 发起人 / 发起时间（createdAt）。 */
export interface PartTimeApprovalItem extends Shared {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly kind: PartTimeRequestType;
  readonly status: PartTimeRequestState;
  readonly initiator: string;
  readonly initiatorUserId: string;
  readonly processCode: string | null;
  readonly createdAt: string;
  readonly versionNo: number;
  readonly serviceType: string;
  readonly effectiveDate: string;
  /** 新增：结束日期；延长：新结束日期；结束：结束日期。 */
  readonly endDate: string | null;
  readonly originalEndDate: string | null;
  readonly requestRemark: string | null;
  readonly recordId: string | null;
  readonly fields: Partial<PresetFields>;
  readonly customFields: CustomFields;
  /** 新增：按申请的区间；延长 / 结束：目标兼职现在的区间。 */
  readonly serviceStatus: PartTimeServiceStatus;
}

export type PartTimeViewItem = PartTimeRecordItem | PartTimeApprovalItem;

const iso = (value: string | Date) => new Date(value).toISOString();

// ---- 视图归属（唯一入口）------------------------------------------------------------------------------------------

/** view → 谓词。记录视图的归属条件是 span-sql.ts 的 partTimeViewSql（domain inPartTimeView 的镜像）；审批中按申请最新状态。 */
function viewPredicate(input: PartTimeViewInput, today: string): SQL {
  if (input.view === 'in_approval') return sql`s.state='in_review'`;
  return partTimeViewSql(input.view, PART_TIME_START, PART_TIME_END, today, input.days);
}

// ---- 筛选 -----------------------------------------------------------------------------------------------------------

interface FilterColumns {
  readonly department: SQL;
  readonly serviceType: SQL;
  readonly start: SQL;
  readonly end: SQL;
  readonly directManager: SQL;
}

function filterPredicates(tenantId: string, filter: PartTimeViewFilter, columns: FilterColumns): SQL[] {
  const parts: SQL[] = [];
  if (filter.keyword) {
    const name = personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`);
    // strpos 而不是 LIKE：关键字里的 % / _ 不当通配符
    parts.push(sql`(strpos(lower(e.code), lower(${filter.keyword}))>0
      OR strpos(lower(${name}), lower(${filter.keyword}))>0)`);
  }
  if (filter.departmentIds) parts.push(sql`${columns.department} = ANY(${uuidArray(filter.departmentIds)})`);
  if (filter.serviceType) parts.push(sql`${columns.serviceType}=${filter.serviceType}`);
  if (filter.startFrom) parts.push(sql`${columns.start} >= ${filter.startFrom}::date`);
  if (filter.startTo) parts.push(sql`${columns.start} <= ${filter.startTo}::date`);
  if (filter.endFrom) parts.push(sql`${columns.end} >= ${filter.endFrom}::date`);
  if (filter.endTo) parts.push(sql`${columns.end} <= ${filter.endTo}::date`);
  if (filter.directManagerId) parts.push(sql`${columns.directManager}=${filter.directManagerId}::uuid`);
  return parts;
}

const allOf = (parts: SQL[]) => sql.join([sql`true`, ...parts], sql` AND `);

// ---- 员工与主职部门 -------------------------------------------------------------------------------------------------

/** 员工当前主职：开始日不晚于今天的最后一条时间轴记录（离职员工取最后一条，DEC-192），部门取最新快照。 */
function primaryJoin(tenantId: string, employee: SQL, today: string): SQL {
  return sql`LEFT JOIN LATERAL (
    SELECT pr.id AS record_id, COALESCE(snap.department_id, pr.department_id) AS department_id
    FROM employment_timeline pt
    JOIN employment_records pr ON pr.tenant_id=pt.tenant_id AND pr.id=pt.record_id
    LEFT JOIN LATERAL (SELECT v.department_id FROM employment_payload_versions v
      WHERE v.tenant_id=pr.tenant_id AND v.business_id=pr.id AND v.is_record_snapshot
      ORDER BY v.version_no DESC LIMIT 1) snap ON true
    WHERE pt.tenant_id=${tenantId} AND pt.employee_id=${employee} AND pt.start_date<=${today}::date
    ORDER BY pt.start_date DESC, pt.sort_order DESC LIMIT 1
  ) prim ON true`;
}

function employeeColumns(ctx: EmploymentContext, employee: SQL): SQL {
  const primaryVisible = employmentVisibilitySql(ctx.scope, {
    employee,
    department: sql`prim.department_id`,
    creator: employmentCreator(ctx.tenantId, sql`prim.record_id`, true),
  });
  return sql`e.code AS emp_code, ${personnelHooks.currentName(ctx.tenantId, sql`e.id`, sql`e.name`)} AS emp_name,
    prim.department_id AS primary_department_id, (${primaryVisible}) AS primary_visible`;
}

function shared(row: Record<string, unknown>): Shared {
  return {
    employee: { code: String(row.emp_code), name: String(row.emp_name) },
    ...(row.primary_visible && row.primary_department_id
      ? { primaryDepartmentId: String(row.primary_department_id) }
      : {}),
  };
}

// ---- 候选集 ---------------------------------------------------------------------------------------------------------

function recordCandidates(ctx: EmploymentContext, input: PartTimeViewInput, today: string): SQL {
  const where = filterPredicates(ctx.tenantId, input.filter, {
    department: PART_TIME_DEPARTMENT,
    serviceType: sql`r.service_type`,
    start: PART_TIME_START,
    end: PART_TIME_END,
    directManager: PART_TIME_DIRECT_MANAGER,
  });
  return sql`
    SELECT ${partTimeColumns()}, ${employeeColumns(ctx, sql`r.employee_id`)},
      row_number() OVER (ORDER BY r.start_date DESC, r.id) AS ord
    ${partTimeFrom(ctx)}
    JOIN employment_employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
    ${primaryJoin(ctx.tenantId, sql`r.employee_id`, today)}
    WHERE r.tenant_id=${ctx.tenantId} AND r.service_type <> 'primary' AND r.kind=${PART_TIME_KIND}
      AND ${viewPredicate(input, today)} AND ${allOf(where)} AND ${partTimeVisible(ctx)}`;
}

/** 申请的部门：新增取最新版本；延长 / 结束取目标兼职记录当前部门（§7.3A，同 request-store 读取口径）。 */
const REQUEST_DEPARTMENT = sql`(CASE WHEN q.record_id IS NULL THEN v.department_id ELSE ${currentDepartment} END)`;

const REQUEST_JOINS = sql`
  JOIN LATERAL (SELECT state FROM part_time_request_events
    WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY event_no DESC LIMIT 1) s ON true
  JOIN LATERAL (SELECT * FROM part_time_request_versions
    WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY version_no DESC LIMIT 1) v ON true
  LEFT JOIN employment_records r ON r.tenant_id=q.tenant_id AND r.id=q.record_id
  ${latestSnapshot}`;

function approvalCandidates(ctx: EmploymentContext, input: PartTimeViewInput, today: string): SQL {
  const where = filterPredicates(ctx.tenantId, input.filter, {
    department: REQUEST_DEPARTMENT,
    serviceType: sql`v.service_type`,
    start: sql`v.start_date`,
    end: sql`v.end_date`,
    directManager: sql`v.direct_manager_id`,
  });
  const visible = employmentVisibilitySql(ctx.scope, {
    employee: sql`q.employee_id`,
    department: REQUEST_DEPARTMENT,
    creator: sql`q.initiator_user_id`,
  });
  return sql`
    SELECT q.id, q.employee_id, q.request_type, q.record_id, q.initiator, q.initiator_user_id, q.process_code,
      q.revision, q.created_at, s.state, v.version_no, v.service_type, ${REQUEST_DEPARTMENT} AS department_id,
      v.position_id, v.post_id, v.sequence_id, v.level_id, v.direct_manager_id, v.dotted_manager_id,
      v.employment_type, v.employment_form, v.start_date::text AS start_date, v.end_date::text AS end_date,
      v.original_end_date::text AS original_end_date, v.remark, v.custom_fields,
      (CASE WHEN q.record_id IS NULL THEN v.start_date ELSE r.start_date END)::text AS span_start,
      (CASE WHEN q.record_id IS NULL THEN v.end_date
        ELSE ${partTimeCurrentEndSql(ctx.tenantId, sql`q.record_id`)} END)::text AS span_end,
      ${employeeColumns(ctx, sql`q.employee_id`)},
      row_number() OVER (ORDER BY v.start_date DESC, q.created_at DESC, q.id) AS ord
    FROM part_time_requests q
    ${REQUEST_JOINS}
    JOIN employment_employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
    ${primaryJoin(ctx.tenantId, sql`q.employee_id`, today)}
    WHERE q.tenant_id=${ctx.tenantId} AND ${viewPredicate(input, today)} AND ${allOf(where)} AND ${visible}`;
}

function approvalItem(row: Record<string, unknown>, today: string): PartTimeApprovalItem {
  const span = { startDate: String(row.span_start), endDate: (row.span_end as string | null) ?? null };
  return {
    id: String(row.id),
    employeeId: String(row.employee_id),
    revision: Number(row.revision),
    kind: row.request_type as PartTimeRequestType,
    status: row.state as PartTimeRequestState,
    initiator: String(row.initiator),
    initiatorUserId: String(row.initiator_user_id),
    processCode: (row.process_code as string | null) ?? null,
    createdAt: iso(row.created_at as string | Date),
    versionNo: Number(row.version_no),
    serviceType: String(row.service_type),
    effectiveDate: String(row.start_date),
    endDate: (row.end_date as string | null) ?? null,
    originalEndDate: (row.original_end_date as string | null) ?? null,
    requestRemark: (row.remark as string | null) ?? null,
    recordId: (row.record_id as string | null) ?? null,
    fields: {
      departmentId: row.department_id,
      positionId: row.position_id,
      postId: row.post_id,
      levelId: row.level_id,
      sequenceId: row.sequence_id,
      directManagerId: row.direct_manager_id,
      dottedManagerId: row.dotted_manager_id,
      employmentType: row.employment_type,
      employmentForm: row.employment_form,
    } as Partial<PresetFields>,
    customFields: row.custom_fields as CustomFields,
    serviceStatus: partTimeServiceStatus(span, today),
    ...shared(row),
  };
}

/**
 * 一个视图的一页。候选集物化一次，总数与本页同一份结果；越界页返回空 items 与同一 total。
 * 范围外的行在候选集里就被过滤，既不占页位也不计入 total；范围为空 → 空集。
 */
export async function listPartTimeView(
  tx: Tx,
  ctx: EmploymentContext,
  input: PartTimeViewInput,
): Promise<{ items: PartTimeViewItem[]; total: number }> {
  checkPage(input.page);
  const today = partTimeToday(ctx);
  const base =
    input.view === 'in_approval' ? approvalCandidates(ctx, input, today) : recordCandidates(ctx, input, today);
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      WITH base AS MATERIALIZED (${base}), counted AS (SELECT count(*)::int AS total FROM base)
      SELECT counted.total, page.* FROM counted
      LEFT JOIN LATERAL (SELECT * FROM base ORDER BY ord LIMIT ${input.page.limit} OFFSET ${input.page.offset}) page
        ON true
      ORDER BY page.ord`),
  );
  const present = rows.filter((row) => row.id);
  const items = present.map((row) =>
    input.view === 'in_approval' ? approvalItem(row, today) : { ...dto(row, today), ...shared(row) },
  );
  return { total: Number(rows[0]?.total ?? 0), items };
}

// ---- 详情：期限链与申请历史 -----------------------------------------------------------------------------------------

export interface PartTimeTermEntry {
  readonly termNo: number;
  readonly endDate: string | null;
  readonly source: string;
  readonly createdAt: string;
  /** 来源是申请（create / extend / end）且该申请对操作人可见时才有。 */
  readonly requestId?: string;
  /** 变更前 = 上一期（不建列，硬规则 3）；第 1 期为 null。 */
  readonly previous: { readonly termNo: number; readonly endDate: string | null } | null;
}

export interface PartTimeRequestEntry {
  readonly id: string;
  readonly kind: PartTimeRequestType;
  readonly status: PartTimeRequestState;
  readonly initiator: string;
  readonly createdAt: string;
  readonly serviceType: string;
  /** 申请的结束日期（延长：新结束日期）与创建申请时的原定结束日期。 */
  readonly endDate: string | null;
  readonly originalEndDate: string | null;
}

export interface PartTimeHistory {
  readonly terms: readonly PartTimeTermEntry[];
  readonly requests: readonly PartTimeRequestEntry[];
}

/** 来源为申请的期限（source_id 是申请 ID）；批次 / 调动 / 离职来源的 ID 不是申请。 */
const REQUEST_TERM_SOURCES: readonly string[] = ['create', 'extend', 'end'];

/**
 * 申请历史 = 以该记录为目标的延长 / 结束申请 ∪ 产生该记录的新增申请（第 1 期 source = create 的 source_id）；逐条按 §6.2 同一谓词
 * 对操作人可见才返回。调用方须已确认记录本身可见。
 */
async function loadRequestEntries(tx: Tx, ctx: EmploymentContext, recordId: string): Promise<PartTimeRequestEntry[]> {
  const visible = employmentVisibilitySql(ctx.scope, {
    employee: sql`q.employee_id`,
    department: REQUEST_DEPARTMENT,
    creator: sql`q.initiator_user_id`,
  });
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      SELECT q.id, q.request_type, q.initiator, q.created_at, s.state, v.service_type,
        v.end_date::text AS end_date, v.original_end_date::text AS original_end_date
      FROM part_time_requests q
      ${REQUEST_JOINS}
      WHERE q.tenant_id=${ctx.tenantId}
        AND (q.record_id=${recordId}::uuid OR q.id=(SELECT t.source_id FROM employment_part_time_terms t
          WHERE t.tenant_id=${ctx.tenantId} AND t.record_id=${recordId}::uuid AND t.term_no=1 AND t.source='create'))
        AND ${visible}
      ORDER BY q.created_at, q.id`),
  );
  return rows.map((row) => ({
    id: String(row.id),
    kind: row.request_type as PartTimeRequestType,
    status: row.state as PartTimeRequestState,
    initiator: String(row.initiator),
    createdAt: iso(row.created_at as string | Date),
    serviceType: String(row.service_type),
    endDate: (row.end_date as string | null) ?? null,
    originalEndDate: (row.original_end_date as string | null) ?? null,
  }));
}

export async function loadPartTimeHistory(tx: Tx, ctx: EmploymentContext, recordId: string): Promise<PartTimeHistory> {
  const requests = await loadRequestEntries(tx, ctx, recordId);
  const linkable = new Set(requests.map((request) => request.id));
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      SELECT t.term_no, t.end_date::text AS end_date, t.source, t.source_id::text AS source_id, t.created_at,
        lag(t.term_no) OVER w AS previous_no, lag(t.end_date::text) OVER w AS previous_end
      FROM employment_part_time_terms t
      WHERE t.tenant_id=${ctx.tenantId} AND t.record_id=${recordId}::uuid
      WINDOW w AS (ORDER BY t.term_no)
      ORDER BY t.term_no`),
  );
  const terms = rows.map((row): PartTimeTermEntry => {
    const sourceId = row.source_id as string | null;
    const linked = sourceId !== null && REQUEST_TERM_SOURCES.includes(String(row.source)) && linkable.has(sourceId);
    return {
      termNo: Number(row.term_no),
      endDate: (row.end_date as string | null) ?? null,
      source: String(row.source),
      createdAt: iso(row.created_at as string | Date),
      ...(linked ? { requestId: sourceId } : {}),
      previous:
        row.previous_no === null
          ? null
          : { termNo: Number(row.previous_no), endDate: (row.previous_end as string | null) ?? null },
    };
  });
  return { terms, requests };
}
