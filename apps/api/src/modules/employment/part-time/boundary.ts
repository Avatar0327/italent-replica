/**
 * 主职周期边界统一校验（docs/08_设计/R2-T05_兼职设计.md §4.3A，第 1 轮 P2-01）。
 * 离职钩子只在离职落地那一刻结束兼职、不补发（status-hooks.ts），所以**所有**写兼职区间的人工入口（直接新增、申请创建 /
 * 修改 / 提交 / 审批编辑 / 落地、编辑结束日、延长）都过这一个函数；系统入口（结束 / 批量结束 / 调动 / 离职）只缩短区间，不调用。
 * SQL 只取三项事实（时间轴 / 业务头表，主职口径），判定在 domain 的 partTimeBoundaryViolation（B-1～B-4）。
 * 必须在员工行锁内调用：离职落地与兼职写入都先持员工行锁，串行（先写兼职后落地 → 钩子截断；先落地后写兼职 → B-2 拒绝）。
 */
import { sql, type Tx } from '@italent/db';
import {
  PART_TIME_ERRORS,
  PART_TIME_TERMINATION_KINDS,
  partTimeBoundaryViolation,
  type PartTimeBoundaryReason,
} from '@italent/domain';
import { AppError } from '../../../errors.js';
import { rowsOf } from '../record-store.js';
import { plannedEffectiveDate } from '../timeline.js';
import type { EmploymentContext } from '../types.js';

export interface PartTimeCycle {
  readonly staffId: string;
  readonly entryDate: string;
  readonly employType: string;
}

export interface PartTimeBoundaryInput {
  readonly employeeId: string;
  readonly startDate: string;
  readonly endDate: string | null;
  /** 已有兼职记录时为记录所属周期：开始日主职须仍在该周期（编辑 / 延长）。新建时省略。 */
  readonly recordStaffId?: string;
  /** 编辑兼职只提前结束日时为 true：跳过 B-3，其余规则照常（DEC-624，§4.3A 调用点）。由 isPartTimeEndShortened 判定。 */
  readonly shortenOnly?: boolean;
}

export interface PartTimeBoundaryResult {
  /** 开始日主职所在周期（新建兼职的所属周期）。 */
  readonly cycle: PartTimeCycle;
  /** B-4：只提示不拦。 */
  readonly warnings: readonly string[];
}

const TERMINATIONS = sql.join(
  PART_TIME_TERMINATION_KINDS.map((kind) => sql`${kind}`),
  sql`, `,
);

interface PrimaryFact {
  readonly staffId: string;
  readonly kind: string;
  readonly employeeStatus: number;
  readonly entryDate: string;
  readonly employType: string;
}

/** F1：开始日时间轴上的当前主职记录；人员状态取最新快照（转正等状态传播以快照为准）。 */
async function primaryAt(tx: Tx, ctx: EmploymentContext, employeeId: string, startDate: string) {
  const [row] = rowsOf<PrimaryFact>(
    await tx.execute(sql`
      SELECT r.staff_id AS "staffId", r.kind,
        COALESCE(latest.employee_status, r.employee_status)::int AS "employeeStatus",
        c.entry_date::text AS "entryDate", c.employ_type AS "employType"
      FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      JOIN employment_cycles c ON c.tenant_id=r.tenant_id AND c.employee_id=r.employee_id AND c.id=r.staff_id
      LEFT JOIN LATERAL (
        SELECT p.employee_status FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1
      ) latest ON true
      WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND t.valid_during @> ${startDate}::date
      LIMIT 1
    `),
  );
  return row ?? null;
}

/** F2：该周期已生效（时间轴上未删除）的离职 / 退休中最早一条的实际生效日 E（迟到顺延后即 E′）。 */
async function exitEffectiveDate(tx: Tx, ctx: EmploymentContext, employeeId: string, staffId: string) {
  const [row] = rowsOf<{ date: string | null }>(
    await tx.execute(sql`
      SELECT min(r.start_date)::text AS date FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND r.staff_id=${staffId}::uuid
        AND r.kind IN (${TERMINATIONS})
    `),
  );
  return row?.date ?? null;
}

