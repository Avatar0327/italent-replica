import { riskProducer } from './risk-producer.js';
/** DEC-429：按租户生产者只冻结本期候选；状态转换、逐页执行与幂等键全部交 B3a。 */
import { APP_ROLE, runPlatformCommand, sql, withPlatform, withTenant, type Db, type Tx } from '@italent/db';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import { SUCCESSION_CALC_KINDS, type CalcHandler } from './calc-contract.js';
import { runCalcPage } from './calc-worker.js';
import { rowsOf } from './read-sql.js';
import { recheckPlatform } from './platform-routes.js';
import type { SuccessionJobKind } from './scheduler.js';
import { EXIT_SWEEP_PRODUCER } from './exit-sweep.js';
import { orgStatsProducer } from './org-stats-producer.js';
import { healthProducers } from './health-worker.js';

export interface CalcTenant {
  readonly id: string;
  readonly timezone: string;
}
export interface CalcProducer {
  readonly kind: SuccessionJobKind;
  /** 同一租户事务；业务方用 enqueueCalcRun 冻结候选，必须按 B3a schedule 键去重，不推进 worker、不做外部 IO。 */
  runTenant(tx: Tx, tenant: CalcTenant, now: Date): Promise<void>;
}
/** A3/C1/B4 追加生产者；没有生产者时平台明确返回 KIND_UNAVAILABLE。 */
export const SUCCESSION_PRODUCERS: readonly CalcProducer[] = [
  EXIT_SWEEP_PRODUCER,
  orgStatsProducer,
  riskProducer,
  ...healthProducers,
];
export interface JobInput {
  readonly kind: SuccessionJobKind;
  readonly tenantId?: string;
  readonly cursor?: string;
  readonly userId?: string;
  readonly commandId?: string;
  readonly pageSize?: number;
}
const PATH = '/api/platform/succession/jobs/run';
function fingerprint(input: JobInput) {
  return {
    path: PATH,
    kind: input.kind,
    tenantId: input.tenantId,
    cursor: input.cursor,
    pageSize: input.pageSize ?? 20,
  };
}
async function selectedPage(tx: Tx, input: JobInput, now: Date) {
  const size = input.pageSize ?? 20;
  const tenants = rowsOf<CalcTenant>(
    await tx.execute(sql`
    SELECT id,timezone FROM tenants WHERE status='active'
    ${input.tenantId ? sql`AND id=${input.tenantId}::uuid` : sql``}
    ${input.cursor ? sql`AND id>${input.cursor}::uuid` : sql``}
    ORDER BY id LIMIT ${size + 1}`),
  );
  if (input.tenantId && !tenants.length) throw new AppError('NOT_FOUND', '租户不存在或不可用');
  return {
    tenants: tenants.slice(0, size),
    nextCursor: tenants.length > size ? tenants[size - 1]!.id : null,
    productionAt: now.toISOString(),
  };
}
/** #255 P2-1：平台页先独立提交，首次 / 直接重放 / 提交失败回查均取同一计划，再进入逐租户台账。 */
async function frozenPage(deps: { db: Db; clock: () => Date }, input: JobInput) {
  if (!input.userId) return withPlatform(deps.db, (tx) => selectedPage(tx, input, deps.clock()));
  const userId = input.userId;
  await withPlatform(deps.db, (tx) => recheckPlatform(tx, userId));
  const page = await runPlatformCommand(
    deps.db,
    { actorUserId: userId, commandId: input.commandId! },
    PATH,
    fingerprint(input),
    async (ctx) => {
      await recheckPlatform(ctx.tx, userId);
      await ctx.tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.platform}`));
      const plan = await selectedPage(ctx.tx, input, deps.clock());
      await ctx.auditPlatform({
        action: 'succession.jobs.plan',
        objectType: 'succession-job-page',
        objectId: input.commandId!,
        before: null,
        after: { kind: input.kind, ...plan },
      });
      return plan;
    },
  );
  // 平台执行器直接重放和失败回查都会返回这里；即使冻结页为空也须复核当前身份。
  await withPlatform(deps.db, (tx) => recheckPlatform(tx, userId));
  return page;
}
async function prepare(tx: Tx, tenant: CalcTenant, now: Date, producer: CalcProducer) {
  await producer.runTenant(tx, tenant, now);
  // 每租户每轮有界；按 phase 优先推进落后的 run，避免一个大 run 饿死后来者。
  return rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM succession_calc_runs
    WHERE tenant_id=${tenant.id}::uuid AND kind=${producer.kind} AND status IN ('pending','running')
    ORDER BY phase,id LIMIT 200`),
  ).map((row) => row.id);
}
async function prepareCommand(db: Db, tenant: CalcTenant, now: Date, producer: CalcProducer, input: JobInput) {
  if (!input.userId) return withTenant(db, tenant.id, (tx) => prepare(tx, tenant, now, producer));
  const response = await runCommand(
    db,
    { tenantId: tenant.id, userId: input.userId, timezone: tenant.timezone },
    {
      id: input.commandId,
      fingerprint: fingerprint(input),
      guard: { before: (tx) => recheckPlatform(tx, input.userId!) },
      execute: async (tx) => ({ status: 200, body: { ids: await prepare(tx, tenant, now, producer) } }),
    },
  );
  return (response.body as { ids: string[] }).ids;
}
/** 每次最多 20 租户 × 200 run × 1 页；返回租户游标。相同命令恢复只取原冻结 ID，不重新生产下一周期。 */
export async function dispatchCalcJobs(
  deps: { db: Db; clock: () => Date },
  input: JobInput,
  producers: readonly CalcProducer[] = SUCCESSION_PRODUCERS,
  handlers: readonly CalcHandler[] = SUCCESSION_CALC_KINDS,
) {
  const matched = producers.filter((p) => p.kind === input.kind);
  if (matched.length !== 1)
    throw new AppError('SERVICE_UNAVAILABLE', '计算任务尚未就绪', { reason: 'KIND_UNAVAILABLE' });
  const size = input.pageSize ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 20) throw new TypeError('租户页大小须为 1～20');
  if (input.userId && (!input.commandId || !/^[A-Za-z0-9:_-]{1,100}$/.test(input.commandId)))
    throw new AppError(input.commandId ? 'VALIDATION_FAILED' : 'IDEMPOTENCY_KEY_REQUIRED', '调度必须携带有效命令 ID');
  const page = await frozenPage(deps, input);
  const items: { tenantId: string; runIds?: string[]; error?: string }[] = [];
  for (const tenant of page.tenants) {
    try {
      const ids = await prepareCommand(deps.db, tenant, new Date(page.productionAt), matched[0]!, input);
      for (const id of ids) {
        if (input.userId) await withTenant(deps.db, tenant.id, (tx) => recheckPlatform(tx, input.userId!));
        await runCalcPage(deps.db, tenant.id, id, handlers, deps.clock());
      }
      items.push({ tenantId: tenant.id, runIds: ids });
    } catch (error) {
      if (error instanceof AppError && ['FORBIDDEN', 'IDEMPOTENCY_CONFLICT'].includes(error.code)) throw error;
      items.push({ tenantId: tenant.id, error: 'STORAGE_UNAVAILABLE' });
    }
  }
  return { items, nextCursor: page.nextCursor };
}
/** 进程调度与平台入口共用按租户生产 / 推进；未登记的业务保持关闭，单租户失败不阻止其他租户。 */
export async function runScheduledCalc(db: Db, now: Date, kind: SuccessionJobKind) {
  if (!SUCCESSION_PRODUCERS.some((p) => p.kind === kind)) return;
  let cursor: string | undefined;
  do {
    const page = await dispatchCalcJobs({ db, clock: () => now }, { kind, cursor });
    if (page.items.some((item) => item.error)) console.error(`继任 ${kind} 调度部分租户失败`);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}
