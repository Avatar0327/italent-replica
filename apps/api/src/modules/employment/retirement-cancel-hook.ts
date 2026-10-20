/**
 * 撤销退休的人事回写（R2-T04 设计 §6 接线点 5，AC-RT-10b）：订阅撤销端口 onCancelled，只处理退休。
 * 已生效退休（record_deleted / record_deleted_reinstated）被撤销时，把人事“实际退休日期”恢复为该退休生效前的人事版本值，
 * 经 appendEmployee 追加人事版本，与撤销同事务（AGENTS §10）；approved_voided / process_voided 没有写过实际退休日期，不动人事。
 * 恢复依据只取业务事件与人事版本链，不读审计：审计会按保留期整条清理（audit/retention.ts），不能当业务事实的来源（第 1 轮审查 P2-1）。
 *   - 业务侧：退休的 effective 状态事件记着生效命令 ID；
 *   - 人事侧：同一命令下第一个改变实际退休日期的人事版本，就是生效时的回写（syncActualRetirementDate），
 *     它的前一版本的值就是“生效前的值”，该版本自己的值就是本退休写入的值。
 * 保护：人事当前值已不是本退休写入的值（之后另有退休改写过）则不覆盖；找不到回写版本、而当前值恰是本退休的生效日时
 * 说明来源无法确定，409 拒绝并回滚整个撤销，不静默成功。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { appendEmployee, employeeSnapshot } from '../personnel/employee-write.js';
import { auditEmployment } from './context.js';
import { exitPostEffectHooks, type ExitCancelledEvent } from './exit-confirmation.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

/** 生效命令下对实际退休日期的那次人事写入：写入的值与它前一版本的值（无前一版本为空）。 */
async function syncedWrite(tx: Tx, ctx: EmploymentContext, event: ExitCancelledEvent) {
  const [effective] = rowsOf<{ commandId: string }>(
    await tx.execute(sql`SELECT command_id AS "commandId" FROM employment_state_events WHERE tenant_id=${ctx.tenantId}
      AND business_id=${event.businessId}::uuid AND state='effective' ORDER BY event_no DESC LIMIT 1`),
  );
  if (!effective) return undefined;
  const [write] = rowsOf<{ written: string | null; restored: string | null }>(
    await tx.execute(sql`SELECT v.actual_retirement_date::text AS written, p.actual_retirement_date::text AS restored
      FROM personnel_employee_versions v
      LEFT JOIN personnel_employee_versions p ON p.tenant_id=v.tenant_id AND p.employee_id=v.employee_id
        AND p.revision=v.revision-1
      WHERE v.tenant_id=${ctx.tenantId} AND v.employee_id=${event.employeeId}::uuid
        AND v.command_id=${effective.commandId}
        AND v.actual_retirement_date IS DISTINCT FROM p.actual_retirement_date
      ORDER BY v.revision LIMIT 1`),
  );
  return write;
}

/** 退休的最终生效日 E′（最新载荷版本；顺延会追加版本）。 */
async function effectiveDateOf(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const [row] = rowsOf<{ effectiveDate: string }>(
    await tx.execute(sql`SELECT effective_date::text AS "effectiveDate" FROM employment_payload_versions
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  return row?.effectiveDate;
}

export async function restoreActualRetirementDate(tx: Tx, ctx: EmploymentContext, event: ExitCancelledEvent) {
  if (event.kind !== 'retirement') return;
  if (event.case !== 'record_deleted' && event.case !== 'record_deleted_reinstated') return;
  const current = ((await employeeSnapshot(tx, ctx, event.employeeId))?.actualRetirementDate as string | null) ?? null;
  const synced = await syncedWrite(tx, ctx, event);
  if (!synced) {
    if (current !== null && current === (await effectiveDateOf(tx, ctx, event.businessId)))
      throw new AppError('CONFLICT', '无法确定实际退休日期生效前的值，请联系管理员处理', {
        reason: 'RETIREMENT_ACTUAL_DATE_SOURCE_UNKNOWN',
      });
    return;
  }
  if (current !== synced.written) return;
  await appendEmployee(tx, ctx, event.employeeId, { actualRetirementDate: synced.restored }, false);
  await auditEmployment(
    tx,
    ctx,
    'retirement.actual_date.restored',
    'exit-request',
    event.businessId,
    { actualRetirementDate: current },
    { actualRetirementDate: synced.restored },
    undefined,
    undefined,
    { employeeId: event.employeeId },
  );
}

exitPostEffectHooks.onCancelled(restoreActualRetirementDate);
