import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { EmploymentError } from './errors.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

interface TimelinePoint {
  recordId: string;
  staffId: string;
  startDate: string;
  sortOrder: number;
}

/**
 * 操作先后键（DEC-108；PR #53 第二轮 P2-2）：申请取最近一次提交的状态事件序号（原站提交即写入版本链，W-417），
 * 直接业务取保存时的状态事件序号。正在落地的直接业务尚未写状态事件，键为空，视为最新一次操作。
 * 撤回 / 驳回后重新提交的申请按最近一次提交排序（PR #53 第三轮清单第 4 项，暂定口径）。
 * TODO(需取证 Q-M0-62)：原站重新提交后同日顺序取首次还是最近一次提交。
 */
export function operationKey(tenantId: string, businessId: SQL): SQL {
  return sql`(SELECT COALESCE(max(e.event_seq) FILTER (WHERE e.state = 'in_review'), min(e.event_seq))
    FROM employment_state_events e WHERE e.tenant_id = ${tenantId} AND e.business_id = ${businessId})`;
}

/**
 * 计划生效日的唯一来源（DEC-431①；F-140 约束 1 / 2，DEC-499）：最新载荷版本（按业务内单调的 version_no）的人工计划列。
 * 人工写日期的版本计划 = 本版本日期，系统顺延等派生版本沿用上一版本（迁移 0130 触发器维护），因此迟到顺延后仍按原计划日
 * 排序（DEC-195①）；不读 outbox 改期事件，不依赖 created_at / UUID 先后。纯函数镜像见 domain resolvePlannedEffectiveDate。
 * 离职设计 §5.0A（R2-T03）要求的“离职顺延事件计入、取首次顺延前的日期”由这一写法覆盖：离职顺延同样追加派生版本
 * （triggerBusinessId 非空）沿用人工计划，无需另读 `employment.leave.rescheduled`；排序、到期、迟到窗口、时间轴同日位置
 * 全部只调用本函数（§5.0A.1 D-1～D-18）。
 */
export function plannedEffectiveDate(tenantId: string, businessId: SQL, fallback: SQL): SQL {
  return sql`COALESCE((SELECT p.planned_effective_date FROM employment_payload_versions p
      WHERE p.tenant_id=${tenantId} AND p.business_id=${businessId} ORDER BY p.version_no DESC LIMIT 1), ${fallback})`;
}

/** 读一个业务的计划生效日（`plannedEffectiveDate` 的取值入口）：调用方在已锁定业务的事务内用，没有载荷时取 fallback。 */
export async function loadPlannedEffectiveDate(
  tx: Tx,
  tenantId: string,
  businessId: string,
  fallback: string,
): Promise<string> {
  const [row] = rowsOf<{ planned: string }>(
    await tx.execute(
      sql`SELECT ${plannedEffectiveDate(tenantId, sql`${businessId}::uuid`, sql`${fallback}::date`)}::text AS planned`,
    ),
  );
  return row?.planned ?? fallback;
}

/** 新记录在时间轴上的位置；shifted 表示当日已有操作更晚的记录，新记录插在它们之前（它们依次后移一位）。 */
export interface TimelinePosition {
  readonly date: string;
  readonly order: number;
  readonly shifted: boolean;
}

/**
 * 同一员工同一生效日按操作先后排序（DEC-108：当天最终状态取最后一次操作）：新记录排在当日第一条操作更晚的记录之前，
 * 没有则追加在当日最后。直接业务落地时总是最新操作，因此只有“先提交、后落地”的申请会插到当日中间。
 * 跨周期同日（DEC-077 保留部分）由入职类业务要求当日在前一条为离职 / 退休保证（write-service 的 assertBusinessSequence）。
 */
export async function timelinePosition(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  recordId?: string,
  /** 尚未写入的人工计划日（转正改期在写入前按新计划日预算位置，DEC-589）；不给时读最新载荷版本。 */
  plannedDate?: string,
): Promise<TimelinePosition> {
  const mine = recordId ? operationKey(ctx.tenantId, sql`${recordId}::uuid`) : sql`NULL::bigint`;
  const planned =
    plannedDate !== undefined
      ? sql`${plannedDate}::date`
      : recordId
        ? plannedEffectiveDate(ctx.tenantId, sql`${recordId}::uuid`, sql`${date}::date`)
        : sql`${date}::date`;
  const [row] = rowsOf<{ before: number | null; append: number }>(
    await tx.execute(sql`
    SELECT
      (SELECT min(t.sort_order) FROM employment_timeline t
        WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND t.start_date=${date}::date
          AND (${plannedEffectiveDate(ctx.tenantId, sql`t.record_id`, sql`t.start_date`)} > ${planned}
            OR (${plannedEffectiveDate(ctx.tenantId, sql`t.record_id`, sql`t.start_date`)} = ${planned}
              AND ${operationKey(ctx.tenantId, sql`t.record_id`)} > ${mine})))::int AS before,
      (SELECT COALESCE(max(sort_order) + 1, 0) FROM employment_timeline
        WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND start_date=${date}::date)::int AS append
  `),
  );
  const before = row?.before ?? null;
  return before === null
    ? { date, order: Number(row?.append ?? 0), shifted: false }
    : { date, order: Number(before), shifted: true };
}