/** F3：该周期审批中 / 已批准未落地的离职 / 退休中最早的计划生效日（R2-T03 §5.0A 计划日唯一来源）。 */
async function pendingExitPlannedDate(tx: Tx, ctx: EmploymentContext, employeeId: string, staffId: string) {
  const [row] = rowsOf<{ date: string | null }>(
    await tx.execute(sql`
      SELECT min(${plannedEffectiveDate(ctx.tenantId, sql`b.id`, sql`p.effective_date`)})::text AS date
      FROM employment_business_objects b
      JOIN LATERAL (SELECT kind, selected_staff_id, effective_date FROM employment_payload_versions
        WHERE tenant_id=b.tenant_id AND employee_id=b.employee_id AND business_id=b.id
        ORDER BY version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events
        WHERE tenant_id=b.tenant_id AND employee_id=b.employee_id AND business_id=b.id
        ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
        AND p.kind IN (${TERMINATIONS}) AND p.selected_staff_id=${staffId}::uuid AND s.state IN ('in_review','approved')
    `),
  );
  return row?.date ?? null;
}

async function hasCycleOnOrBefore(tx: Tx, ctx: EmploymentContext, employeeId: string, startDate: string) {
  const [row] = rowsOf<{ found: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM employment_cycles
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid
        AND entry_date <= ${startDate}::date) AS found`),
  );
  return row!.found;
}

const MESSAGES: Record<PartTimeBoundaryReason, (lastWorkDate?: string) => string> = {
  [PART_TIME_ERRORS.primaryNotActive]: () => '开始日期时员工主职不在职，不能新增兼职',
  [PART_TIME_ERRORS.beyondExit]: (day) => `兼职结束日期不能晚于主职最后工作日（${day}）`,
  [PART_TIME_ERRORS.afterExit]: (day) => `兼职开始日期不能晚于主职最后工作日（${day}）`,
};

export async function assertPartTimeWithinCycle(
  tx: Tx,
  ctx: EmploymentContext,
  input: PartTimeBoundaryInput,
): Promise<PartTimeBoundaryResult> {
  const { employeeId, startDate } = input;
  const primary = await primaryAt(tx, ctx, employeeId, startDate);
  // 开始日没有主职记录且之前没有任何任职周期 = 早于入职（D-9，数据库 start_date >= entry_date 兜底）
  if (!primary && !(await hasCycleOnOrBefore(tx, ctx, employeeId, startDate)))
    throw new AppError('VALIDATION_FAILED', `兼职开始日期（${startDate}）不能早于员工入职日期`, {
      reason: PART_TIME_ERRORS.beforeEntry,
    });
  const facts = primary
    ? {
        exit: await exitEffectiveDate(tx, ctx, employeeId, primary.staffId),
        pending: await pendingExitPlannedDate(tx, ctx, employeeId, primary.staffId),
      }
    : { exit: null, pending: null };
  const outcome = partTimeBoundaryViolation({
    startDate,
    endDate: input.endDate,
    primary: primary && { staffId: primary.staffId, kind: primary.kind, employeeStatus: primary.employeeStatus },
    recordStaffId: input.recordStaffId ?? null,
    exitEffectiveDate: facts.exit,
    pendingExitPlannedDate: facts.pending,
    shortenOnly: input.shortenOnly === true,
  });
  const { violation } = outcome;
  if (violation || !primary)
    throw new AppError(
      'CONFLICT',
      MESSAGES[violation?.reason ?? PART_TIME_ERRORS.primaryNotActive](violation?.lastWorkDate),
      {
        reason: violation?.reason ?? PART_TIME_ERRORS.primaryNotActive,
        ...(violation?.lastWorkDate ? { lastWorkDate: violation.lastWorkDate } : {}),
      },
    );
  return {
    cycle: { staffId: primary.staffId, entryDate: primary.entryDate, employType: primary.employType },
    warnings: outcome.warnings,
  };
}
