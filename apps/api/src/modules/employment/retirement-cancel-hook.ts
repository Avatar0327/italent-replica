/**
 * 撤销退休的人事回写（R2-T04 设计 §6 接线点 5，AC-RT-10b）：订阅撤销端口 onCancelled，只处理退休。
 * 已生效退休（record_deleted / record_deleted_reinstated）被撤销时，把人事“实际退休日期”恢复为该退休生效前的人事版本值
 * （生效时 syncActualRetirementDate 在 retirement.actual_date.synced 审计里记下的“变更前”），经 appendEmployee 追加人事版本，
 * 与撤销同事务（AGENTS §10）；approved_voided / process_voided 没有写过实际退休日期，不动人事。
 * 若人事当前的实际退休日期已不是本退休写入的值（之后另有退休改写过），不覆盖。
 */
import { sql, type Tx } from '@italent/db';
import { appendEmployee, employeeSnapshot } from '../personnel/employee-write.js';
import { auditEmployment } from './context.js';
import { exitPostEffectHooks, type ExitCancelledEvent } from './exit-confirmation.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

type ActualDateAudit = {
  before: { actualRetirementDate?: string | null };
  after: { actualRetirementDate?: string | null };
};

/** 本退休生效时写下的实际退休日期审计（同一退休至多一条；没有说明没有写过）。 */
async function syncedAudit(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const [row] = rowsOf<ActualDateAudit>(
    await tx.execute(sql`SELECT before, after FROM audit_events WHERE tenant_id=${ctx.tenantId}
      AND object_id=${businessId} AND action='retirement.actual_date.synced'
      ORDER BY occurred_at DESC, id DESC LIMIT 1`),
  );
  return row;
}

export async function restoreActualRetirementDate(tx: Tx, ctx: EmploymentContext, event: ExitCancelledEvent) {
  if (event.kind !== 'retirement') return;
  if (event.case !== 'record_deleted' && event.case !== 'record_deleted_reinstated') return;
  const synced = await syncedAudit(tx, ctx, event.businessId);
  if (!synced) return;
  const written = synced.after.actualRetirementDate ?? null;
  const restored = synced.before.actualRetirementDate ?? null;
  const current = ((await employeeSnapshot(tx, ctx, event.employeeId))?.actualRetirementDate as string | null) ?? null;
  if (current !== written) return;
  await appendEmployee(tx, ctx, event.employeeId, { actualRetirementDate: restored }, false);
  await auditEmployment(
    tx,
    ctx,
    'retirement.actual_date.restored',
    'exit-request',
    event.businessId,
    { actualRetirementDate: current },
    { actualRetirementDate: restored },
    undefined,
    undefined,
    { employeeId: event.employeeId },
  );
}

exitPostEffectHooks.onCancelled(restoreActualRetirementDate);
