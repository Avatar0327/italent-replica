/**
 * 实习转正的资格检查（R2 BE-6a；31 IN-R4；PR #386 第 1 轮 P2-1、F-215）：任职写入路径的单一入口。
 * 专用直接转正接口与通用 POST /employees/:id/businesses 同走 createEmploymentBusiness；资格检查挂在业务顺序校验里，
 * 新增、申请改期、落地（含审批通过后到期生效）都经过，不各写一份。
 */
import { sql, type Tx } from '@italent/db';
import { addDays, EMPLOYEE_STATUS } from '@italent/domain';
import { AppError } from '../../errors.js';
import { findPredecessor } from './read-model.js';
import { voidSupersededRegularizations } from './exit-void-applications.js';
import { rowsOf, type EmploymentEmployeeRow } from './record-store.js';
import type { BusinessKind, EmploymentContext } from './types.js';

/**
 * 只有在职实习生可转正（业务顺序校验 assertBusinessSequence 之后调用）：
 * - 转正日及以后不能已有结束实习身份的记录（assertNothingEndsInternshipAfter），不只看插入点前驱；
 * - 转正日当天及以前最后一条任职须为实习生、且不是待入职（实习生在职为正式，没有试用态）。
 */
export async function assertInternRegularizationEligible(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: { readonly kind: BusinessKind; readonly effectiveDate: string },
): Promise<void> {
  if (input.kind !== 'intern_regularization') return;
  await assertNothingEndsInternshipAfter(tx, ctx, employeeId, input.effectiveDate);
  const previous = await findPredecessor(tx, ctx.tenantId, employeeId, input.effectiveDate);
  // 没有任职或已离职 / 退休：交给业务顺序校验，保持统一的拒绝码
  if (!previous || ['leave', 'retirement'].includes(previous.kind)) return;
  if (previous.fields.employType !== 'intern' || previous.employeeStatus === EMPLOYEE_STATUS.pendingEntry)
    throw new AppError('CONFLICT', '只有在职实习生可以实习转正', { reason: 'NOT_INTERN' });
}

/**
 * 新增实习转正时已有审批中 / 审批通过未生效的实习转正申请（DEC-593③③）：
 * - 直接转正（免审批）：自动作废在途申请，与离职生效步骤 1 复用同一作废实现（exit-void-applications.ts，DEC-431①）；
 * - 申请方式（mode = application）：仍拒绝 409，避免同一人两条转正在途。
 * 调用方已持员工行锁；作废放在取组织 / 编制锁之前（§5.2 锁序）。
 */
export async function resolveInFlightRegularization(
  tx: Tx,
  ctx: EmploymentContext,
  employee: EmploymentEmployeeRow,
  input: { readonly kind: BusinessKind; readonly mode: 'application' | 'direct' },
): Promise<void> {
  if (input.kind !== 'intern_regularization') return;
  if (input.mode === 'direct') {
    await voidSupersededRegularizations(tx, ctx, employee);
    return;
  }
  const [pending] = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT b.id FROM employment_business_objects b
      JOIN LATERAL (SELECT kind, mode FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employee.id}::uuid
        AND p.kind='intern_regularization' AND p.mode='application' AND s.state IN ('in_review','approved')
      LIMIT 1`),
  );
  if (pending)
    throw new AppError('CONFLICT', '当前存在审批中的实习转正申请，无法再次实习转正', {
      reason: 'INTERN_REGULARIZATION_IN_PROGRESS',
    });
}

/**
 * 结束实习的资格（BE-6b，31 IN-R7）：最后工作日（结束日）当天在岗且是实习生，且结束日次日起没有结束实习身份或实习转正的记录。
 * 结束日期早于入职日期由离职门禁统一判（assertLastWorkDateNotBeforeEntry）。保存与生效两处共用：
 * 保存到生效之间若转正申请已落地，人已不是实习生，生效失败交 HR（exit-activation.ts，仅免审批直接生效）。
 */
export async function assertInternEndable(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
): Promise<void> {
  await assertNothingEndsInternshipAfter(tx, ctx, employeeId, addDays(lastWorkDate, 1));
  const previous = await findPredecessor(tx, ctx.tenantId, employeeId, lastWorkDate);
  if (!previous || ['leave', 'retirement'].includes(previous.kind))
    throw new AppError('CONFLICT', '已结束实习的人员不能再结束实习', { reason: 'ACTIVE_EMPLOYMENT_REQUIRED' });
  if (previous.fields.employType !== 'intern' || previous.employeeStatus === EMPLOYEE_STATUS.pendingEntry)
    throw new AppError('CONFLICT', '只有在职实习生可以结束实习', { reason: 'NOT_INTERN' });
}

/**
 * 插入点之后的时间轴：插入点前驱仍是实习生，不代表此人现在还是实习生。
 * 转正日及以后已有离职 / 退休（结束实习只能重聘，含当前已离职时回填离职前日期）→ ACTIVE_EMPLOYMENT_REQUIRED，
 * 与业务顺序校验同码；已有实习转正（回填到已转正之前）→ NOT_INTERN。
 */
async function assertNothingEndsInternshipAfter(tx: Tx, ctx: EmploymentContext, employeeId: string, date: string) {
  const [later] = rowsOf<{ kind: string }>(
    await tx.execute(sql`
      SELECT r.kind FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND t.start_date>=${date}::date
        AND r.kind IN ('leave','retirement','intern_regularization')
      ORDER BY (r.kind='intern_regularization'), t.start_date, t.sort_order LIMIT 1`),
  );
  if (later?.kind === 'intern_regularization')
    throw new AppError('CONFLICT', '只有在职实习生可以实习转正', { reason: 'NOT_INTERN' });
  if (later)
    throw new AppError('CONFLICT', '已结束实习的人员不能实习转正，请走重聘入职', {
      reason: 'ACTIVE_EMPLOYMENT_REQUIRED',
    });
}
