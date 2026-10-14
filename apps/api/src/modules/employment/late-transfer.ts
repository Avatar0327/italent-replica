/**
 * DEC-186：迟到执行的调动改到实际执行日——追加载荷版本并重建日期投影，保留底表、业务 ID 与原计划日审计。
 * DEC-278③（F-036 完成迟到重建前的窄口径 fail-closed，第 2 轮起不豁免未落地申请）：[计划日, 实际执行日) 内同一员工
 * 另有其他任职版本或业务时拒绝执行，记 REBUILD_REQUIRED 交 HR；区间内没有其他记录的简单迟到照常顺延。
 * 审批落地、定时生效、HR 重试三类入口都经 postponeLateTransfer 做同一判定（设计 §2）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { resolveLateExecution, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { validateTransferReposition } from './write-service.js';
import { personnelHooks } from './personnel-hooks.js';
import { rederiveRepositionedStatus } from './employee-status.js';
import { REBUILD_REQUIRED } from './activation-store.js';
import { auditEmployment } from './context.js';
import { loadEmploymentRecord } from './read-model.js';
import { insertEmploymentRow, rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import { insertEmploymentTimeline, operationKey, plannedEffectiveDate, timelinePosition } from './timeline.js';
import type { EmploymentContext } from './types.js';

export { REBUILD_REQUIRED };

/** 失败 detail 里最多保留的区间内记录数；超过时仍记 REBUILD_REQUIRED，只标 truncated（设计 §2.3）。 */
export const LATE_WINDOW_LIMIT = 1000;

export interface LateWindowBlocker {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  /** true = 已落地的任职版本；false = 未落地的申请单（草稿 / 审批中 / 已批准 / 已驳回）。 */
  readonly materialized: boolean;
}

export interface LateWindow {
  readonly blockers: LateWindowBlocker[];
  readonly truncated: boolean;
}

/**
 * 迟到调动 L 在时间轴上的位置：已落地取现有行（之后的行算区间内，严格大于）；未落地按 DEC-108 算出它落在计划日的
 * 插入位置（该位置及之后的行会随它插入而后移，算区间内，大于等于）。
 */
async function lateWindowPoint(
  tx: Tx,
  ctx: EmploymentContext,
  business: Pick<LockedEmploymentBusiness, 'id' | 'employeeId'>,
  plannedEffectiveDate: string,
) {
  const [existing] = rowsOf<{ date: string; order: number }>(
    await tx.execute(sql`
    SELECT start_date::text AS date, sort_order AS "order" FROM employment_timeline
    WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`),
  );
  if (existing) return { date: existing.date, order: Number(existing.order), inclusive: false };
  const position = await timelinePosition(tx, ctx, business.employeeId, plannedEffectiveDate, business.id);
  return { date: position.date, order: position.order, inclusive: true };
}

/**
 * [计划日, 实际执行日) 内、排在迟到调动 L 之后的其他任职版本（组织调整、其他调动、离职等，不分 kind），以及尚未落地、
 * 原计划日落在区间内且排在 L 之后的其他申请单（草稿 / 审批中 / 已批准 / 已驳回都算，DEC-278 补登）。“之后”用 C-3 的
 * 同日规则：原计划日更晚，或同日而操作序号更晚（与 timelinePosition 同一口径）；排在 L 之前的记录不随它移动，不算区间内。
 * limit 只供测试缩小上限。
 */
export async function lateWindowBlockers(
  tx: Tx,
  ctx: EmploymentContext,
  business: Pick<LockedEmploymentBusiness, 'id' | 'employeeId'>,
  planned: string,
  executionDate: string,
  limit = LATE_WINDOW_LIMIT,
): Promise<LateWindow> {
  const point = await lateWindowPoint(tx, ctx, business, planned);
  const after = point.inclusive ? sql`>=` : sql`>`;
  const plannedOf = plannedEffectiveDate(ctx.tenantId, sql`b.id`, sql`p.effective_date`);
  const rows = rowsOf<LateWindowBlocker>(
    await tx.execute(sql`
    SELECT t.record_id AS id, r.kind, t.start_date::text AS "effectiveDate", true AS materialized
    FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${business.employeeId}::uuid
      AND (t.start_date,t.sort_order) ${after} (${point.date}::date,${point.order})
      AND t.start_date<${executionDate}::date
    UNION ALL
    SELECT b.id, p.kind, p.effective_date::text AS "effectiveDate", false AS materialized
    FROM employment_business_objects b
    JOIN LATERAL (SELECT kind, effective_date FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${business.employeeId}::uuid AND b.id<>${business.id}::uuid
      AND s.state IN ('draft','in_review','approved','rejected')
      AND NOT EXISTS (SELECT 1 FROM employment_records r WHERE r.tenant_id=b.tenant_id AND r.id=b.id)
      AND ${plannedOf}>=${planned}::date AND ${plannedOf}<${executionDate}::date
      AND (${plannedOf}>${planned}::date
        OR ${operationKey(ctx.tenantId, sql`b.id`)}>${operationKey(ctx.tenantId, sql`${business.id}::uuid`)})
    ORDER BY 3, 1 LIMIT ${limit + 1}`),
  );
  return { blockers: rows.slice(0, limit), truncated: rows.length > limit };
}

