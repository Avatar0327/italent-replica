/** DEC-677 / DEC-679 / R2-T04 §8.4：申请先等待退休，Offer 同步须等退休落地。 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { AttemptRecord, PendingActivation } from './activation-store.js';
import { rowsOf } from './record-store.js';
import { operationKey, plannedEffectiveDate, timelinePosition, type TimelinePosition } from './timeline.js';
import type { BusinessKind, EmploymentContext } from './types.js';

export const RETIRE_REHIRE_REQUIRES_RETIREMENT = 'RETIRE_REHIRE_REQUIRES_RETIREMENT';
export const RETIRE_REHIRE_RETIREMENT_VOIDED = 'RETIRE_REHIRE_RETIREMENT_VOIDED';

/**
 * 未生效退休的唯一谓词；申请新增 / 改期 / 预览、Offer 计划与自动扫描共用。
 * 只读同租户同员工的最新状态与人工计划日；已物化、草稿、驳回、撤回及作废均不能提供前置。
 */
export function pendingRetirementId(tenantId: string, employeeId: string | SQL, rehireDate: string | SQL): SQL {
  const planned = plannedEffectiveDate(tenantId, sql`ret.id`, sql`rp.effective_date`);
  return sql`(
    SELECT ret.id FROM employment_business_objects ret
    JOIN LATERAL (SELECT kind, effective_date FROM employment_payload_versions rp
      WHERE rp.tenant_id=ret.tenant_id AND rp.business_id=ret.id ORDER BY rp.version_no DESC LIMIT 1) rp ON true
    JOIN LATERAL (SELECT state FROM employment_state_events rs
      WHERE rs.tenant_id=ret.tenant_id AND rs.business_id=ret.id ORDER BY rs.event_no DESC LIMIT 1) rs ON true
    WHERE ret.tenant_id=${tenantId} AND ret.employee_id=${employeeId}::uuid
      AND rp.kind='retirement' AND rs.state IN ('in_review','approved') AND ${planned}<${rehireDate}::date
      AND NOT EXISTS (SELECT 1 FROM employment_records rr WHERE rr.tenant_id=ret.tenant_id AND rr.id=ret.id)
    ORDER BY ${planned} DESC, ret.id LIMIT 1)`;
}

export const pendingRetirementBefore = (tenantId: string, employeeId: string | SQL, date: string | SQL): SQL =>
  sql`(${pendingRetirementId(tenantId, employeeId, date)} IS NOT NULL)`;

export async function hasPendingRetirement(tx: Tx, tenantId: string, employeeId: string, rehireDate: string) {
  const [row] = rowsOf<{ found: boolean }>(
    await tx.execute(sql`SELECT ${pendingRetirementBefore(tenantId, employeeId, rehireDate)} AS found`),
  );
  return row!.found;
}

/** 同日落地按真实插入点取前驱；发起时未指定插入点，仍按当日最后一条校验。 */
export async function sequencePredecessorKind(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  effectiveDate: string,
  beforeOrder?: number,
): Promise<BusinessKind | undefined> {
  const bound =
    beforeOrder === undefined
      ? sql`t.start_date <= ${effectiveDate}::date`
      : sql`(t.start_date, t.sort_order) < (${effectiveDate}::date, ${beforeOrder})`;
  const [latest] = rowsOf<{ kind: BusinessKind }>(
    await tx.execute(sql`SELECT r.kind FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=${tenantId} AND t.employee_id=${employeeId}::uuid AND ${bound}
      ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1`),
  );
  return latest?.kind;
}

export interface RehireDependency {
  readonly retirementId: string;
  readonly invalidated: boolean;
  readonly actualDate: string | null;
}

export async function rehireDependency(tx: Tx, tenantId: string, businessId: string) {
  const [row] = rowsOf<RehireDependency>(
    await tx.execute(sql`
    SELECT d.retirement_id::text AS "retirementId", (d.invalidated_at IS NOT NULL) AS invalidated,
      t.start_date::text AS "actualDate"
    FROM retire_rehire_dependencies d
    LEFT JOIN employment_timeline t ON t.tenant_id=d.tenant_id AND t.record_id=d.retirement_id
    WHERE d.tenant_id=${tenantId} AND d.business_id=${businessId}::uuid`),
  );
  return row;
}

type RehireDecision = Pick<AttemptRecord, 'reason' | 'detail' | 'blockedBy'> & {
  readonly outcome: 'failed' | 'suspended';
};

