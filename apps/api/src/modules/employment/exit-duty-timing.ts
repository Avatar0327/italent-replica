/**
 * 离职 / 退休单的职责转交时机选择（R2-T09b DT-R3，规格 30 “业务内指定日期”）。
 * 时机三选一：审批通过 / 业务生效 / 指定日期；指定日期必须带日期，其余不得带；
 * 指定日期晚于业务生效日的，改为“业务生效”（生效时转交）并清掉日期；一旦已有转交执行行就不能再改（DT-R3）。
 */
import { type DutyTransferTimingChoice, settleDutyTransferTiming } from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export interface TimingRequest {
  readonly dutyTransferTiming?: DutyTransferTimingChoice['timing'];
  readonly dutyTransferDate?: string;
}

const invalid = (message: string) =>
  new AppError('VALIDATION_FAILED', message, { reason: 'EXIT_DUTY_TRANSFER_TIMING_INVALID' });

/** 请求里出现任一键时，按当前值合并出新的选择；两键都没出现返回 null（不改）。 */
export function chooseDutyTransferTiming(
  request: TimingRequest,
  current: DutyTransferTimingChoice,
): DutyTransferTimingChoice | null {
  const { dutyTransferTiming: asked, dutyTransferDate: date } = request;
  if (asked === undefined && date === undefined) return null;
  const timing = asked ?? current.timing;
  if (timing !== 'specified_date') {
    if (date !== undefined) throw invalid('只有转交时机为“指定日期”时才能填写转交日期');
    return { timing, date: null };
  }
  const resolved = date ?? current.date;
  if (resolved === null) throw invalid('转交时机为“指定日期”时必须填写转交日期');
  return { timing, date: resolved };
}

/** 选择 + 业务生效日 → 落库值（晚于生效日的改为业务生效）。 */
export const settleChoice = settleDutyTransferTiming;

/** 该业务是否已经执行过职责转交（有联动执行行）：执行后时机不可再改。 */
export async function dutyTransferExecuted(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<boolean> {
  const [row] = rowsOf<{ found: number }>(
    await tx.execute(sql`SELECT 1 AS found FROM transfer_linkage_runs WHERE tenant_id=${ctx.tenantId}
      AND business_id=${businessId}::uuid LIMIT 1`),
  );
  return row !== undefined;
}

export function lockedError(): AppError {
  return new AppError('CONFLICT', '职责已转交，不能再修改转交时机', { reason: 'EXIT_DUTY_TRANSFER_LOCKED' });
}

/**
 * 改期时的时机结算（P2-3）：所有改期入口（专用 PATCH /exits、通用 PATCH /businesses、审批中心编辑）都经 rescheduleExit
 * 到这里。指定日期晚于新生效日的，改为“生效时转交”并清掉日期；已执行过转交的不动（执行后时机不可再改）。
 */
export async function settleTimingOnReschedule(
  tx: Tx,
  ctx: EmploymentContext,
  business: { readonly id: string; readonly employeeId: string },
  effectiveDate: string,
): Promise<void> {
  const [row] = rowsOf<{ timing: string; date: string | null }>(
    await tx.execute(sql`SELECT duty_transfer_timing AS timing, duty_transfer_date::text AS date FROM exit_requests
      WHERE tenant_id=${ctx.tenantId} AND business_id=${business.id}::uuid FOR UPDATE`),
  );
  if (!row || row.timing !== 'specified_date') return;
  const next = settleChoice({ timing: 'specified_date', date: row.date }, effectiveDate);
  if (next.timing === row.timing && next.date === row.date) return;
  if (await dutyTransferExecuted(tx, ctx, business.id)) return;
  await tx.execute(sql`UPDATE exit_requests SET duty_transfer_timing=${next.timing}, duty_transfer_date=${next.date}
    WHERE tenant_id=${ctx.tenantId} AND business_id=${business.id}::uuid`);
  await auditEmployment(
    tx,
    ctx,
    'exit.request.update',
    'exit-request',
    business.id,
    { dutyTransferTiming: row.timing, dutyTransferDate: row.date },
    { dutyTransferTiming: next.timing, dutyTransferDate: next.date },
    undefined,
    undefined,
    { employeeId: business.employeeId },
  );
}
