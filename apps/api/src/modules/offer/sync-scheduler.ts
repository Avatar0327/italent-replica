/**
 * Offer 夜间补同步（R2 BE-14b2；34 OF-R8「接受且距入职日 ≤ N 天，由每晚定时任务补同步」，AGENTS §10 定时任务）。
 * 按各租户时区的业务日判定（DEC-056）：已发 / 已接受、未关联待入职、按租户同步时机到期的 Offer 逐条同步。
 * - 每条 Offer 一个事务，先 FOR UPDATE SKIP LOCKED 锁 Offer 行（与手动“立即同步”、其他实例互斥），锁内重判；
 * - 幂等：已关联待入职的 Offer 不在候选里；失败的同一业务日只重试一次（失败记次数与原因，次日再试）；
 * - 有界且不饿死：限量之前先在 SQL 里按状态 / 时机筛出可处理项，再按（计划入职日, ID）分页扫完（每页 limit 条，每租户每次
 *   最多 5000 条）；不可处理的（如在职实习生且开关关闭）留在候选里也不会挡住后面的；
 * - 只经平台路径遍历租户，落地时切到租户路径（RLS）；租户接口上没有触发入口。
 */
import { sql, withPlatform, withTenant, type Db } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { readOfferSyncSetting, syncOfferWhenDue, type OfferSyncContext } from './sync.js';

const DEFAULT_LIMIT = 200;
const TENANT_PAGE = 100;
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

export interface OfferSyncRun {
  /** 本次同步成功的 Offer。 */
  readonly synced: string[];
  /** 本次同步失败（已记在 Offer 上，次日重试）的 Offer。 */
  readonly failed: string[];
  /** 存储不可用等非业务错误：不记失败，下次运行重试。 */
  readonly errors: { readonly offerId: string; readonly code: string }[];
}

export async function runOfferSyncSweep(
  db: Db,
  options: { readonly clock?: () => Date; readonly tenantId?: string; readonly limit?: number } = {},
): Promise<OfferSyncRun> {
  const now = (options.clock ?? (() => new Date()))();
  const run: OfferSyncRun = { synced: [], failed: [], errors: [] };
  let after: string | null = null;
  for (;;) {
    const page: { id: string; timezone: string }[] = await withPlatform(db, async (tx) =>
      rows(
        await tx.execute(sql`SELECT id::text, timezone FROM tenants WHERE status='active'
          AND (${options.tenantId ?? null}::uuid IS NULL OR id=${options.tenantId ?? null}::uuid)
          AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${TENANT_PAGE}`),
      ),
    );
    for (const tenant of page) await sweepTenant(db, tenant, now, options.limit ?? DEFAULT_LIMIT, run);
    if (page.length < TENANT_PAGE) return run;
    after = page.at(-1)!.id;
  }
}

/** 每个租户每次运行最多处理的 Offer 数（超出的留给下一次运行）。 */
const MAX_PER_TENANT = 5000;

async function sweepTenant(
  db: Db,
  tenant: { id: string; timezone: string },
  now: Date,
  pageSize: number,
  run: OfferSyncRun,
) {
  const today = tenantLocalDate(now, tenant.timezone);
  const setting = await withTenant(db, tenant.id, (tx) => readOfferSyncSetting(tx, tenant.id));
  if (!setting.enabled) return;
  // 限量之前先按状态与时机筛出可处理项（SQL 与 offerSyncDue 同口径，锁内再判一次），否则前面不可处理的行会永远挡住后面的
  const status = setting.mode === 'on_send' ? sql`status IN ('sent','accepted')` : sql`status = 'accepted'`;
  const near =
    setting.mode === 'on_accept_within_days'
      ? sql`planned_entry_date <= ${today}::date + ${setting.days}::int`
      : sql`true`;
  let after: { date: string | null; id: string | null } = { date: null, id: null };
  let seen = 0;
  while (seen < MAX_PER_TENANT) {
    const page: { id: string; date: string }[] = await withTenant(db, tenant.id, async (tx) =>
      rows(
        await tx.execute(sql`SELECT id::text, planned_entry_date::text AS date FROM offers
          WHERE tenant_id=${tenant.id} AND ${status} AND ${near} AND pending_entry_business_id IS NULL
            AND planned_entry_date IS NOT NULL
            AND (sync_status IS NULL OR (sync_status='failed'
              AND (last_sync_at AT TIME ZONE ${tenant.timezone})::date < ${today}::date))
            AND (${after.date}::date IS NULL OR (planned_entry_date, id) > (${after.date}::date, ${after.id}::uuid))
          ORDER BY planned_entry_date, id LIMIT ${pageSize}`),
      ),
    );
    for (const { id } of page) await syncOne(db, tenant, now, today, id, run);
    seen += page.length;
    if (page.length < pageSize) return;
    after = { date: page.at(-1)!.date, id: page.at(-1)!.id };
  }
}

async function syncOne(
  db: Db,
  tenant: { id: string; timezone: string },
  now: Date,
  today: string,
  id: string,
  run: OfferSyncRun,
) {
  const ctx: OfferSyncContext = {
    tenantId: tenant.id,
    userId: SYSTEM_USER_ID,
    timezone: tenant.timezone,
    now,
    commandId: `offer-sync:${today}:${id}`,
  };
  try {
    const result = await withTenant(db, tenant.id, (tx) => syncOfferWhenDue(tx, ctx, id, { skipLocked: true }));
    if (!result.attempted) return;
    (result.row!.syncStatus === 'success' ? run.synced : run.failed).push(id);
  } catch (error) {
    // 整条回滚、不记失败；仍在候选里，下一次运行重试（DEC-052：结果未知不伪造失败记录）
    run.errors.push({ offerId: id, code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
  }
}

export interface OfferSyncScheduler {
  stop(): Promise<void>;
}

/** 进程内调度：默认每小时扫一次；扫描本身幂等，多实例靠 Offer 行锁去重，同进程上一轮未结束不叠加。 */
export function startOfferSyncScheduler(
  db: Db,
  options: { readonly intervalMs?: number; readonly onError?: (error: unknown) => void } = {},
): OfferSyncScheduler {
  const intervalMs = options.intervalMs ?? 3_600_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
    throw new RangeError('Offer 补同步间隔须为不小于 1000 的毫秒数');
  const onError = options.onError ?? ((error: unknown) => console.error('Offer 补同步运行失败', error));
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = runOfferSyncSweep(db)
      .then((run) => {
        if (run.errors.length) onError(new Error(`Offer 补同步部分未处理：${JSON.stringify(run.errors)}`));
      })
      .catch(onError)
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
