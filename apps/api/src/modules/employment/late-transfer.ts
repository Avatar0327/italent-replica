/**
 * DEC-186：迟到执行的调动改到实际执行日——追加载荷版本并重建日期投影，保留底表、业务 ID 与原计划日审计。
 * DEC-278③（F-036 完成迟到重建前的窄口径 fail-closed）：[计划日, 实际执行日) 内同一员工另有其他任职版本或业务时
 * 拒绝执行，记 REBUILD_REQUIRED 交 HR；区间内没有其他记录的简单迟到照常顺延。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { resolveLateExecution, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { validateTransferReposition } from './write-service.js';
import { personnelHooks } from './personnel-hooks.js';
import { rederiveRepositionedStatus } from './employee-status.js';
import { auditEmployment } from './context.js';
import { loadEmploymentRecord } from './read-model.js';
import { insertEmploymentRow, rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import { insertEmploymentTimeline } from './timeline.js';
import type { EmploymentContext } from './types.js';

/** 生效失败原因：迟到执行需重建，待 HR 处理（DEC-278③；F-036 落地重建后由其接管）。 */
export const REBUILD_REQUIRED = 'REBUILD_REQUIRED';

export interface LateWindowBlocker {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  /** true = 已落地的任职版本；false = 未落地的申请单（草稿 / 审批中 / 已批准 / 已驳回）。 */
  readonly materialized: boolean;
}

/**
 * [计划日, 实际执行日) 内、排在迟到调动之后的其他任职版本（组织调整、其他调动、离职等），以及生效日落在区间内、
 * 尚未落地的其他申请单。同日排在它前面的记录不随它移动，不算区间内。
 */
export async function lateWindowBlockers(
  tx: Tx,
  ctx: EmploymentContext,
  business: Pick<LockedEmploymentBusiness, 'id' | 'employeeId'>,
  plannedEffectiveDate: string,
  executionDate: string,
): Promise<LateWindowBlocker[]> {
  const rows = rowsOf<LateWindowBlocker>(
    await tx.execute(sql`
    WITH point AS (SELECT start_date, sort_order FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid)
    SELECT t.record_id AS id, r.kind, t.start_date::text AS "effectiveDate", true AS materialized
    FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    CROSS JOIN point
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${business.employeeId}::uuid
      AND (t.start_date,t.sort_order)>(point.start_date,point.sort_order) AND t.start_date<${executionDate}::date
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
      AND p.effective_date>=${plannedEffectiveDate}::date AND p.effective_date<${executionDate}::date
    ORDER BY 3, 1 LIMIT 1001`),
  );
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '迟到执行区间内的记录超过单次处理上限');
  return rows;
}

async function assertNoRebuildRequired(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  plannedEffectiveDate: string,
  executionDate: string,
) {
  const blockers = await lateWindowBlockers(tx, ctx, business, plannedEffectiveDate, executionDate);
  if (!blockers.length) return;
  // activation-checks.ts 把 activationFailure 记为生效失败（DEC-052）：审计 + HR 待办，任职不写入。
  throw new AppError('CONFLICT', '迟到执行需重建，待 HR 处理', {
    reason: REBUILD_REQUIRED,
    activationFailure: {
      reason: REBUILD_REQUIRED,
      detail: { plannedEffectiveDate, executionDate, blockers },
    },
  });
}

export async function postponeLateTransfer(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const previous = business.payload;
  const { late } = resolveLateExecution({ plannedEffectiveDate: previous.effectiveDate, executionDate: today });
  if (previous.kind !== 'transfer' || !late) return;
  const record = await loadEmploymentRecord(tx, ctx.tenantId, business.id, today);
  // 已落地的直接 / 已批准未来调动才有区间内的其他记录；审批通过落地的申请单在此之前不在时间轴上（DEC-125）。
  if (record) await assertNoRebuildRequired(tx, ctx, business, record.effectiveDate, today);
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
