/**
 * 离职生效对 O / P 投影的校验（R2-T03 设计 §6B.2 / §5.1 步骤 0c、3）：SQL 只取时间轴区间，是否新增占用由 domain 纯函数
 * exitOccupancy / newlyOccupied 判定，与组织停用计数、编制投影读同一实现。系统执行入口（调度、重试、审批落地）不弹确认：
 * 迟到顺延延长的在职段（ΔO）撞上部门停用即生效失败，ΔP 只会出现空集，非空是实现错误（503，不静默放行）。
 */
import { exitOccupancy, newlyOccupied, type ExitState, type TimelineSegment } from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { assertEmploymentDepartmentAvailableWithin } from './references.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

/** 员工当前时间轴上的主职区间（空区间与无部门的记录不占用）；部门 / 职位取最新记录快照（向后更新后的值）。 */
export async function loadTimelineSegments(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
): Promise<TimelineSegment[]> {
  return rowsOf<TimelineSegment>(
    await tx.execute(sql`
    SELECT r.id AS "recordId", r.employee_id AS "employeeId", t.staff_id AS "staffId", r.kind,
      COALESCE(snap.department_id, r.department_id) AS "departmentId",
      COALESCE(snap.position_id, r.position_id) AS "positionId", NULL::text AS "capacityId",
      t.start_date::text AS "from", upper(t.valid_during)::text AS "to"
    FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT p.department_id, p.position_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND NOT isempty(t.valid_during)
      AND COALESCE(snap.department_id, r.department_id) IS NOT NULL
    ORDER BY t.start_date, t.sort_order`),
  );
}

/** 离职在某一阶段的投影输入；R（预减时点）缺失视为尚未进入 confirmed，调用方先判。 */
async function exitState(
  tx: Tx,
  ctx: EmploymentContext,
  exit: { businessId: string; employeeId: string; staffId: string; releaseDate: string },
  state: 'approved' | 'effective',
  effectiveDate: string,
): Promise<ExitState> {
  const [next] = rowsOf<{ entryDate: string | null }>(
    await tx.execute(sql`SELECT min(entry_date)::text AS "entryDate" FROM employment_cycles
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${exit.employeeId}::uuid
        AND entry_date > ${exit.releaseDate}::date`),
  );
  return { ...exit, state, effectiveDate, nextCycleEntryDate: next?.entryDate ?? null };
}

const clipAt = (segments: readonly TimelineSegment[], staffId: string, date: string) =>
  segments
    .filter((segment) => segment.staffId !== staffId || segment.from < date)
    .map((segment) =>
      segment.staffId === staffId && (segment.to === null || segment.to > date) ? { ...segment, to: date } : segment,
    );

interface ExitRef {
  readonly businessId: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly releaseDate: string | null;
}

/**
 * 步骤 0c（§6B.3 表 #3）：简单顺延把同周期在职段从 [.., E) 延到 [.., E′)，ΔO = O₁ ∖ O₀ 的每一段按有终点变体校验部门可用性；
 * 任一天不可用 → 生效失败 EMPLOYMENT_DEPARTMENT_DISABLED（HR 推迟 / 取消组织停用或撤销离职后重试）。
 */
export async function assertExtendedEmploymentAvailable(
  tx: Tx,
  ctx: EmploymentContext,
  exit: ExitRef,
  segments: readonly TimelineSegment[],
  planned: string,
  postponedTo: string,
): Promise<void> {
  // O 只用 E（approved 从 E 起不计）；R 仅 P 用，缺失时取 E 占位以满足输入校验
  const ref = { ...exit, releaseDate: exit.releaseDate ?? planned };
  const before = exitOccupancy({
    records: segments,
    applications: [],
    exits: [await exitState(tx, ctx, ref, 'approved', planned)],
    detachedTransfers: [],
    timings: { transferIn: 'submitted', transferOut: 'submitted' },
  }).o;
  const after = exitOccupancy({
    records: clipAt(segments, exit.staffId, postponedTo),
    applications: [],
    exits: [await exitState(tx, ctx, ref, 'effective', postponedTo)],
    detachedTransfers: [],
    timings: { transferIn: 'submitted', transferOut: 'submitted' },
  }).o;
  for (const segment of newlyOccupied(before, after)) {
    try {
      await assertEmploymentDepartmentAvailableWithin(tx, ctx, segment.departmentId, segment.from, segment.to);
    } catch (error) {
      const reason = (error as { details?: { reason?: string; disabledOn?: string } }).details;
      if (error instanceof AppError && reason?.reason === 'EMPLOYMENT_DEPARTMENT_DISABLED')
        throw new AppError('CONFLICT', error.message, {
          activationFailure: {
            reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
            detail: {
              departmentId: segment.departmentId,
              from: segment.from,
              to: segment.to,
              disabledOn: reason.disabledOn,
            },
          },
        });
      throw error;
    }
  }
}

/**
 * 步骤 3（R-P6）：落地前后的 P 投影之差必须为空——R 不变，时间轴只被截断、被摘下，不新增任何占编。
 * `before` 是落地前读到的区间，`after` 是落地并摘下未来调动后重读的区间；没有 R（未进入 confirmed）时没有预减可校验。
 */
export async function assertNoNewEstablishmentOccupancy(
  tx: Tx,
  ctx: EmploymentContext,
  exit: ExitRef,
  before: readonly TimelineSegment[],
  after: readonly TimelineSegment[],
  planned: string,
  effectiveDate: string,
): Promise<void> {
  if (!exit.releaseDate) return;
  const ref = { ...exit, releaseDate: exit.releaseDate };
  const timings = { transferIn: 'submitted', transferOut: 'submitted' } as const;
  const p0 = exitOccupancy({
    records: before,
    applications: [],
    exits: [await exitState(tx, ctx, ref, 'approved', planned)],
    detachedTransfers: [],
    timings,
  }).p;
  const p1 = exitOccupancy({
    records: after,
    applications: [],
    exits: [await exitState(tx, ctx, ref, 'effective', effectiveDate)],
    detachedTransfers: [],
    timings,
  }).p;
  const added = newlyOccupied(p0, p1);
  if (added.length)
    throw new AppError('SERVICE_UNAVAILABLE', '离职生效不应新增编制占用', {
      reason: 'EXIT_OCCUPANCY_INVARIANT',
      segments: added.length,
    });
}