async function neighbor(tx: Tx, ctx: EmploymentContext, employeeId: string, comparison: SQL, previous: boolean) {
  const direction = previous ? sql`DESC` : sql`ASC`;
  const [point] = rowsOf<TimelinePoint>(
    await tx.execute(sql`
    SELECT record_id AS "recordId", staff_id AS "staffId", start_date::text AS "startDate", sort_order AS "sortOrder"
    FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND ${comparison}
    ORDER BY start_date ${direction}, sort_order ${direction} LIMIT 1
  `),
  );
  return point;
}

async function neighbors(tx: Tx, ctx: EmploymentContext, employeeId: string, date: string, order: number) {
  return {
    previous: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) < (${date}::date, ${order})`, true),
    next: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) > (${date}::date, ${order})`, false),
  };
}

/** 新记录插入位置前后的记录：插到当日中间时，位置上现有的那条（随后后移）就是下一条。 */
async function neighborsAt(tx: Tx, ctx: EmploymentContext, employeeId: string, position: TimelinePosition) {
  const { date, order, shifted } = position;
  const after = shifted ? sql`>=` : sql`>`;
  return {
    previous: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) < (${date}::date, ${order})`, true),
    next: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) ${after} (${date}::date, ${order})`, false),
  };
}

/**
 * 当日操作更晚的记录依次后移一位，给新记录腾出位置。投影只允许改区间（触发器），故删除后按原值重插、只改顺序号；
 * 不重叠与连续覆盖为延迟约束，事务提交时校验。当日顺序唯一约束是即时约束，所以分两条语句：先删完全部要后移的行，
 * 再一次插入（同一语句里 DELETE…RETURNING 接 INSERT 会边删边插，后移两条以上时撞唯一约束，PR #53 P2-R2-1）。
 */
async function shiftSameDay(tx: Tx, ctx: EmploymentContext, employeeId: string, position: TimelinePosition) {
  const moved = rowsOf<{
    recordId: string;
    staffId: string;
    sortOrder: number;
    validDuring: string;
    createdAt: string;
  }>(
    await tx.execute(sql`
    DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid
      AND start_date=${position.date}::date AND sort_order >= ${position.order}
    RETURNING record_id AS "recordId", staff_id AS "staffId", sort_order AS "sortOrder",
      valid_during::text AS "validDuring", created_at::text AS "createdAt"
  `),
  );
  if (!moved.length) return;
  const values = moved.map(
    (row) => sql`(${ctx.tenantId}::uuid, ${employeeId}::uuid, ${row.recordId}::uuid, ${row.staffId}::uuid,
      ${Number(row.sortOrder) + 1}, ${position.date}::date, ${row.validDuring}::daterange,
      ${row.createdAt}::timestamptz)`,
  );
  await tx.execute(sql`
    INSERT INTO employment_timeline
      (tenant_id, employee_id, record_id, staff_id, sort_order, start_date, valid_during, created_at)
    VALUES ${sql.join(values, sql`, `)}
  `);
}

export async function insertEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  staffId: string,
  effectiveDate: string,
): Promise<{ previousRecordId: string | null; isInserted: boolean }> {
  const position = await timelinePosition(tx, ctx, employeeId, effectiveDate, recordId);
  const { previous, next } = await neighborsAt(tx, ctx, employeeId, position);
  // 同日在前的记录区间收缩为空：它仍在版本链上（变更前取它），但当天不再是当前任职。
  if (previous)
    await tx.execute(sql`
    UPDATE employment_timeline SET valid_during=daterange(start_date, ${effectiveDate}::date, '[)')
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${previous.recordId}::uuid
  `);
  if (position.shifted) await shiftSameDay(tx, ctx, employeeId, position);
  await tx.execute(sql`
    INSERT INTO employment_timeline
      (tenant_id,employee_id,record_id,staff_id,sort_order,start_date,valid_during,created_at)
    VALUES (${ctx.tenantId}::uuid,${employeeId}::uuid,${recordId}::uuid,${staffId}::uuid,${position.order},
      ${effectiveDate}::date,daterange(${effectiveDate}::date,${next?.startDate ?? null}::date,'[)'),
      ${ctx.now.toISOString()}::timestamptz)
  `);
  // TODO(需取证 Q-M0-21)：首次入职尚未到期时不造占位任职。
  return { previousRecordId: previous?.recordId ?? null, isInserted: !!next };
}