/**
 * DEC-677：未生效退休 → 挂起，关联退休作废 → 失败；取舍只在这里，先于通用前序挂起判断。
 * 定时、迟到审批、HR 重试与退休作废通知共用；不能因后来又建退休单而自动换掉依赖。
 */
export async function retireRehireActivationDecision(
  tx: Tx,
  ctx: EmploymentContext,
  item: Pick<PendingActivation, 'id' | 'employeeId' | 'kind' | 'effectiveDate'>,
): Promise<RehireDecision | null> {
  if (item.kind !== 'retire_rehire') return null;
  const dependency = await rehireDependency(tx, ctx.tenantId, item.id);
  if (dependency?.invalidated)
    return {
      outcome: 'failed',
      reason: RETIRE_REHIRE_RETIREMENT_VOIDED,
      detail: { retirementBusinessId: dependency.retirementId, message: '关联退休已作废' },
    };
  if (dependency && !dependency.actualDate)
    return {
      outcome: 'suspended',
      reason: RETIRE_REHIRE_REQUIRES_RETIREMENT,
      blockedBy: dependency.retirementId,
      detail: { retirementBusinessId: dependency.retirementId, message: '等待关联退休生效' },
    };
  const position = await timelinePosition(tx, ctx, item.employeeId, item.effectiveDate, item.id);
  const previous = await sequencePredecessorKind(tx, ctx.tenantId, item.employeeId, item.effectiveDate, position.order);
  if (previous === 'retirement') return null;
  return {
    outcome: 'failed',
    reason: RETIRE_REHIRE_REQUIRES_RETIREMENT,
    detail: { rule: RETIRE_REHIRE_REQUIRES_RETIREMENT },
  };
}

/**
 * 退休后的返聘保留谓词（候选别名 b / p）：先模拟本退休插入，再取返聘插入点前最后一条。
 * 未来调动会被退休摘下，不作为前驱；同时返聘会在次日开新周期，不能把更后的另一个返聘当作可继续等待。
 * 过滤在候选 LIMIT 之前完成，保留 F-237 的真实超限语义；同日位置沿用 timelinePosition 的 C-3 排序。
 */
export function rehireSurvivesRetirement(
  tenantId: string,
  employeeId: string,
  position: TimelinePosition,
  generatedRehireDate?: string,
  retirementId?: string,
): SQL {
  const linked = retirementId
    ? sql`EXISTS (SELECT 1 FROM retire_rehire_dependencies d
    WHERE d.tenant_id=${tenantId} AND d.business_id=b.id AND d.retirement_id=${retirementId}::uuid
      AND d.invalidated_at IS NULL)`
    : sql`false`;
  const date = sql`CASE WHEN ${linked} THEN greatest(p.effective_date, ${position.date}::date+1)
    ELSE p.effective_date END`;
  const planned = plannedEffectiveDate(tenantId, sql`b.id`, sql`p.effective_date`);
  const cutPlanned = plannedEffectiveDate(tenantId, sql`cut.record_id`, sql`cut.start_date`);
  return sql`(p.kind='retire_rehire' AND (${date})>=${position.date}::date
    ${generatedRehireDate ? sql`AND (${date})<${generatedRehireDate}::date` : sql``}
    AND COALESCE((SELECT r.kind FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=${tenantId} AND t.employee_id=${employeeId}::uuid AND r.kind<>'transfer'
        AND (t.start_date,t.sort_order)>=(${position.date}::date,${position.order})
        AND (t.start_date<(${date}) OR (t.start_date=(${date}) AND t.sort_order<COALESCE(
          (SELECT min(cut.sort_order) FROM employment_timeline cut
            WHERE cut.tenant_id=t.tenant_id AND cut.employee_id=t.employee_id AND cut.start_date=(${date})
              AND (${cutPlanned}>${planned} OR (${cutPlanned}=${planned}
                AND ${operationKey(tenantId, sql`cut.record_id`)}>${operationKey(tenantId, sql`b.id`)}))),
          (SELECT COALESCE(max(last.sort_order)+1,0) FROM employment_timeline last
            WHERE last.tenant_id=t.tenant_id AND last.employee_id=t.employee_id AND last.start_date=(${date})))))
      ORDER BY t.start_date DESC,t.sort_order DESC LIMIT 1), 'retirement')='retirement')`;
}
