/**
 * 发展计划阶段的定时开启（docs/02_业务建模/28 IDP-R3；DEC-296⑤ 租户时区凌晨 2 点；DEC-052 / DEC-056；PR 描述 K-33）。
 * - 只经平台路径触发（运维 / 调度进程），租户接口上没有触发入口；平台命令 ID 幂等、平台审计留痕（同 R1-T08 调度）；
 * - 按各租户时区判定业务日与“凌晨 2 点”：本地时间过 2 点后，开启到期日不晚于今天的阶段，否则只到昨天；
 * - 候选：进行中的计划里、前序阶段都已结束的第一个“待开启”的自动阶段，按计划 ID 游标分页推进；limit 是一次运行最多
 *   尝试开启的阶段数（开不了的计划不占名额、不挡住后面的，第 2 轮 P2-9）；幂等键 = 阶段 + 业务日（last_attempt_on），
 *   同一业务日只尝试一次；开启失败记 failed、次数与原因，此后不再自动重试，HR 查明后手动开启（AC-IDP-08）；
 * - 多实例：每个计划一个事务，FOR UPDATE SKIP LOCKED，被其他实例或 HR 持有就跳过，锁内重读；
 * - 逐条复核：计划仍进行中、阶段仍待开启、前序都已结束、到期日已到。
 */
import {
  findPlatformCommandResult,
  isUuid,
  type PlatformCommandMeta,
  runPlatformCommand,
  sql,
  type Db,
  type Tx,
  withPlatform,
  withTenant,
} from '@italent/db';
import { autoStartCutoff, nextOpenableStage, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { rowsOf } from './access.js';
import { loadPlanRow, loadStages } from './plan-store.js';
import { stageViews } from './plan-view.js';
import { openStage } from './stage-service.js';

const RUN_OPERATION = 'idp.stage-auto-start.run';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const TENANT_PAGE = 100;
/** 候选分页大小：每页一条有界查询，游标推进直到尝试数达到 limit 或候选取尽。 */
const CANDIDATE_PAGE = 200;

export interface IdpAutoStartInput {
  readonly tenantId?: string;
  readonly limit?: number;
}

export interface IdpAutoStartRun {
  readonly tenantId: string;
  readonly businessDate: string;
  readonly ranAt: string;
  readonly opened: string[];
  readonly failed: string[];
  readonly skippedLocked: number;
  /** 存储 / 依赖不可用等非业务错误：不记失败，下次运行重试。 */
  readonly errors: { readonly planId: string; readonly code: string }[];
}

export interface IdpAutoStartResult {
  readonly runs: IdpAutoStartRun[];
}

function normalize(input: IdpAutoStartInput) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new AppError('VALIDATION_FAILED', `单次处理量须为 1～${MAX_LIMIT}`);
  if (input.tenantId !== undefined && !isUuid(input.tenantId))
    throw new AppError('VALIDATION_FAILED', '租户标识必须是 UUID');
  return { tenantId: input.tenantId ?? null, limit };
}

/** 本地日期与小时（租户时区）。 */
function localClock(now: Date, timezone: string) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now),
  );
  return { date: tenantLocalDate(now, timezone), hour };
}

/** 运维 / 调度入口。clock 只由进程注入（测试替身），不接受调用方传入“现在”。 */
export async function runIdpAutoStarts(
  db: Db,
  meta: PlatformCommandMeta,
  input: IdpAutoStartInput = {},
  options: { readonly clock?: () => Date } = {},
): Promise<IdpAutoStartResult> {
  const normalized = normalize(input);
  const replay = await findPlatformCommandResult<IdpAutoStartResult>(db, meta, RUN_OPERATION, normalized);
  if (replay) return replay.value;
  const now = (options.clock ?? (() => new Date()))();
  const runs: IdpAutoStartRun[] = [];
  for (const tenant of await activeTenants(db, normalized.tenantId)) {
    runs.push(await sweepTenant(db, meta, tenant, now, normalized.limit));
  }
  const result: IdpAutoStartResult = { runs };
  return runPlatformCommand(db, meta, RUN_OPERATION, normalized, async (ctx) => {
    await ctx.auditPlatform({
      action: RUN_OPERATION,
      objectType: 'idp-stage-auto-start-run',
      objectId: meta.commandId,
      before: null,
      after: {
        ranAt: now.toISOString(),
        tenants: runs.length,
        opened: runs.reduce((sum, run) => sum + run.opened.length, 0),
        failed: runs.reduce((sum, run) => sum + run.failed.length, 0),
        errors: runs.reduce((sum, run) => sum + run.errors.length, 0),
      },
    });
    return result;
  });
}

interface TenantRow {
  readonly id: string;
  readonly timezone: string;
}