/** 新记录将插入的位置前后的记录（不给 recordId 时按当日最后）；调用方已持员工锁。 */
export async function employmentTimelineNeighbors(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  recordId?: string,
) {
  return neighborsAt(tx, ctx, employeeId, await timelinePosition(tx, ctx, employeeId, date, recordId));
}

/**
 * 删除任职的时间轴部分（R1-T11，`07` A11）：允许删除非最新的记录，前一条的区间接到后一条的生效日（同日在前的记录
 * 区间仍为空，DEC-108），后续记录与同日顺序号不动、不被重算（W-013）。开新周期的记录（入职 / 再入职）其后还有
 * 同周期记录，或下一条已属另一周期时不能删除，否则周期首条或周期边界会悬空。返回前一条及其恢复出的有效段，
 * 供调用方校验约束（deletion-guards.ts）并同步投影。
 */
export async function removeEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  opensCycle: boolean,
): Promise<{ recordId: string; window: { from: string; to: string | null } } | null> {
  const [point] = rowsOf<TimelinePoint>(
    await tx.execute(sql`
    SELECT record_id AS "recordId", staff_id AS "staffId", start_date::text AS "startDate", sort_order AS "sortOrder"
    FROM employment_timeline
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${recordId}::uuid
  `),
  );
  if (!point) throw new AppError('SERVICE_UNAVAILABLE', '任职记录缺少日期投影');
  const { previous, next } = await neighbors(tx, ctx, employeeId, point.startDate, point.sortOrder);
  if (next && (opensCycle || next.staffId !== point.staffId)) {
    throw new EmploymentError('EMPLOYMENT_FUTURE_VERSION_EXISTS', '存在后续任职记录，不能删除历史记录');
  }
  await tx.execute(sql`DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
    AND employee_id=${employeeId}::uuid AND record_id=${recordId}::uuid`);
  if (!previous) return null;
  const until = next?.startDate ?? null;
  await tx.execute(sql`UPDATE employment_timeline SET valid_during=daterange(start_date,${until}::date,'[)')
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${previous.recordId}::uuid`);
  // 前一条新增的有效段：从被删记录的生效日到后一条的生效日（后一条同日时为空段）。
  return { recordId: previous.recordId, window: { from: point.startDate, to: until } };
}

