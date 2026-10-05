import { sql, withPlatform, withTenant, type Db } from '@italent/db';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { recomputeOrderCodes } from './order-code.js';
import { rows } from './store.js';

// DEC-170：只做周期批量 + 手动触发，不把组合名次刷新挂到业务写事务。
export const DEFAULT_ORDER_CODE_INTERVAL_MS = 3 * 60 * 60_000;
function interval(value = DEFAULT_ORDER_CODE_INTERVAL_MS) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 2_147_483_647)
    throw new RangeError('人员排序重算间隔须为 1000～2147483647 毫秒');
  return value;
}
/** 平台仅分页读取启用租户目录；重算、幂等台账和失败记录始终走租户 RLS。 */
export async function runOrderCodeJobs(
  db: Db,
  options: { clock?: () => Date; intervalMs?: number; onError?: (error: unknown) => void } = {},
) {
  const period = interval(options.intervalMs);
  const now = (options.clock ?? (() => new Date()))();
  const commandId = `person-order:${period}:${Math.floor(now.getTime() / period)}`;
  let cursor: string | null = null;
  const failures: { tenantId: string; state: string; error: string }[] = [];
  let succeeded = 0;
  for (;;) {
    const tenants: { id: string; timezone: string }[] = await withPlatform(db, async (tx) =>
      rows(
        await tx.execute(sql`SELECT id,timezone FROM tenants WHERE status='active'
        AND (${cursor}::uuid IS NULL OR id>${cursor}::uuid) ORDER BY id LIMIT 100`),
      ),
    );
    for (const tenant of tenants) {
      const ctx = {
        tenantId: tenant.id,
        timezone: tenant.timezone,
        userId: SYSTEM_USER_ID,
        now,
        commandId,
        expectedRevision: 0,
      };
      try {
        await runCommand(db, ctx, {
          id: commandId,
          fingerprint: { operation: 'personnel.order.scheduled' },
          execute: async (tx) => ({ status: 200, body: await recomputeOrderCodes(tx, ctx, false) }),
        });
        succeeded += 1;
      } catch (error) {
        // runCommand 已先回查成功台账；存储错误只能记 unknown，不能伪造业务失败。
        const state = error instanceof AppError ? 'failed' : 'unknown';
        const code = error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE';
        try {
          await withTenant(db, tenant.id, async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
            await tx.execute(sql`INSERT INTO personnel_order_runs(tenant_id,command_id,state,attempts,error,ran_at)
              VALUES (${tenant.id},${commandId},${state},1,${code},${now.toISOString()}::timestamptz)
              ON CONFLICT (tenant_id,command_id) DO UPDATE SET attempts=personnel_order_runs.attempts+1,
                state=EXCLUDED.state,error=EXCLUDED.error,ran_at=EXCLUDED.ran_at
              WHERE personnel_order_runs.state<>'succeeded'`);
          });
        } catch {
          // 回执也不可写时不伪造持久状态，不中断其余租户，交给进程告警。
          (options.onError ?? console.error)(
            new AppError('SERVICE_UNAVAILABLE', '人员排序失败回执无法保存', {
              tenantId: tenant.id,
              commandId,
            }),
          );
        }
        failures.push({ tenantId: tenant.id, state, error: code });
      }
    }
    if (tenants.length < 100) break;
    cursor = tenants.at(-1)!.id;
  }
  return { succeeded, failures };
}
export function startOrderCodeScheduler(
  db: Db,
  options: { intervalMs?: number; clock?: () => Date; onError?: (error: unknown) => void } = {},
) {
  const period = interval(options.intervalMs);
  const onError = options.onError ?? ((error: unknown) => console.error('人员排序重算失败', error));
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = runOrderCodeJobs(db, { ...options, intervalMs: period, onError })
      .then((result) => {
        if (result.failures.length) onError(new Error(`人员排序重算失败：${JSON.stringify(result.failures)}`));
      })
      .catch(onError)
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, period);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
