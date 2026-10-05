/**
 * 待生效业务队列与生效尝试记录（R1-T08）。待生效业务 = 最新状态为「审批通过」的申请单（DEC-125：生效前只有申请单，
 * 不进任职版本链）。同一员工的队列顺序 = 生效日 → 同日结束周期类在前、开新周期类在后（DEC-077 保留部分）
 * → 操作先后（DEC-108：最近一次提交的状态事件序号，与 timeline.ts 落地插入点同一口径）。调用方须先持员工行锁：同员工的全部任职写入都先锁员工（record-store.ts）。
 */
import { employmentActivationAttempts, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { auditEmployment, employmentCreator, employmentScopePredicate } from './context.js';
import { rowsOf } from './record-store.js';
import { operationKey } from './timeline.js';
import type { BusinessKind, EmploymentContext, EmploymentScope } from './types.js';

export type ActivationOutcome = 'effective' | 'failed' | 'suspended';
export type ActivationTrigger = 'scheduler' | 'retry' | 'approval';
/** DEC-112：因前序业务失败挂起。 */
export const PREDECESSOR_FAILED = 'PREDECESSOR_FAILED';

export interface PendingActivation {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly kind: BusinessKind;
  readonly effectiveDate: string;
  /** 申请单上显式填写的调入部门 / 职位（含向后更新同步过来的值）；未填时为空，继承值由生效时解析。 */
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly materialized: boolean;
  readonly lastOutcome: ActivationOutcome | null;
  readonly lastBlockedBy: string | null;
  readonly lastAttemptNo: number;
}

const QUEUE_LIMIT = 200;

/** 直接未来调动已有任职记录，但联动仍要到期执行；与申请共用失败、挂起、重试协议。 */
export const pendingActivationState = sql`(s.state='approved' AND p.mode='application' OR
  s.state='effective' AND p.kind='transfer' AND EXISTS (
    SELECT 1 FROM employment_outbox o WHERE o.tenant_id=b.tenant_id AND o.business_id=b.id
      AND o.event_type='employment.transfer.linkage.pending') AND NOT EXISTS (
    SELECT 1 FROM employment_outbox o WHERE o.tenant_id=b.tenant_id AND o.business_id=b.id
      AND o.event_type='employment.transfer.linked'))`;

/** 一名员工的全部待生效业务，按生效顺序排列（未到期的也在内，调用方按业务日截取）。 */
export async function pendingActivations(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const rows = rowsOf<PendingActivation>(
    await tx.execute(sql`
    SELECT b.id, b.employee_id AS "employeeId", b.revision, p.kind, p.effective_date::text AS "effectiveDate",
      CASE WHEN 'preset:departmentId' = ANY(p.explicit_field_codes) THEN p.department_id END AS "departmentId",
      CASE WHEN 'preset:positionId' = ANY(p.explicit_field_codes) THEN p.position_id END AS "positionId",
      (s.state='effective') AS materialized, a.outcome AS "lastOutcome", a.blocked_by_business_id AS "lastBlockedBy",
      COALESCE(a.attempt_no, 0) AS "lastAttemptNo"
    FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.employee_id=b.employee_id AND p.business_id=b.id
      ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.employee_id=b.employee_id AND s.business_id=b.id
      ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT outcome, blocked_by_business_id, attempt_no FROM employment_activation_attempts a
      WHERE a.tenant_id=b.tenant_id AND a.business_id=b.id ORDER BY a.attempt_no DESC LIMIT 1) a ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
      AND ${pendingActivationState}
    ORDER BY p.effective_date, p.kind IN ('hire', 'rehire', 'retire_rehire'), ${operationKey(ctx.tenantId, sql`b.id`)}
    LIMIT ${QUEUE_LIMIT + 1}
  `),
  ).map((row) => ({ ...row, revision: Number(row.revision), lastAttemptNo: Number(row.lastAttemptNo) }));
  if (rows.length > QUEUE_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '待生效业务超过单名员工的处理上限');
  return rows;
}

/** 排在该业务之前的待生效业务（DEC-108 / DEC-112：前序未落地时不得越过它生效）。 */
export async function activationPredecessors(tx: Tx, ctx: EmploymentContext, employeeId: string, businessId: string) {
  const queue = await pendingActivations(tx, ctx, employeeId);
  const index = queue.findIndex((item) => item.id === businessId);
  return { item: index < 0 ? undefined : queue[index], before: index < 0 ? [] : queue.slice(0, index) };
}

/** 失败尚未修正的前序（其后的业务按 DEC-112 一律挂起在它之后）。 */
export function failedPredecessor(before: readonly PendingActivation[]): PendingActivation | undefined {
  return before.find((item) => item.lastOutcome === 'failed');
}

export interface AttemptRecord {
  readonly outcome: ActivationOutcome;
  readonly trigger: ActivationTrigger;
  readonly reason?: string;
  readonly detail?: Record<string, unknown>;
  readonly blockedBy?: string;
}

/**
 * 记一次生效尝试，与业务写入、审计、outbox 同事务（AGENTS.md §10）。失败 / 挂起时递增业务 revision，
 * 使 HR 重试必须基于看到的最新结果提交（409 而不是盲重试）；生效时 revision 已由状态迁移递增。
 */
export async function recordActivationAttempt(
  tx: Tx,
  ctx: EmploymentContext,
  item: PendingActivation,
  attempt: AttemptRecord,
  options: { readonly bumpRevision?: boolean } = {},
): Promise<void> {
  const attemptNo = item.lastAttemptNo + 1;
  const businessDate = tenantLocalDate(ctx.now, ctx.timezone);
  const after = {
    attempt: attemptNo,
    outcome: attempt.outcome,
    trigger: attempt.trigger,
    reason: attempt.reason ?? null,
    detail: attempt.detail ?? {},
    blockedByBusinessId: attempt.blockedBy ?? null,
    businessDate,
  };
  await tx.insert(employmentActivationAttempts).values({
    tenantId: ctx.tenantId,
    employeeId: item.employeeId,
    businessId: item.id,
    attemptNo,
    outcome: attempt.outcome,
    reason: after.reason,
    detail: after.detail,
    blockedByBusinessId: after.blockedByBusinessId,
    businessDate,
    trigger: attempt.trigger,
    actorUserId: auditActor(ctx.userId),
    commandId: ctx.commandId,
    createdAt: ctx.now,
  });
  if (attempt.outcome !== 'effective' && options.bumpRevision !== false) {
    await tx.execute(sql`UPDATE employment_business_objects SET revision=revision+1
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${item.employeeId}::uuid AND id=${item.id}::uuid`);
  }
  // 生效失败事件即 HR 待办的通知来源（outbox 消费者推送给对该员工有权的 HR）。
  await auditEmployment(
    tx,
    ctx,
    `employment.activation.${attempt.outcome}`,
    'employment-business',
    item.id,
    null,
    after,
  );
}

export interface ActivationSummary {
  readonly status: 'pending' | ActivationOutcome;
  readonly failureCount: number;
  readonly failureReason: string | null;
  readonly blockedByBusinessId: string | null;
  readonly lastAttemptAt: string | null;
}

/** 业务详情中的生效结果：审批通过的申请与有过尝试的业务才有；挂起原因与失败原因同字段。 */
export async function activationSummary(
  tx: Tx,
  tenantId: string,
  businessId: string,
  state: string,
): Promise<ActivationSummary | null> {
  const [row] = rowsOf<{
    outcome: ActivationOutcome | null;
    reason: string | null;
    blockedBy: string | null;
    failures: number;
    lastAttemptAt: string | Date | null;
  }>(
    await tx.execute(sql`
    SELECT last.outcome, last.reason, last.blocked_by_business_id AS "blockedBy", last.created_at AS "lastAttemptAt",
      (SELECT count(*)::int FROM employment_activation_attempts f
        WHERE f.tenant_id=${tenantId} AND f.business_id=${businessId}::uuid AND f.outcome='failed') AS failures
    FROM (SELECT 1) seed LEFT JOIN LATERAL (
      SELECT * FROM employment_activation_attempts a WHERE a.tenant_id=${tenantId} AND a.business_id=${businessId}::uuid
      ORDER BY a.attempt_no DESC LIMIT 1
    ) last ON true
  `),
  );
  const failureCount = Number(row?.failures ?? 0);
  const lastAttemptAt = row?.lastAttemptAt ? new Date(row.lastAttemptAt).toISOString() : null;
  if (state === 'approved') {
    const open = row?.outcome === 'failed' || row?.outcome === 'suspended' ? row.outcome : null;
    return {
      status: open ?? 'pending',
      failureCount,
      failureReason: open ? row!.reason : null,
      blockedByBusinessId: open === 'suspended' ? row!.blockedBy : null,
      lastAttemptAt,
    };
  }
  if (state !== 'effective' || !row?.outcome) return null;
  return {
    status: row.outcome,
    failureCount,
    failureReason: row.reason,
    blockedByBusinessId: row.blockedBy,
    lastAttemptAt,
  };
}

export interface ActivationTodo {
  readonly id: string;
  readonly employeeId: string;
  readonly kind: BusinessKind;
  readonly effectiveDate: string;
  readonly activation: ActivationSummary;
}

/**
 * HR “生效失败”待办（DEC-052）：仍为审批通过、最近一次尝试失败的申请。待办随状态派生，重试成功或删除申请即关闭；
 * 可见范围按当前操作人的数据范围重新裁剪（AGENTS.md §10「权限」），不预先固化接收人。
 */
export async function listActivationTodos(
  tx: Tx,
  tenantId: string,
  page: { readonly limit: number; readonly offset: number },
  scope?: EmploymentScope,
): Promise<ActivationTodo[]> {
  const department = sql`COALESCE(p.department_id, current_record.department_id)`;
  const scopeFilter = employmentScopePredicate(
    scope,
    sql`b.employee_id`,
    department,
    employmentCreator(tenantId, sql`b.id`, true),
  );
  const rows = rowsOf<{
    id: string;
    employeeId: string;
    kind: BusinessKind;
    effectiveDate: string;
    reason: string;
    failures: number;
    failedAt: string | Date;
  }>(
    await tx.execute(sql`
    SELECT b.id, b.employee_id AS "employeeId", p.kind, p.effective_date::text AS "effectiveDate",
      a.reason, a.created_at AS "failedAt",
      (SELECT count(*)::int FROM employment_activation_attempts f
        WHERE f.tenant_id=b.tenant_id AND f.business_id=b.id AND f.outcome='failed') AS failures
    FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    JOIN LATERAL (SELECT * FROM employment_activation_attempts a
      WHERE a.tenant_id=b.tenant_id AND a.business_id=b.id ORDER BY a.attempt_no DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT r.department_id FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=b.tenant_id AND t.employee_id=b.employee_id AND t.start_date<=p.effective_date
      ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) current_record ON true
    WHERE b.tenant_id=${tenantId} AND ${pendingActivationState} AND a.outcome='failed' AND ${scopeFilter}
    ORDER BY p.effective_date, ${operationKey(tenantId, sql`b.id`)} LIMIT ${page.limit} OFFSET ${page.offset}
  `),
  );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    effectiveDate: row.effectiveDate,
    activation: {
      status: 'failed',
      failureCount: Number(row.failures),
      failureReason: row.reason,
      blockedByBusinessId: null,
      lastAttemptAt: new Date(row.failedAt).toISOString(),
    },
  }));
}