/** 业务的任职记录当前是否在时间轴上（被离职摘下的未来调动不在，离职设计 §5.8）。 */
export async function isOnTimeline(tx: Tx, tenantId: string, recordId: string): Promise<boolean> {
  const [row] = rowsOf<{ present: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM employment_timeline
      WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid) AS present`),
  );
  return !!row?.present;
}

/**
 * 被离职摘下的任职记录：与覆盖校验触发器共用数据库函数 employment_record_detached（迁移 0143）——同员工、同周期、
 * 真实离职之后的调动，且有 future_transfer_detached 台账（台账只追加，挂回在 B4），当前不在时间轴上。
 */
export async function isDetachedRecord(tx: Tx, tenantId: string, recordId: string): Promise<boolean> {
  const [row] = rowsOf<{ detached: boolean }>(
    await tx.execute(sql`SELECT employment_record_detached(${tenantId}::uuid, ${recordId}::uuid) AS detached`),
  );
  return !!row?.detached;
}

export interface DetachedTransferWindow {
  readonly recordId: string;
  /** 被摘下前的时间轴窗口 [from, to)，to 为空表示开放。 */
  readonly from: string;
  readonly to: string | null;
}

/**
 * 离职设计 §5.8：离职落地后，同周期里排在它之后的已落地调动（未来直接调动，或同日迟到落地、按 C-3 排在离职之后的调动）
 * 的时间轴行摘下（“排在其后”只用数据库函数 employment_follows 判定，与覆盖校验触发器同一口径，同日按 C-3），员工自离职生效日起即为离职；记录、载荷版本、状态事件全部保留。离职区间开放到下一条剩余记录（下一周期
 * 的入职）或无穷。返回被摘下的窗口，供调用方写台账（撤销时按窗口挂回，B4）。调用方已持员工锁。
 */
export async function detachFutureTransfers(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  leaveRecordId: string,
): Promise<DetachedTransferWindow[]> {
  const [leave] = rowsOf<TimelinePoint>(
    await tx.execute(sql`
    SELECT record_id AS "recordId", staff_id AS "staffId", start_date::text AS "startDate", sort_order AS "sortOrder"
    FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND record_id=${leaveRecordId}::uuid`),
  );
  if (!leave) throw new AppError('SERVICE_UNAVAILABLE', '离职记录缺少日期投影');
  const detached = rowsOf<DetachedTransferWindow>(
    await tx.execute(sql`
    SELECT t.record_id AS "recordId", t.start_date::text AS "from", upper(t.valid_during)::text AS "to"
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND t.staff_id=${leave.staffId}::uuid
      AND r.kind='transfer' AND employment_follows(${ctx.tenantId}::uuid, ${leaveRecordId}::uuid, r.id)
    ORDER BY t.start_date,t.sort_order`),
  );
  if (!detached.length) return [];
  const ids = sql.join(
    detached.map((item) => sql`${item.recordId}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND record_id IN (${ids})`);
  const [next] = rowsOf<{ date: string }>(
    await tx.execute(sql`
    SELECT start_date::text AS date FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${employeeId}::uuid AND (start_date,sort_order)>(${leave.startDate}::date,${leave.sortOrder})
    ORDER BY start_date,sort_order LIMIT 1`),
  );
  await tx.execute(sql`UPDATE employment_timeline
    SET valid_during=daterange(start_date,${next?.date ?? null}::date,'[)')
    WHERE tenant_id=${ctx.tenantId} AND record_id=${leaveRecordId}::uuid`);
  return detached.map((item) => ({ ...item, to: item.to ?? null }));
}

export interface ReattachedTransfer {
  readonly recordId: string;
  /** 挂回后的时间轴窗口 [from, to)，to 为空表示开放。 */
  readonly from: string;
  readonly to: string | null;
}

/**
 * 离职设计 §5.8 / §7.1：撤销已生效离职后，把离职落地时摘下的未来调动按台账窗口挂回原位（B4）。
 * 必须在离职自己的时间轴行已移除之后调用；按原窗口起点升序逐条走与落地同一个插入入口（insertEmploymentTimeline，
 * 同日先后按原计划日 / 操作序号），前一条的区间随之接到第一个挂回的调动。台账只追加，不改；已在时间轴上的目标跳过（幂等）。
 * 返回挂回后的最终窗口，供调用方按最终窗口做恢复守卫。调用方已持员工锁。
 */
export async function reattachFutureTransfers(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  leaveBusinessId: string,
): Promise<ReattachedTransfer[]> {
  const detached = rowsOf<{ recordId: string; staffId: string; from: string }>(
    await tx.execute(sql`
    SELECT x.target_id::text AS "recordId", r.staff_id::text AS "staffId", x.detail->'window'->>'from' AS "from"
    FROM exit_effects x JOIN employment_records r ON r.tenant_id=x.tenant_id AND r.id=x.target_id
    WHERE x.tenant_id=${ctx.tenantId} AND x.business_id=${leaveBusinessId}::uuid AND x.employee_id=${employeeId}::uuid
      AND x.kind='future_transfer_detached' AND x.phase='effective' AND x.target_type='employment-record'
      AND NOT EXISTS (SELECT 1 FROM employment_timeline t WHERE t.tenant_id=x.tenant_id AND t.record_id=x.target_id)
      -- 被摘下后又被 HR 删除的调动（墓碑）不再挂回：它没有时间轴行是正确的最终状态
      AND NOT EXISTS (SELECT 1 FROM employment_record_tombstones d
        WHERE d.tenant_id=x.tenant_id AND d.record_id=x.target_id)
    ORDER BY x.detail->'window'->>'from', x.id`),
  );
  for (const item of detached)
    await insertEmploymentTimeline(tx, ctx, employeeId, item.recordId, item.staffId, item.from);
  if (!detached.length) return [];
  const ids = sql.join(
    detached.map((item) => sql`${item.recordId}::uuid`),
    sql`, `,
  );
  return rowsOf<ReattachedTransfer>(
    await tx.execute(sql`SELECT record_id::text AS "recordId", start_date::text AS "from",
        upper(valid_during)::text AS "to"
      FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND record_id IN (${ids})
      ORDER BY start_date, sort_order`),
  );
}