/** 只运行启用中的租户（停用、恢复隔离中的租户不开启任何阶段，DEC-061）。 */
async function activeTenants(db: Db, tenantId: string | null): Promise<TenantRow[]> {
  const tenants: TenantRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page: TenantRow[] = await withPlatform(db, async (tx) =>
      rowsOf<TenantRow>(
        await tx.execute(sql`SELECT id::text, timezone FROM tenants WHERE status='active'
          AND (${tenantId}::uuid IS NULL OR id=${tenantId}::uuid)
          AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${TENANT_PAGE}`),
      ),
    );
    tenants.push(...page);
    if (page.length < TENANT_PAGE) return tenants;
    after = page.at(-1)!.id;
  }
}

/**
 * 候选计划（一页，按计划 ID 游标推进）：进行中、没有运行中的阶段、存在“前序都已结束”的待开启自动阶段且今天还没尝试过。
 * 到期日、参照日期与锁在逐条复核时判断——开不了的计划不计入本次尝试数，游标越过它继续往后找（第 2 轮 P2-9）。
 */
async function candidatePage(tx: Tx, tenantId: string, businessDate: string, after: string | null) {
  return rowsOf<{ plan_id: string }>(
    await tx.execute(sql`SELECT p.id AS plan_id FROM idp_plans p
      WHERE p.tenant_id = ${tenantId} AND p.status = 'running'
        AND (${after}::uuid IS NULL OR p.id > ${after}::uuid)
        AND NOT EXISTS (SELECT 1 FROM idp_plan_stages r WHERE r.tenant_id = p.tenant_id AND r.plan_id = p.id
          AND r.status = 'running')
        AND EXISTS (SELECT 1 FROM idp_plan_stages s
          JOIN idp_sub_processes sp ON sp.tenant_id = s.tenant_id AND sp.id = s.sub_process_id
          WHERE s.tenant_id = p.tenant_id AND s.plan_id = p.id AND s.status = 'pending' AND sp.start_mode = 'auto'
            AND (s.last_attempt_on IS NULL OR s.last_attempt_on < ${businessDate}::date)
            AND NOT EXISTS (SELECT 1 FROM idp_plan_stages e WHERE e.tenant_id = s.tenant_id AND e.plan_id = s.plan_id
              AND e.seq < s.seq AND e.status <> 'ended'))
      ORDER BY p.id LIMIT ${CANDIDATE_PAGE}`),
  ).map((r) => r.plan_id);
}

async function sweepTenant(db: Db, meta: PlatformCommandMeta, tenant: TenantRow, now: Date, limit: number) {
  const local = localClock(now, tenant.timezone);
  const cutoff = autoStartCutoff(local);
  const run = { opened: [] as string[], failed: [] as string[], skippedLocked: 0 };
  const errors: IdpAutoStartRun['errors'] = [];
  const actor = {
    tenantId: tenant.id,
    userId: SYSTEM_USER_ID,
    timezone: tenant.timezone,
    now,
    commandId: meta.commandId,
  };
  let after: string | null = null;
  for (;;) {
    const page = await withTenant(db, tenant.id, (tx) => candidatePage(tx, tenant.id, local.date, after));
    for (const planId of page) {
      if (run.opened.length + run.failed.length >= limit) break;
      await attempt(planId);
    }
    if (page.length < CANDIDATE_PAGE || run.opened.length + run.failed.length >= limit) break;
    after = page.at(-1)!;
  }
  return { tenantId: tenant.id, businessDate: local.date, ranAt: now.toISOString(), ...run, errors };

  async function attempt(planId: string) {
    try {
      const outcome = await withTenant(db, tenant.id, async (tx) => {
        const [locked] = rowsOf(
          await tx.execute(sql`SELECT id FROM idp_plans WHERE tenant_id = ${tenant.id} AND id = ${planId}::uuid
            FOR UPDATE SKIP LOCKED`),
        );
        if (!locked) return 'locked' as const;
        const plan = (await loadPlanRow(tx, tenant.id, planId))!;
        if (plan.status !== 'running') return null;
        const stages = await loadStages(tx, tenant.id, [planId]);
        if (stages.some((s) => s.status === 'running')) return null;
        const next = nextOpenableStage(stages);
        // 前序都已结束、待开启（开启失败的不自动重试）、自动开启、今天还没尝试过
        if (!next || next.status !== 'pending' || next.startMode !== 'auto') return null;
        if (next.lastAttemptOn !== null && next.lastAttemptOn >= local.date) return null;
        const due = (await stageViews(tx, plan, stages, local.date)).find((v) => v.id === next.id)?.dueDate;
        if (!due || due > cutoff) return null;
        const opened = await openStage(tx, actor, plan, next);
        return { stageId: next.id, opened: opened.kind === 'opened' };
      });
      if (outcome === 'locked') run.skippedLocked += 1;
      else if (outcome) (outcome.opened ? run.opened : run.failed).push(outcome.stageId);
    } catch (error) {
      // 整个计划回滚、不记失败；下一次运行重试（DEC-052 可重试，结果未知不伪造失败记录）
      errors.push({ planId, code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
    }
  }
}
