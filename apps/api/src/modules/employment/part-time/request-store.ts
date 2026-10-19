/**
 * 兼职申请的持久化（docs/08_设计/R2-T05_兼职设计.md §1.4 / §2.2）：申请头 + 载荷版本 + 状态事件三张表。
 * 头只改 revision，载荷版本与状态事件只追加；“原定结束日期”“提交时目标期号”在版本里，不被实际失效日覆盖。
 * 只做写入与查询，不做业务校验、不写审计（校验见 validation / boundary，状态迁移与审计见 request-service）。
 * 锁序（§7.1）：员工行（调用方已持有）→ 兼职记录头（按 ID 升序）→ 申请头（按 ID 升序）→ 审批实例。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  PART_TIME_REQUEST_OPEN_STATES,
  PART_TIME_REQUEST_PENDING_STATES,
  type PartTimeInitiator,
  type PartTimeRequestState,
  type PartTimeRequestType,
  type PartTimeServiceType,
  type PartTimeVoidReason,
} from '@italent/domain';
import { rowsOf } from '../record-store.js';
import type { EmploymentContext } from '../types.js';
import { currentDepartment, latestSnapshot, uuidArray } from './store.js';

/** 申请载荷（版本）：预置字段与兼职记录同一组（§1.1），日期与备注是申请自己的。 */
export interface PartTimeRequestVersion {
  readonly id: string;
  readonly versionNo: number;
  readonly serviceType: PartTimeServiceType;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly postId: string | null;
  readonly sequenceId: string | null;
  readonly levelId: string | null;
  readonly directManagerId: string | null;
  readonly dottedManagerId: string | null;
  readonly employmentType: string | null;
  readonly employmentForm: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
  /** extend / end：创建时目标记录的当前结束日；add 为 null（PT-4c 使用）。 */
  readonly originalEndDate: string | null;
  readonly baseTermNo: number | null;
  readonly remark: string | null;
  readonly customFields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PartTimeRequestRow {
  readonly id: string;
  readonly employeeId: string;
  readonly requestType: PartTimeRequestType;
  readonly recordId: string | null;
  readonly initiator: PartTimeInitiator;
  readonly initiatorUserId: string;
  readonly processCode: string | null;
  /** 申请头 revision（If-Match）。 */
  readonly revision: number;
  readonly state: PartTimeRequestState;
  readonly eventNo: number;
  readonly version: PartTimeRequestVersion;
}

// 部门：新增申请取最新版本；延长 / 结束申请取目标兼职记录的当前部门（§7.2 / §7.3A：读取时取当前值，范围 / 审计 / 重放都据此判）
const VERSION_COLUMNS = sql`v.id AS "versionId", v.version_no AS "versionNo", v.service_type AS "serviceType",
  CASE WHEN q.record_id IS NULL THEN v.department_id ELSE ${currentDepartment} END AS "departmentId",
  v.position_id AS "positionId", v.post_id AS "postId",
  v.sequence_id AS "sequenceId", v.level_id AS "levelId", v.direct_manager_id AS "directManagerId",
  v.dotted_manager_id AS "dottedManagerId", v.employment_type AS "employmentType",
  v.employment_form AS "employmentForm", v.start_date::text AS "startDate", v.end_date::text AS "endDate",
  v.original_end_date::text AS "originalEndDate", v.base_term_no AS "baseTermNo", v.remark,
  v.custom_fields AS "customFields"`;

type RawRequest = Omit<PartTimeRequestRow, 'version'> & { versionId: string } & PartTimeRequestVersion;

function toRow(raw: RawRequest): PartTimeRequestRow {
  const { versionId, ...rest } = raw;
  const version: PartTimeRequestVersion = {
    id: versionId,
    versionNo: Number(rest.versionNo),
    serviceType: rest.serviceType,
    departmentId: rest.departmentId,
    positionId: rest.positionId,
    postId: rest.postId,
    sequenceId: rest.sequenceId,
    levelId: rest.levelId,
    directManagerId: rest.directManagerId,
    dottedManagerId: rest.dottedManagerId,
    employmentType: rest.employmentType,
    employmentForm: rest.employmentForm,
    startDate: rest.startDate,
    endDate: rest.endDate,
    originalEndDate: rest.originalEndDate,
    baseTermNo: rest.baseTermNo === null ? null : Number(rest.baseTermNo),
    remark: rest.remark,
    customFields: rest.customFields,
  };
  return {
    id: rest.id,
    employeeId: rest.employeeId,
    requestType: rest.requestType,
    recordId: rest.recordId,
    initiator: rest.initiator,
    initiatorUserId: rest.initiatorUserId,
    processCode: rest.processCode,
    revision: Number(rest.revision),
    state: rest.state,
    eventNo: Number(rest.eventNo),
    version,
  };
}

/** 申请的当前状态：头 + 最新版本 + 最新事件；lock 时对申请头 FOR UPDATE（调用方已持有员工行锁）。 */
export async function loadPartTimeRequest(
  tx: Tx,
  tenantId: string,
  id: string,
  lock = false,
): Promise<PartTimeRequestRow | null> {
  const [raw] = rowsOf<RawRequest>(
    await tx.execute(sql`
      SELECT q.id, q.employee_id AS "employeeId", q.request_type AS "requestType", q.record_id AS "recordId",
        q.initiator, q.initiator_user_id AS "initiatorUserId", q.process_code AS "processCode", q.revision,
        s.state, s.event_no AS "eventNo", ${VERSION_COLUMNS}
      FROM part_time_requests q
      JOIN LATERAL (SELECT state, event_no FROM part_time_request_events
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY event_no DESC LIMIT 1) s ON true
      JOIN LATERAL (SELECT * FROM part_time_request_versions
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY version_no DESC LIMIT 1) v ON true
      LEFT JOIN employment_records r ON r.tenant_id=q.tenant_id AND r.id=q.record_id
      ${latestSnapshot}
      WHERE q.tenant_id=${tenantId} AND q.id=${id}::uuid
      ${lock ? sql`FOR UPDATE OF q` : sql``}
    `),
  );
  return raw ? toRow(raw) : null;
}

/** 申请所属员工（不加锁）：先锁员工行再锁申请头的入口（审批适配器、命令）用它定位。 */
export async function partTimeRequestOwner(tx: Tx, tenantId: string, id: string) {
  const [row] = rowsOf<{ employeeId: string; requestType: PartTimeRequestType; recordId: string | null }>(
    await tx.execute(sql`SELECT employee_id AS "employeeId", request_type AS "requestType", record_id AS "recordId"
      FROM part_time_requests WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
  );
  return row ?? null;
}

export interface NewRequestHead {
  readonly employeeId: string;
  readonly requestType: PartTimeRequestType;
  readonly recordId: string | null;
  readonly initiator: PartTimeInitiator;
  /** 流程编码在创建时绑定（头不可再改，只改 revision）：取审批类型的标准编码。 */
  readonly processCode: string | null;
}

export type RequestPayload = Omit<PartTimeRequestVersion, 'id' | 'versionNo'>;

async function insertVersion(
  tx: Tx,
  ctx: EmploymentContext,
  head: { readonly id: string; readonly employeeId: string },
  versionNo: number,
  previousVersionId: string | null,
  payload: RequestPayload,
): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO part_time_request_versions(id, tenant_id, employee_id, request_id, version_no, previous_version_id,
      command_id, service_type, department_id, position_id, post_id, sequence_id, level_id, direct_manager_id,
      dotted_manager_id, employment_type, employment_form, start_date, end_date, original_end_date, base_term_no,
      remark, custom_fields, created_at)
    VALUES (${id}, ${ctx.tenantId}, ${head.employeeId}, ${head.id}, ${versionNo}, ${previousVersionId},
      ${ctx.commandId}, ${payload.serviceType}, ${payload.departmentId}, ${payload.positionId}, ${payload.postId},
      ${payload.sequenceId}, ${payload.levelId}, ${payload.directManagerId}, ${payload.dottedManagerId},
      ${payload.employmentType}, ${payload.employmentForm}, ${payload.startDate}, ${payload.endDate},
      ${payload.originalEndDate}, ${payload.baseTermNo}, ${payload.remark},
      ${JSON.stringify(payload.customFields)}::jsonb, ${ctx.now.toISOString()}::timestamptz)
  `);
  return id;
}

async function insertEvent(
  tx: Tx,
  ctx: EmploymentContext,
  request: { readonly id: string; readonly employeeId: string },
  eventNo: number,
  versionId: string,
  state: PartTimeRequestState,
  detail: { readonly reason?: PartTimeVoidReason; readonly recordId?: string } = {},
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO part_time_request_events(tenant_id, employee_id, request_id, version_id, state, event_no,
      command_id, reason, record_id, created_at)
    VALUES (${ctx.tenantId}, ${request.employeeId}, ${request.id}, ${versionId}, ${state}, ${eventNo},
      ${ctx.commandId}, ${detail.reason ?? null}, ${detail.recordId ?? null}, ${ctx.now.toISOString()}::timestamptz)
  `);
}

/** 建申请：头（revision 1）+ 第 1 版 + draft 事件；调用方已持有员工行锁。 */
export async function insertPartTimeRequest(
  tx: Tx,
  ctx: EmploymentContext,
  head: NewRequestHead,
  payload: RequestPayload,
): Promise<PartTimeRequestRow> {
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO part_time_requests(id, tenant_id, employee_id, request_type, record_id, initiator, initiator_user_id,
      process_code, created_at)
    VALUES (${id}, ${ctx.tenantId}, ${head.employeeId}, ${head.requestType}, ${head.recordId}, ${head.initiator},
      ${ctx.userId}, ${head.processCode}, ${ctx.now.toISOString()}::timestamptz)
  `);
  const versionId = await insertVersion(tx, ctx, { id, employeeId: head.employeeId }, 1, null, payload);
  await insertEvent(tx, ctx, { id, employeeId: head.employeeId }, 1, versionId, 'draft');
  return (await loadPartTimeRequest(tx, ctx.tenantId, id))!;
}

/** 追加一版载荷（修改 / 审批编辑），申请头 revision +1；状态不变。返回追加后的申请。 */
export async function appendRequestVersion(
  tx: Tx,
  ctx: EmploymentContext,
  request: PartTimeRequestRow,
  payload: RequestPayload,
): Promise<PartTimeRequestRow> {
  await insertVersion(tx, ctx, request, request.version.versionNo + 1, request.version.id, payload);
  await bumpRequestRevision(tx, ctx, request.id);
  return (await loadPartTimeRequest(tx, ctx.tenantId, request.id))!;
}

/** 追加一条状态事件（绑定当前最新版本），申请头 revision +1。状态迁移合法性由调用方按 nextPartTimeRequestState 判。 */
export async function appendRequestState(
  tx: Tx,
  ctx: EmploymentContext,
  request: PartTimeRequestRow,
  state: PartTimeRequestState,
  detail: { readonly reason?: PartTimeVoidReason; readonly recordId?: string } = {},
): Promise<PartTimeRequestRow> {
  await insertEvent(tx, ctx, request, request.eventNo + 1, request.version.id, state, detail);
  await bumpRequestRevision(tx, ctx, request.id);
  return (await loadPartTimeRequest(tx, ctx.tenantId, request.id))!;
}

async function bumpRequestRevision(tx: Tx, ctx: Pick<EmploymentContext, 'tenantId'>, id: string): Promise<void> {
  await tx.execute(
    sql`UPDATE part_time_requests SET revision = revision + 1 WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`,
  );
}

/** 员工名下未办结（草稿 / 审批中 / 驳回）的申请，申请头按 ID 升序 FOR UPDATE（离职钩子 §4.6、调动 §4.7）。 */
export async function lockOpenRequests(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  employeeId: string,
): Promise<PartTimeRequestRow[]> {
  const states = sql.join(
    PART_TIME_REQUEST_OPEN_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  const ids = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT q.id FROM part_time_requests q
      JOIN LATERAL (SELECT state FROM part_time_request_events
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE q.tenant_id=${ctx.tenantId} AND q.employee_id=${employeeId}::uuid AND s.state IN (${states})
      ORDER BY q.id FOR UPDATE OF q
    `),
  );
  const requests: PartTimeRequestRow[] = [];
  for (const { id } of ids) requests.push((await loadPartTimeRequest(tx, ctx.tenantId, id))!);
  return requests;
}

/**
 * 组织停用计数（§6.3 / §6.4，P-14）：这些部门里审批中（in_review / approved）的新增兼职申请条数，按申请计、
 * 部门取最新版本，无日期过滤（同 DEC-196：计划开始日在停用日前也可能继续占用）。
 */
export async function countPendingPartTimeRequests(
  tx: Tx,
  tenantId: string,
  orgIds: readonly string[],
): Promise<Map<string, number>> {
  if (!orgIds.length) return new Map();
  const states = sql.join(
    PART_TIME_REQUEST_PENDING_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  const rows = rowsOf<{ orgId: string; count: number }>(
    await tx.execute(sql`
      SELECT v.department_id AS "orgId", count(*)::int AS count FROM part_time_requests q
      JOIN LATERAL (SELECT state FROM part_time_request_events
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY event_no DESC LIMIT 1) s ON true
      JOIN LATERAL (SELECT department_id FROM part_time_request_versions
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY version_no DESC LIMIT 1) v ON true
      WHERE q.tenant_id=${tenantId} AND q.request_type='add' AND s.state IN (${states})
        AND v.department_id = ANY(${uuidArray(orgIds)})
      GROUP BY v.department_id
    `),
  );
  return new Map(rows.map((row) => [row.orgId, Number(row.count)]));
}
