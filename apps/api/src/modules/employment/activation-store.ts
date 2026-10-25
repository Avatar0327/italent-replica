/**
 * 待生效业务队列与生效尝试记录（R1-T08）。待生效业务 = 最新状态为「审批通过」的申请单（DEC-125：生效前只有申请单，
 * 不进任职版本链）。同一员工的队列顺序 = 最终执行日期 → 计划生效日 → 同日结束周期类在前、开新周期类在后（DEC-077 保留部分）
 * → 操作先后（DEC-108：最近一次提交的状态事件序号，与 timeline.ts 落地插入点同一口径）；规则只有一份，
 * 在 domain execution-order.ts（设计 §5.0），下面的 SQL 是它的镜像，验收测试断言两者等价。
 * 调用方须先持员工行锁：同员工的全部任职写入都先锁员工（record-store.ts）。
 */
import { employmentActivationAttempts, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { auditEmployment, employmentCreator, employmentScopePredicate } from './context.js';
import { rowsOf } from './record-store.js';
import { operationKey, plannedEffectiveDate } from './timeline.js';
import type { BusinessKind, EmploymentContext, EmploymentScope } from './types.js';

export type ActivationOutcome = 'effective' | 'failed' | 'suspended' | 'replanned';
export type ActivationTrigger = 'scheduler' | 'retry' | 'approval';
/** DEC-112：因前序业务失败挂起。 */
export const PREDECESSOR_FAILED = 'PREDECESSOR_FAILED';
/** DEC-278③：迟到执行区间内另有记录，需重建、待 HR 处理（late-transfer.ts 判定）。 */
export const REBUILD_REQUIRED = 'REBUILD_REQUIRED';

export interface PendingActivation {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly kind: BusinessKind;
  /** 最新载荷版本的生效日：迟到顺延后是系统写入的执行日，不是计划日；排序与到期判断不读它。 */
  readonly effectiveDate: string;
  /** §5.0A 计划生效日（timeline.ts plannedEffectiveDate）：到期截取、同日先后与迟到判定的起点。 */
  readonly plannedDate: string;
  /** §5.0 最终执行日期：若在租户今天落地，实际写入的生效日（队列第一排序键）。 */
  readonly finalDate: string;
  /** 申请单上显式填写的调入部门 / 职位（含向后更新同步过来的值）；未填时为空，继承值由生效时解析。 */
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly materialized: boolean;
  /** DEC-173：已落地且当前没有联动，仅提醒，不阻塞其后业务。 */
  readonly reminderOnly: boolean;
  readonly lastOutcome: ActivationOutcome | null;
  readonly lastBlockedBy: string | null;
  readonly lastAttemptNo: number;
  /** 最近一次尝试的失败原因与其 detail.blockers（REBUILD_REQUIRED 时为区间内的业务，设计 §2.5）。 */
  readonly lastReason: string | null;
  readonly lastBlockerIds: readonly string[];
}

const QUEUE_LIMIT = 200;

/**
 * 已落地的未来调动统一复查；成功尝试退出队列，失败保留 HR 待办。兼容旧版联动事件及 PR-A 未写排队事件、保存时为未来生效的记录（租户日期）。
 * 离职（含 approved 直接离职）与申请一样参与排序、前序与 HR 待办（R2-T03 §18.1 关口①，B3-3 起）。
 */
export const pendingActivationState = (timezone: string) => sql`((s.state='approved' AND
    (p.mode='application' OR p.kind IN ('leave','retirement')) OR
  s.state='effective' AND p.kind='transfer' AND (EXISTS (
    SELECT 1 FROM employment_outbox o WHERE o.tenant_id=b.tenant_id AND o.business_id=b.id
      AND o.event_type IN ('employment.transfer.recheck.pending','employment.transfer.linkage.pending'))
    OR EXISTS (SELECT 1 FROM employment_records original
      WHERE original.tenant_id=b.tenant_id AND original.id=b.id
        AND original.start_date > (original.created_at AT TIME ZONE ${timezone})::date))
    AND NOT EXISTS (SELECT 1 FROM employment_activation_attempts done
      WHERE done.tenant_id=b.tenant_id AND done.business_id=b.id AND done.outcome='effective')
    AND NOT EXISTS (SELECT 1 FROM employment_outbox o WHERE o.tenant_id=b.tenant_id AND o.business_id=b.id
      AND o.event_type='employment.transfer.linked')))`;

/**
 * 已失效的“员工已离职”失败（离职设计 §5.8，B4 第 1 轮 P2-4）：未来直接调动 T 被离职摘下后到期复查记
 * EMPLOYEE_DEPARTED_BEFORE_TRANSFER；撤销离职把 T 挂回时间轴后，这条失败不再成立，待办 / 队列 / 生效结果都不再看它。
 * 只改“最近一次有效尝试”的取法，尝试历史行原样保留（审计）；T 没有因此被标为已完成，未到期的联动仍待执行。
 * 引用别名 a（employment_activation_attempts），只依赖 employment_timeline，升级前的旧结构同样可用。
 */
export const STALE_DEPARTED_FAILURE = sql`(COALESCE(a.reason, '') = 'EMPLOYEE_DEPARTED_BEFORE_TRANSFER' AND EXISTS (
  SELECT 1 FROM employment_timeline tl WHERE tl.tenant_id=a.tenant_id AND tl.record_id=a.business_id))`;

export type ShiftedKind = 'transfer' | 'leave' | 'retirement';

/**
 * 最终执行日期的 SQL 镜像（domain `finalExecutionDate`，设计 §5.0）：`shifted` 里的 kind 按 greatest(计划日, 今天)
 * （resolveLateExecution / resolveLateLeave 的投影，DEC-272），其余 kind 按计划日不顺延；默认调动与离职都顺延，与纯函数逐点等价。
 * `planned` 一律传 §5.0A 的计划生效日（`plannedEffectiveDate`），不再各处自读载荷日。
 */
export function finalExecutionDateSql(
  kind: SQL,
  planned: SQL,
  today: string,
  shifted: readonly ShiftedKind[] = ['transfer', 'leave', 'retirement'],
): SQL {
  const kinds = sql.join(
    shifted.map((item) => sql`${item}`),
    sql`, `,
  );
  return sql`(CASE WHEN ${kind}::text IN (${kinds}) THEN greatest(${planned}, ${today}::date) ELSE ${planned} END)`;
}

/** 待生效队列按“最终执行日期”顺延的 kind：调动、离职与退休同式（设计 §5.0，DEC-272；退休见 R2-T04 §4.2）。 */
export const QUEUE_SHIFTED_KINDS: readonly ShiftedKind[] = ['transfer', 'leave', 'retirement'];

/** 一名员工的全部待生效业务，按生效顺序排列（未到期的也在内，调用方按业务日截取）。 */
export async function pendingActivations(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  shifted: readonly ShiftedKind[] = QUEUE_SHIFTED_KINDS,
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const planned = plannedEffectiveDate(ctx.tenantId, sql`b.id`, sql`p.effective_date`);
  const finalDate = finalExecutionDateSql(sql`p.kind`, planned, today, shifted);
  const rows = rowsOf<PendingActivation>(
    await tx.execute(sql`
    SELECT b.id, b.employee_id AS "employeeId", b.revision, p.kind, p.effective_date::text AS "effectiveDate",
      ${planned}::text AS "plannedDate", ${finalDate}::text AS "finalDate",
      CASE WHEN 'preset:departmentId' = ANY(p.explicit_field_codes) THEN p.department_id END AS "departmentId",
      CASE WHEN 'preset:positionId' = ANY(p.explicit_field_codes) THEN p.position_id END AS "positionId",
      (s.state='effective') AS materialized,
      (s.state='effective' AND NOT (COALESCE(p.is_department_head,false) OR COALESCE(p.is_store_manager,false)
        OR COALESCE(cardinality(p.added_subordinate_ids),0)>0
        OR EXISTS (SELECT 1 FROM transfer_linkage_versions v
          WHERE v.tenant_id=b.tenant_id AND v.business_id=b.id))) AS "reminderOnly",
      a.outcome AS "lastOutcome", a.blocked_by_business_id AS "lastBlockedBy",
      (SELECT COALESCE(max(n.attempt_no), 0) FROM employment_activation_attempts n
        WHERE n.tenant_id=b.tenant_id AND n.business_id=b.id) AS "lastAttemptNo", a.reason AS "lastReason",
      COALESCE((SELECT jsonb_agg(item->>'id') FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.detail->'blockers')='array' THEN a.detail->'blockers' ELSE '[]'::jsonb END) item),
        '[]'::jsonb) AS "lastBlockerIds"
    FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.employee_id=b.employee_id AND p.business_id=b.id
      ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.employee_id=b.employee_id AND s.business_id=b.id
      ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT outcome, blocked_by_business_id, attempt_no, reason, detail
      FROM employment_activation_attempts a
      WHERE a.tenant_id=b.tenant_id AND a.business_id=b.id AND NOT ${STALE_DEPARTED_FAILURE}
      ORDER BY a.attempt_no DESC LIMIT 1) a ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
      AND ${pendingActivationState(ctx.timezone)}
    ORDER BY ${finalDate}, ${planned},
      p.kind IN ('hire', 'rehire', 'retire_rehire'), ${operationKey(ctx.tenantId, sql`b.id`)}
    LIMIT ${QUEUE_LIMIT + 1}
  `),
  ).map((row) => ({
    ...row,
    revision: Number(row.revision),
    lastAttemptNo: Number(row.lastAttemptNo),
    lastBlockerIds: blockerIds(row.lastBlockerIds),
  }));
  if (rows.length > QUEUE_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '待生效业务超过单名员工的处理上限');
  return rows;
}

export interface OverdueTransfer {
  readonly id: string;
  readonly kind: 'transfer';
  /** §5.0A 计划生效日（不是最新载荷日）。 */
  readonly effectiveDate: string;
  readonly materialized: boolean;
  readonly departmentId: string | null;
}

/**
 * 逾期迟到调动（设计 §8A，DEC-252①“已过计划日未执行”）：计划生效日 < 租户今天的调动。
 * blocking：A 未落地的申请、B 已落地但联动未完成；reminders：C 已落地且只剩提醒（不拦截，进 warnings）。只读，离职 / 退休入口共用。
 */
export async function findOverdueTransfers(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const overdue = (await pendingActivations(tx, ctx, employeeId))
    .filter((item) => item.kind === 'transfer' && item.plannedDate < today)
    .map((item) => ({
      id: item.id,
      kind: 'transfer' as const,
      effectiveDate: item.plannedDate,
      materialized: item.materialized,
      departmentId: item.departmentId,
      reminderOnly: item.reminderOnly,
    }));
  const strip = ({ reminderOnly: _reminder, ...item }: (typeof overdue)[number]): OverdueTransfer => item;
  return {
    blocking: overdue.filter((item) => !item.reminderOnly).map(strip),
    reminders: overdue.filter((item) => item.reminderOnly).map(strip),
  };
}

/** 排在该业务之前的待生效业务（DEC-108 / DEC-112：前序未落地时不得越过它生效）。 */
export async function activationPredecessors(tx: Tx, ctx: EmploymentContext, employeeId: string, businessId: string) {
  const queue = await pendingActivations(tx, ctx, employeeId);
  const index = queue.findIndex((item) => item.id === businessId);
  return { item: index < 0 ? undefined : queue[index], before: index < 0 ? [] : queue.slice(0, index) };
}

function blockerIds(value: unknown): string[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

/** 生效失败 detail.blockers 里的业务 ID（REBUILD_REQUIRED，late-transfer.ts 写入）。 */
export function failureBlockerIds(detail: Record<string, unknown> | undefined): string[] {
  const blockers = detail?.blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.map((item) => (item as { id?: unknown }).id).filter((id): id is string => typeof id === 'string');
}

/**
 * 设计 §2.5（S1-P2-02）：前序因迟到区间内含本业务而记 REBUILD_REQUIRED。是否据此豁免还要看两笔有没有跨对象联动
 * 依赖（linkage-dependency.ts 的 exemptsBlocker）；本函数只判定“本业务是那次失败的 blocker”。
 */
export function isRebuildBlocker(predecessor: PendingActivation, businessId: string): boolean {
  return (
    predecessor.lastOutcome === 'failed' &&
    predecessor.lastReason === REBUILD_REQUIRED &&
    predecessor.lastBlockerIds.includes(businessId)
  );
}

export interface UnresolvedPredecessor {
  readonly item: PendingActivation;
  /** 记为 blockedBy 的来源失败业务：前序自己失败时是它本身，前序被挂起时沿用它的来源（DEC-112 只记失败的那条）。 */
  readonly failedId: string;
}

/**
 * 尚未解决的第一笔前序（DEC-112：失败未修正、或因前序失败挂起的，其后的业务一律挂起在它之后；S3-P2-01：对照全部
 * 前序而不只是最近一次失败）；调用方先用 blockingPredecessors 去掉只提醒与豁免的前序。
 */
export function unresolvedPredecessor(before: readonly PendingActivation[]): UnresolvedPredecessor | undefined {
  for (const item of before) {
    if (item.reminderOnly) continue;
    if (item.lastOutcome === 'failed') return { item, failedId: item.id };
    if (item.lastOutcome === 'suspended') return { item, failedId: item.lastBlockedBy ?? item.id };
  }
  return undefined;
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
 * DEC-173 按期复查只追加尝试与通知；迟到改期另按 DEC-186 推进任职投影及头版本。
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
  if (attempt.outcome !== 'effective' && !item.reminderOnly && options.bumpRevision !== false) {
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
  readonly details?: Record<string, unknown>;
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
    detail: Record<string, unknown>;
    lastAttemptAt: string | Date | null;
  }>(
    await tx.execute(sql`
    SELECT last.outcome, last.reason, last.detail, last.blocked_by_business_id AS "blockedBy",
      last.created_at AS "lastAttemptAt",
      (SELECT count(*)::int FROM employment_activation_attempts f
        WHERE f.tenant_id=${tenantId} AND f.business_id=${businessId}::uuid AND f.outcome='failed') AS failures
    FROM (SELECT 1) seed LEFT JOIN LATERAL (
      SELECT * FROM employment_activation_attempts a WHERE a.tenant_id=${tenantId} AND a.business_id=${businessId}::uuid
        AND NOT ${STALE_DEPARTED_FAILURE}
      ORDER BY a.attempt_no DESC LIMIT 1
    ) last ON true
  `),
  );
  const failureCount = Number(row?.failures ?? 0);
  const lastAttemptAt =
    row?.outcome !== 'replanned' && row?.lastAttemptAt ? new Date(row.lastAttemptAt).toISOString() : null;
  if (state === 'approved') {
    const open = row?.outcome === 'failed' || row?.outcome === 'suspended' ? row.outcome : null;
    return {
      status: open ?? 'pending',
      ...(open === 'failed' && row?.reason === 'EXIT_LATER_RECORD_EXISTS' ? { details: row.detail } : {}),
      failureCount,
      failureReason: open ? row!.reason : null,
      blockedByBusinessId: open === 'suspended' ? row!.blockedBy : null,
      lastAttemptAt,
    };
  }
  if (state !== 'effective' || !row?.outcome || row.outcome === 'replanned') return null;
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
 * HR “生效失败 / 挂起”待办（DEC-052 / DEC-112，离职设计 §10.1：共同迟到后两笔各一条）：仍为审批通过、最近一次尝试
 * 失败或因前序失败挂起的申请。待办随状态派生，重试成功或删除申请即关闭；返回真实状态、原因和前序标识（挂起项的 blockedBy）；
 * 失败次数只统计 failed 尝试；可见范围按当前操作人的数据范围重新裁剪（AGENTS.md §10「权限」），不预先固化接收人。
 */
export async function listActivationTodos(
  tx: Tx,
  tenantId: string,
  page: { readonly limit: number; readonly offset: number },
  scope: EmploymentScope | undefined,
  timezone: string,
  userId?: string,
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
    outcome: 'failed' | 'suspended';
    reason: string;
    blockedBy: string | null;
    failures: number;
    failedAt: string | Date;
    detail: Record<string, unknown>;
  }>(
    await tx.execute(sql`
    SELECT b.id, b.employee_id AS "employeeId", p.kind, p.effective_date::text AS "effectiveDate",
      a.outcome, a.reason, a.detail, a.blocked_by_business_id AS "blockedBy", a.created_at AS "failedAt",
      (SELECT count(*)::int FROM employment_activation_attempts f
        WHERE f.tenant_id=b.tenant_id AND f.business_id=b.id AND f.outcome='failed') AS failures
    FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    JOIN LATERAL (SELECT * FROM employment_activation_attempts a
      WHERE a.tenant_id=b.tenant_id AND a.business_id=b.id AND NOT ${STALE_DEPARTED_FAILURE}
      ORDER BY a.attempt_no DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT r.department_id FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=b.tenant_id AND t.employee_id=b.employee_id AND t.start_date<=p.effective_date
      ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) current_record ON true
    WHERE b.tenant_id=${tenantId} AND ${pendingActivationState(timezone)}
      AND a.outcome IN ('failed','suspended') AND ${scopeFilter}
      AND (a.reason<>'EXIT_LATER_RECORD_EXISTS' OR ${userId ?? null}::uuid IS NULL
        OR a.detail->>'recipientUserId'=${userId ?? null})
    ORDER BY p.effective_date, ${operationKey(tenantId, sql`b.id`)} LIMIT ${page.limit} OFFSET ${page.offset}
  `),
  );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    effectiveDate: row.effectiveDate,
    activation: {
      status: row.outcome,
      ...(row.reason === 'EXIT_LATER_RECORD_EXISTS' ? { details: row.detail } : {}),
      failureCount: Number(row.failures),
      failureReason: row.reason,
      blockedByBusinessId: row.outcome === 'suspended' ? row.blockedBy : null,
      lastAttemptAt: new Date(row.failedAt).toISOString(),
    },
  }));
}
