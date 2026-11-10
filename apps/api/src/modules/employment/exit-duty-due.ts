/**
 * 离职 / 退休“指定日期”职责转交的到期执行（R2-T09b DT-R3，规格 30）：挂在任职生效定时任务里，紧跟菜单到期转交
 * （duty-transfer/scheduler.ts）。到期 = 转交时机为指定日期、日期 ≤ 租户本地今天、离职单已通过 / 已保存但未落地（approved）、
 * 还没有转交执行行（联动执行行保证至多一次，重跑幂等）、且表单带了转交计划。
 * 一人一个事务，与离职 / 调动同一参与人锁（被占用的本轮跳过 skipLocked，下轮再办）；复用离职转交的同一执行函数
 * （executeExitDutyTransfer → applyDutyTransfer → executeDutyItem，DEC-431① 单一入口），转交生效日 = 指定日期（DT-R7）。
 * 单个子项失败只记 duty_failed，不影响其余；非业务异常整人回滚、记入本轮 errors，下轮重试。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { runErrorCode, type DutyTransferRun } from '../duty-transfer/scheduler.js';
import { executeExitDutyTransfer } from './exit-duty-transfer.js';
import { rowsOf } from './record-store.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';

/** 每租户每轮最多办理的离职单数（有界查询）；未办完的下一轮继续。 */
const EXITS_PER_RUN = 100;

interface DueExit {
  readonly businessId: string;
  readonly employeeId: string;
  readonly date: string;
}

const dueCondition = (tenantId: string, today: string) => sql`
  e.tenant_id=${tenantId} AND e.duty_transfer_timing='specified_date' AND e.duty_transfer_date<=${today}::date
  AND (SELECT s.state FROM employment_state_events s WHERE s.tenant_id=e.tenant_id AND s.business_id=e.business_id
    ORDER BY s.event_no DESC LIMIT 1) = 'approved'
  AND EXISTS (SELECT 1 FROM transfer_linkage_versions v WHERE v.tenant_id=e.tenant_id AND v.business_id=e.business_id)
  AND NOT EXISTS (SELECT 1 FROM transfer_linkage_runs r WHERE r.tenant_id=e.tenant_id AND r.business_id=e.business_id)`;

export async function runDueExitDutyTransfers(
  db: Db,
  tenant: { readonly id: string; readonly timezone: string },
  now: Date,
  commandId: string,
): Promise<DutyTransferRun> {
  const today = tenantLocalDate(now, tenant.timezone);
  const ctx: EmploymentContext = {
    tenantId: tenant.id,
    userId: SYSTEM_USER_ID,
    timezone: tenant.timezone,
    now,
    commandId,
    expectedRevision: 0,
  };
  const due = await withTenant(db, tenant.id, async (tx) =>
    rowsOf<DueExit>(
      await tx.execute(sql`SELECT e.business_id::text AS "businessId", e.employee_id::text AS "employeeId",
          e.duty_transfer_date::text AS date
        FROM exit_requests e WHERE ${dueCondition(tenant.id, today)}
        ORDER BY e.duty_transfer_date, e.business_id LIMIT ${EXITS_PER_RUN}`),
    ),
  );
  const run = { completed: 0, failed: 0, skippedLocked: 0, errors: [] as DutyTransferRun['errors'][number][] };
  for (const exit of due) {
    try {
      const outcome = await withTenant(db, tenant.id, (tx) => runOne(tx, ctx, exit, today));
      if (outcome === 'busy') run.skippedLocked += 1;
      else {
        run.completed += outcome.completed;
        run.failed += outcome.failed;
      }
    } catch (error) {
      run.errors.push({ employeeId: exit.employeeId, code: runErrorCode(error) });
    }
  }
  return run;
}

async function runOne(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  ctx: EmploymentContext,
  exit: DueExit,
  today: string,
) {
  const lock = await lockTransferParticipants(tx, ctx, exit.employeeId, [], { skipLocked: true });
  if (lock !== 'acquired') return 'busy' as const;
  // 锁后重读：等锁期间可能已被确认 / 落地 / 撤销 / 改期，不再满足到期条件就当没有
  const [still] = rowsOf<{ date: string }>(
    await tx.execute(sql`SELECT e.duty_transfer_date::text AS date FROM exit_requests e
      WHERE e.business_id=${exit.businessId}::uuid AND ${dueCondition(ctx.tenantId, today)}`),
  );
  if (!still) return { completed: 0, failed: 0 };
  const items = await executeExitDutyTransfer(
    tx,
    ctx,
    { businessId: exit.businessId, employeeId: exit.employeeId, dutyTransferTiming: 'specified_date' },
    'confirmed',
    still.date,
  );
  const completed = items.filter((item) => item.status === 'succeeded').length;
  return { completed, failed: items.length - completed };
}