async function assertNoRebuildRequired(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  planned: string,
  executionDate: string,
) {
  const { blockers, truncated } = await lateWindowBlockers(tx, ctx, business, planned, executionDate);
  if (!blockers.length) return;
  // activation-checks.ts / transitions.ts 把 activationFailure 记为生效失败（DEC-052）：审计 + HR 待办，任职不写入。
  throw new AppError('CONFLICT', '迟到执行需重建，待 HR 处理', {
    reason: REBUILD_REQUIRED,
    activationFailure: {
      reason: REBUILD_REQUIRED,
      detail: { plannedEffectiveDate: planned, executionDate, blockers, truncated },
    },
  });
}

/** 未落地申请的原计划日：首次改期事件记录的原生效日（批准当天改期但未落地的申请不丢原区间），否则取最新载荷。 */
async function originalPlannedDate(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  const [row] = rowsOf<{ planned: string }>(
    await tx.execute(
      sql`SELECT ${plannedEffectiveDate(
        ctx.tenantId,
        sql`${business.id}::uuid`,
        sql`${business.payload.effectiveDate}::date`,
      )}::text AS planned`,
    ),
  );
  return row?.planned ?? business.payload.effectiveDate;
}

export async function postponeLateTransfer(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const previous = business.payload;
  if (previous.kind !== 'transfer') return;
  const record = await loadEmploymentRecord(tx, ctx.tenantId, business.id, today);
  // 区间按原计划日判定（已落地取时间轴行，未落地取首次改期前的原计划日），在任何写入之前：批准当天已顺延、但因前序
  // 未落地留在队列的申请同日再执行时，最新载荷已是执行日，仍须复核原计划区间（设计 §2.3，S2-P2-01）。
  const planned = record ? record.effectiveDate : await originalPlannedDate(tx, ctx, business);
  if (resolveLateExecution({ plannedEffectiveDate: planned, executionDate: today }).late)
    await assertNoRebuildRequired(tx, ctx, business, planned, today);
  // 是否追加改期版本只看最新载荷（DEC-272）：已顺延到执行日的不再追加。
  if (!resolveLateExecution({ plannedEffectiveDate: previous.effectiveDate, executionDate: today }).late) return;
  const next = {
    ...previous,
    id: randomUUID(),
    versionNo: previous.versionNo + 1,
    previousVersionId: previous.id,
    effectiveDate: today,
    commandId: ctx.commandId,
    triggerBusinessId: business.id,
    ...(record
      ? { fields: record.fields, customFields: record.customFields, isRecordSnapshot: true, deferredFieldCodes: [] }
      : {}),
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  business.payload = next;
  await auditEmployment(
    tx,
    ctx,
    'employment.transfer.rescheduled',
    'employment-business',
    business.id,
    { effectiveDate: previous.effectiveDate },
    { originalEffectiveDate: previous.effectiveDate, effectiveDate: today },
  );
  if (record) {
    const [point] = rowsOf<{ startDate: string; sortOrder: number }>(
      await tx.execute(sql`
      SELECT start_date::text AS "startDate",sort_order AS "sortOrder" FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`),
    );
    const [before] = rowsOf<{ id: string }>(
      await tx.execute(sql`
      SELECT record_id AS id FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
        AND employee_id=${business.employeeId}::uuid
        AND (start_date,sort_order)<(${point!.startDate}::date,${point!.sortOrder})
      ORDER BY start_date DESC,sort_order DESC LIMIT 1`),
    );
    const [after] = rowsOf<{ date: string }>(
      await tx.execute(sql`
      SELECT start_date::text AS date FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
        AND employee_id=${business.employeeId}::uuid
        AND (start_date,sort_order)>(${point!.startDate}::date,${point!.sortOrder})
      ORDER BY start_date,sort_order LIMIT 1`),
    );
    await tx.execute(
      sql`DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`,
    );
    if (before)
      await tx.execute(sql`UPDATE employment_timeline
      SET valid_during=daterange(start_date,${after?.date ?? null}::date,'[)')
      WHERE tenant_id=${ctx.tenantId} AND record_id=${before.id}::uuid`);
    await validateTransferReposition(tx, ctx, business, record);
    await insertEmploymentTimeline(tx, ctx, business.employeeId, business.id, record.staffId, today);
    // F-022：移到当天后按新位置的前一条重新确定人员状态（跨过转正时取正式，不沿用原日期下的试用）
    await rederiveRepositionedStatus(tx, ctx, business);
  }
  if (record) await personnelHooks.sync(tx, ctx, business.employeeId, business.id, 'transfer', today);
}
