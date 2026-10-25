/** DEC-684 / DEC-142：提交后执行全局账号命令；员工事务内只登记，不逆序获取账号锁。 */
import {
  and,
  eq,
  exitAccountTasks,
  getUser,
  getTenant,
  setUserStatus,
  sql,
  withTenant,
  type Db,
  type PlatformCommandContext,
  type User,
} from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { activeTenants, type TenantRow } from './active-tenants.js';
import { readAccountSettings, saveTask, type AccountTask } from './exit-account-store.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

type EnterTenant = PlatformCommandContext['inTenant'];
type Fact = { task: AccountTask; tenant: TenantRow; due: boolean; terminal: boolean };
const context = (f: Fact, now: Date, commandId: string): EmploymentContext => ({
  tenantId: f.tenant.id,
  timezone: f.tenant.timezone,
  now,
  commandId,
  userId: SYSTEM_USER_ID,
  expectedRevision: f.task.revision,
});
const timeIn = (now: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);

async function facts(inTenant: EnterTenant, tenants: readonly TenantRow[], userId: string, now: Date): Promise<Fact[]> {
  const result: Fact[] = [];
  for (const tenant of tenants)
    await inTenant(tenant.id, async (tx) => {
      // 配置修改不获取员工锁，因此可在全局预锁后锁配置，保证判定与状态写入看到同一版设置。
      await tx.execute(sql`SELECT tenant_id FROM exit_account_settings WHERE tenant_id=${tenant.id} FOR SHARE`);
      const settings = await readAccountSettings(tx, tenant.id);
      let after: string | null = null;
      for (;;) {
        const tasks: AccountTask[] = await tx
          .select()
          .from(exitAccountTasks)
          .where(
            and(
              eq(exitAccountTasks.tenantId, tenant.id),
              eq(exitAccountTasks.userId, userId),
              after ? sql`${exitAccountTasks.businessId}>${after}::uuid` : sql`true`,
            ),
          )
          .orderBy(exitAccountTasks.businessId)
          .limit(100);
        for (const task of tasks) {
          const [source] = rowsOf<{ state: string; last: string; actual: string | null; reEmployed: boolean }>(
            await tx.execute(sql`SELECT s.state, p.last_work_date::text AS last, e.actual_leave_date::text AS actual,
            COALESCE(r.re_employed,false) AS "reEmployed"
            FROM exit_requests e JOIN permission_user_person_links l
              ON l.tenant_id=e.tenant_id AND l.employee_id=e.employee_id AND l.user_id=${userId}::uuid
            JOIN LATERAL (SELECT state FROM employment_state_events s
              WHERE s.tenant_id=e.tenant_id AND s.business_id=e.business_id ORDER BY event_no DESC LIMIT 1) s ON true
            JOIN LATERAL (SELECT last_work_date FROM employment_payload_versions p
              WHERE p.tenant_id=e.tenant_id AND p.business_id=e.business_id ORDER BY version_no DESC LIMIT 1) p ON true
            LEFT JOIN retirement_requests r ON r.tenant_id=e.tenant_id AND r.business_id=e.business_id
            WHERE e.tenant_id=${tenant.id} AND e.business_id=${task.businessId}::uuid`),
          );
          const terminal = !source || source.reEmployed || ['deleted', 'voided', 'disapproved'].includes(source.state);
          let due = !terminal && source?.state === 'effective';
          if (
            !terminal &&
            settings.earlyEnabled &&
            settings.time &&
            source &&
            (source.state === 'approved' || (source.state === 'in_review' && settings.inReview))
          ) {
            const day = settings.basis === 'actual_leave_date' ? (source.actual ?? source.last) : source.last;
            const today = tenantLocalDate(now, tenant.timezone);
            due = due || day < today || (day === today && settings.time <= timeIn(now, tenant.timezone));
          }
          result.push({ task, tenant, due, terminal });
        }
        if (tasks.length < 100) break;
        after = tasks.at(-1)!.businessId;
      }
    });
  return result;
}
function desired(plan: readonly Fact[], user: User): 'active' | 'disabled' | null {
  if (user.status === 'active' && plan.some((f) => f.due && ['pending', 'failed'].includes(f.task.status)))
    return 'disabled';
  // 只有真实改期/撤销发出了恢复请求才恢复；关闭提前停用开关不擅自改变已经完成的账号处理。
  if (
    user.status === 'disabled' &&
    !plan.some((f) => f.due) &&
    plan.some((f) => f.task.restoreRequested && f.task.autoRevision === user.revision)
  )
    return 'active';
  return null;
}
function settledStatus(f: Fact, user: User) {
  if (f.due && user.status === 'disabled') return 'disabled';
  if (!f.due && f.task.restoreRequested) {
    if (!f.terminal) return 'pending';
    return user.status === 'active' ? 'restored' : 'skipped';
  }
  return f.terminal ? 'skipped' : f.task.status;
}
async function settle(
  inTenant: EnterTenant,
  plan: readonly Fact[],
  user: User,
  now: Date,
  commandId: string,
  automatic: boolean,
) {
  for (const f of plan) {
    const t = f.task;
    const status = settledStatus(f, user);
    const autoRevision = automatic && user.status === 'disabled' && f.due ? user.revision : t.autoRevision;
    const restoreRequested = t.restoreRequested && f.due;
    if (status === t.status && autoRevision === t.autoRevision && restoreRequested === t.restoreRequested) continue;
    await inTenant(f.tenant.id, async (tx) => {
      const saved = await saveTask(tx, context(f, now, commandId), t, {
        status,
        autoRevision,
        restoreRequested,
        reason: null,
        recipientUserIds: [],
        attempts: automatic ? t.attempts + 1 : t.attempts,
      });
      // 人工重试不取员工锁，可能更新任务版本；凭据丢写时必须连同全局停用一起回滚。
      if (automatic && !saved) throw new AppError('REVISION_CONFLICT', '账号任务已变化，请重试');
    });
  }
}
async function members(db: Db, userId: string) {
  const result: TenantRow[] = [];
  for await (const tenant of activeTenants(db, null)) {
    const active = await withTenant(db, tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT 1 WHERE EXISTS(SELECT 1 FROM tenant_memberships
        WHERE tenant_id=${tenant.id} AND user_id=${userId}::uuid AND status='active')
        OR EXISTS(SELECT 1 FROM exit_account_tasks WHERE tenant_id=${tenant.id} AND user_id=${userId}::uuid)`),
      ),
    );
    if (active.length) result.push(tenant);
  }
  return result;
}
const reasonOf = (error: unknown) => {
  const e = error as { code?: string; details?: { reason?: string } };
  return e?.details?.reason ?? e?.code ?? 'EXIT_ACCOUNT_STORAGE_UNAVAILABLE';
};
async function fail(db: Db, plan: readonly Fact[], now: Date, commandId: string, error: unknown) {
  const reason = reasonOf(error);
  const blocked = reason === 'APPROVAL_EXCEPTION_ADMIN_HANDOVER_REQUIRED';
  for (const f of plan.filter((f) => f.due && ['pending', 'failed'].includes(f.task.status))) {
    await withTenant(db, f.tenant.id, async (tx) => {
      const admins = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT DISTINCT a.user_id AS id FROM permission_admins a
        JOIN tenant_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id AND m.status='active'
        WHERE a.tenant_id=${f.tenant.id} AND a.status='active' AND a.role IN ('tenant_admin','system_admin','employee_admin')`),
      );
      const recipients = [
        ...new Set([...admins.map((a) => a.id), ...(f.task.handlerUserId ? [f.task.handlerUserId] : [])]),
      ].sort();
      await saveTask(tx, context(f, now, commandId), f.task, {
        status: blocked ? 'blocked' : 'failed',
        reason,
        attempts: f.task.attempts + 1,
        recipientUserIds: recipients,
      });
    });
  }
}
async function processUser(db: Db, userId: string, now: Date, origin: TenantRow) {
  const enter: EnterTenant = (tenantId, run) => withTenant(db, tenantId, run);
  const local = await facts(enter, [origin], userId, now);
  if (!local.some((f) => f.due || f.terminal || f.task.restoreRequested)) return;
  const initial = await facts(enter, await members(db, userId), userId, now);
  const user = await getUser(db, userId);
  if (!user) return;
  const target = desired(initial, user);
  const anchor = initial.find((f) => ['pending', 'failed'].includes(f.task.status) || f.task.restoreRequested);
  if (!anchor) return;
  const commandId = `exit-account:${anchor.task.businessId}:${anchor.task.revision}:${user.revision}`;
  if (!target) {
    await settle(enter, initial, user, now, commandId, false);
    return;
  }
  let locked: Fact[] = [];
  try {
    await setUserStatus(
      db,
      { userId, status: target, expectedRevision: user.revision },
      {
        actorUserId: null,
        commandId,
      },
      {
        sourceTenants: [...new Map(initial.map((f) => [f.tenant.id, f.tenant])).values()],
        before: async (ctx, tenants) => {
          locked = await facts(ctx.inTenant, tenants, userId, now);
          if (desired(locked, user) !== target)
            throw new AppError('CONFLICT', '账号任务来源已变化', {
              reason: 'EXIT_ACCOUNT_RECHECK',
            });
        },
        after: (ctx, saved) => settle(ctx.inTenant, locked, saved, now, commandId, true),
      },
    );
  } catch (error) {
    // 保存点/账号事务回滚后另记待办；失败绝不传回已提交的离退休事务。
    if (reasonOf(error) === 'EXIT_ACCOUNT_RECHECK' || reasonOf(error) === 'REVISION_CONFLICT') return;
    await fail(db, locked.length ? locked : initial, now, commandId, error);
  }
}

