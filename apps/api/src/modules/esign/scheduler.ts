/** F-481 §5.4：按任务快照过期 / 提醒；租户目录分页，单任务事务，失败下轮重试。 */
import { and, eq, esignTasks, sql, withPlatform, withTenant, type Db, type Tx } from '@italent/db';
import { ESIGN_NOTICE_BUSINESS_TYPE, ESIGN_REMIND_TEMPLATE } from '@italent/domain';
import { classifyCommandFailure } from '../../audit/failures.js';
import { runCommand } from '../../commands.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { notifyMessage } from '../approval/notifications.js';
import { auditEmployment } from '../employment/context.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { expireSignTask } from './expiry.js';
import { simulatedProvider } from './provider.js';
import type { SignTask } from './sign-events.js';
import { reminderPayload } from './notice-payload.js';
import { signTaskSourceAudit } from './task-source.js';

const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60_000;
type Tenant = { id: string; timezone: string };
type Kind = 'expired' | 'expiry_remind';
type Candidate = { id: string; recipient: string | null };
interface Options {
  readonly clock?: () => Date;
  readonly onError?: (error: unknown) => void;
}

function report(error: unknown, onError: Options['onError'], scope: object) {
  // 只输出分类码和内部标识，驱动异常可能带 SQL / 正文，不能直接交给日志。
  const failure = classifyCommandFailure(error, 'execute');
  (onError ?? console.error)(new Error(`电子签署调度失败：${JSON.stringify({ ...scope, ...failure })}`));
}

/** 沿用现有调度器：平台事务只枚举启用租户，业务读写及命令台账始终处于租户 RLS 下。 */
export async function runESignJobs(db: Db, options: Options = {}) {
  const now = (options.clock ?? (() => new Date()))();
  let tenantCursor: string | null = null;
  const counts = { expired: 0, reminded: 0, skipped: 0, failed: 0 };
  for (;;) {
    const tenants: Tenant[] = await withPlatform(db, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT id,timezone FROM tenants WHERE status='active'
        AND (${tenantCursor}::uuid IS NULL OR id>${tenantCursor}::uuid) ORDER BY id LIMIT ${PAGE_SIZE}`),
      ),
    );
    for (const tenant of tenants) {
      // 先过期再提醒，停机跨过整个提醒窗口时不补发；失败项继续保留为候选，下轮从头扫描。
      for (const kind of ['expired', 'expiry_remind'] as const) {
        let cursor: string | null = null;
        try {
          for (;;) {
            const candidates = await dueCandidates(db, tenant.id, kind, now, cursor);
            for (const candidate of candidates) {
              try {
                const result = await runCandidate(db, tenant, candidate, kind, now);
                counts[result] += 1;
              } catch (error) {
                // runCommand 已回查台账并记录分类失败审计；这里只报调度日志，不重复记失败。
                counts.failed += 1;
                report(error, options.onError, { tenantId: tenant.id, taskId: candidate.id, kind });
              }
            }
            if (candidates.length < PAGE_SIZE) break;
            cursor = candidates.at(-1)!.id;
          }
        } catch (error) {
          counts.failed += 1;
          report(error, options.onError, { tenantId: tenant.id, kind });
        }
      }
    }
    if (tenants.length < PAGE_SIZE) break;
    tenantCursor = tenants.at(-1)!.id;
  }
  return counts;
}

async function dueCandidates(db: Db, tenantId: string, kind: Kind, now: Date, cursor: string | null) {
  const due =
    kind === 'expired'
      ? sql`expires_at<=${now.toISOString()}::timestamptz`
      : sql`expires_at>${now.toISOString()}::timestamptz
        AND expires_at<=${new Date(now.getTime() + DAY_MS).toISOString()}::timestamptz
        AND remind_before_expiry AND current_node='employee' AND expiry_reminded_at IS NULL`;
  return withTenant(db, tenantId, async (tx) =>
    rowsOf<Candidate>(
      await tx.execute(sql`SELECT id,employee_signer_user_id AS recipient FROM esign_tasks
      WHERE tenant_id=${tenantId} AND status='signing' AND ${due}
        AND (${cursor}::uuid IS NULL OR id>${cursor}::uuid) ORDER BY id LIMIT ${PAGE_SIZE}`),
    ),
  );
}

async function runCandidate(db: Db, tenant: Tenant, candidate: Candidate, kind: Kind, now: Date) {
  // DEC-052：提醒按任务 + 动作 + 接收人去重；任务固定过期时刻，过期动作一生只执行一次。
  const commandId =
    kind === 'expired'
      ? `esign:expired:${candidate.id}`
      : `esign:${candidate.id}:expiry_remind:${candidate.recipient ?? 'none'}`;
  const ctx: EmploymentContext = {
    tenantId: tenant.id,
    timezone: tenant.timezone,
    userId: SYSTEM_USER_ID,
    commandId,
    now,
    expectedRevision: 0,
  };
  const response = await runCommand(db, ctx, {
    id: commandId,
    fingerprint: { taskId: candidate.id, kind, recipient: kind === 'expiry_remind' ? candidate.recipient : null },
    execute: async (tx) => {
      const [task] = await tx
        .select()
        .from(esignTasks)
        .where(and(eq(esignTasks.tenantId, tenant.id), eq(esignTasks.id, candidate.id)))
        .for('update');
      let outcome: 'expired' | 'reminded' | 'skipped' = 'skipped';
      if (task?.status === 'signing') {
        if (kind === 'expired') {
          const after = await expireSignTask(tx, ctx, task.id);
          if (after.status === 'expired') outcome = 'expired';
        } else if (
          task.remindBeforeExpiry &&
          task.currentNode === 'employee' &&
          !task.expiryRemindedAt &&
          task.employeeSignerUserId &&
          now.getTime() < task.expiresAt.getTime() &&
          now.getTime() >= task.expiresAt.getTime() - DAY_MS
        ) {
          await remind(tx, ctx, task);
          outcome = 'reminded';
        }
      }
      return { status: 200, body: { outcome } };
    },
  });
  return (response.body as { outcome: 'expired' | 'reminded' | 'skipped' }).outcome;
}

async function remind(tx: Tx, ctx: EmploymentContext, task: SignTask) {
  const recipientUserId = task.employeeSignerUserId!;
  await tx
    .update(esignTasks)
    .set({
      expiryRemindedAt: ctx.now,
      updatedAt: ctx.now,
      revision: task.revision + 1,
    })
    .where(and(eq(esignTasks.tenantId, ctx.tenantId), eq(esignTasks.id, task.id)));
  await auditEmployment(
    tx,
    ctx,
    'esign.task.reminded',
    'esign-task',
    task.id,
    { expiryRemindedAt: null },
    { ...signTaskSourceAudit(task), expiryRemindedAt: ctx.now.toISOString(), recipientUserId, method: 'expiry_remind' },
    undefined,
    undefined,
    { employeeId: task.employeeId, orgId: task.ownerDepartmentId },
  );
  await simulatedProvider.remind({
    tenantId: ctx.tenantId,
    taskId: task.id,
    providerRef: task.providerRef,
    node: 'employee',
  });
  await notifyMessage(
    tx,
    ctx,
    { businessType: ESIGN_NOTICE_BUSINESS_TYPE, businessId: task.id },
    {
      recipientUserId,
      templateCode: ESIGN_REMIND_TEMPLATE,
      payload: await reminderPayload(tx, ctx.tenantId, task, () => deadlineLabel(task.expiresAt, ctx.timezone)),
    },
  );
}

function deadlineLabel(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

/** 启动即执行；轮次不重叠；stop 取消后续轮次并等待在途事务完成。测试直接调用 runESignJobs 推进时钟。 */
export function startESignScheduler(db: Db, options: Options & { readonly intervalMs?: number } = {}) {
  const intervalMs = options.intervalMs ?? 300_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 2_147_483_647)
    throw new RangeError('电子签署调度间隔须为 1000～2147483647 毫秒');
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = runESignJobs(db, options)
      .then(() => undefined)
      .catch((error: unknown) => report(error, options.onError, { kind: 'round' }))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