/** 命令提交后按本命令即时消费；调度按租户键集分页补偿。blocked 只由授权的人工重试解锁。 */
export async function drainExitAccounts(db: Db, tenantId: string, now: Date, commandId?: string) {
  let after: string | null = null;
  const processed = new Set<string>();
  let origin: TenantRow | undefined;
  for (;;) {
    const tasks: { businessId: string; userId: string }[] = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ businessId: exitAccountTasks.businessId, userId: exitAccountTasks.userId })
        .from(exitAccountTasks)
        .where(
          and(
            eq(exitAccountTasks.tenantId, tenantId),
            sql`(${exitAccountTasks.status} IN ('pending','failed') OR ${exitAccountTasks.restoreRequested})`,
            commandId ? eq(exitAccountTasks.commandId, commandId) : sql`true`,
            after ? sql`${exitAccountTasks.businessId}>${after}::uuid` : sql`true`,
          ),
        )
        .orderBy(exitAccountTasks.businessId)
        .limit(100),
    );
    for (const task of tasks)
      if (!processed.has(task.userId)) {
        processed.add(task.userId);
        origin ??= await getTenant(db, tenantId);
        if (origin) await processUser(db, task.userId, now, origin);
      }
    if (tasks.length < 100) return;
    after = tasks.at(-1)!.businessId;
  }
}

/** 指定时刻精确到分钟：独立按分钟补偿，不受任职落地默认五分钟周期限制；同进程不叠加。 */
export function startExitAccountScheduler(
  db: Db,
  options: {
    clock: () => Date;
    onError: (error: unknown) => void;
    intervalMs: number;
  },
) {
  let running: Promise<void> | null = null;
  const timer = setInterval(
    () => {
      if (running) return;
      const now = options.clock();
      running = (async () => {
        for await (const tenant of activeTenants(db, null)) {
          try {
            await drainExitAccounts(db, tenant.id, now);
          } catch (error) {
            options.onError(error);
          }
        }
      })()
        .catch(options.onError)
        .finally(() => {
          running = null;
        });
    },
    Math.min(60_000, options.intervalMs),
  );
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
