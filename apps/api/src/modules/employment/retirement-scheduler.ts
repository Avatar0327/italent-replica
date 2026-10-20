/**
 * R2 BE-5c2 预计退休日期 / 弹性范围的每日批次（R2-T04 §9.2；挂在定时生效的进程内定时器，照 auto-regularization-scheduler.ts）：
 * 每个租户在本地 03:00 之后的调度推进当天批次，两种 purpose 各一行 retirement_rule_daily_runs；对应开关关闭的日子不建行。
 * - 认领：INSERT … ON CONFLICT DO NOTHING 建 running（租约 10 分钟）；租约过期的 running 行用 CAS 接管（attempts + 1）；done 跳过。
 *   认领在独立短事务；之后每次推进都带 attempts 校验，租约被别人接管后本进程的推进被拒（LeaseLost），不再写进度；
 * - 主扫描：按员工 ID 升序、每页 200，从 position_employee_id 之后取候选；每名员工一个事务（withTenant + RLS），员工锁 SKIP LOCKED；
 *   每页结束在同一短事务里推进位置、续租、把本页锁忙的员工写入 retirement_rule_run_skips（pending），崩溃后可恢复；
 * - 第二遍：主扫描到末尾后读 pending 跳过行逐个重试，成功则（与写入同事务）删除该行，仍忙置 given_up 并 skipped_count + 1；
 *   接管者看到位置已到末尾、仍有 pending 行即直接进入第二遍；pending 清空后才置 done；
 * - 单员工业务错误记入回执不中断；存储等非业务错误回滚该员工并结束本次调度（行仍 running，租约过期后续跑）。
 */
import {
  findPlatformCommandResult,
  isUuid,
  runPlatformCommand,
  sql,
  type Db,
  type PlatformCommandMeta,
  type Tx,
  withTenant,
} from '@italent/db';
import { tenantLocalDate, type RetirementRule, type RetirementRulePurpose } from '@italent/domain';
import { AppError } from '../../errors.js';
import { activeTenants, type TenantRow } from './active-tenants.js';
import { localHour } from './auto-regularization-scheduler.js';
import {
  applyRetirementRules,
  collectRetirementOutcome,
  readRetirementSwitch,
  retirementCandidates,
  systemContext,
  type RetirementFailed,
  type RetirementUpdated,
} from './retirement-compute.js';
import { loadRetirementRulesForRun } from './retirement-rules.js';
import { rowsOf } from './record-store.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';

const RUN_OPERATION = 'employment.retirement-rule.run';
export const RETIREMENT_BATCH_LOCAL_HOUR = 3;
export const RETIREMENT_BATCH_LEASE_MINUTES = 10;
/** 每页员工数（主扫描、第二遍、立即执行共用）；测试可调小以覆盖分页与续跑（同一代码路径）。 */
export const RETIREMENT_BATCH_LIMITS = { page: 200 };
const PURPOSES: readonly RetirementRulePurpose[] = ['expected_date', 'flexible_range'];

export interface RetirementPurposeRun {
  readonly purpose: RetirementRulePurpose;
  readonly businessDate: string;
  /** false = 未到本地批次时点、开关关闭、当天已完成，或租约仍被别的进程持有。 */
  ran: boolean;
  /** 本次是接管了租约过期的未完成批次。 */
  resumed: boolean;
  /** 本次因存储等非业务错误中止（行仍 running，租约过期后续跑）。 */
  aborted: boolean;
  /** 中止原因（错误消息，不含业务数据）。 */
  abortReason: string | null;
  updated: RetirementUpdated[];
  failed: RetirementFailed[];
  /** 主扫描里锁忙跳过的人数。 */
  skippedLocked: number;
  /** 第二遍仍锁忙、本日放弃的人数。 */
  givenUp: number;
}

export interface RetirementTenantRun {
  readonly tenantId: string;
  readonly purposes: RetirementPurposeRun[];
}

/** 租约被别的进程接管：本进程不再写进度。 */
class LeaseLost extends Error {}

/** 运维 / 调度入口。clock 只由进程注入（测试替身），不接受调用方传入“现在”。 */
export async function runRetirementBatches(
  db: Db,
  meta: PlatformCommandMeta,
  input: { readonly tenantId?: string } = {},
  options: { readonly clock?: () => Date } = {},
): Promise<{ runs: RetirementTenantRun[] }> {
  if (input.tenantId !== undefined && !isUuid(input.tenantId))
    throw new AppError('VALIDATION_FAILED', '租户标识必须是 UUID');
  const normalized = { tenantId: input.tenantId ?? null };
  const replay = await findPlatformCommandResult<{ runs: RetirementTenantRun[] }>(db, meta, RUN_OPERATION, normalized);
  if (replay) return replay.value;
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const runs: RetirementTenantRun[] = [];
  for await (const tenant of activeTenants(db, normalized.tenantId))
    runs.push(await sweepTenant(db, meta, tenant, clock, now));
  const result = { runs };
  return runPlatformCommand(db, meta, RUN_OPERATION, normalized, async (ctx) => {
    const all = runs.flatMap((run) => run.purposes);
    await ctx.auditPlatform({
      action: RUN_OPERATION,
      objectType: 'employment-retirement-rule-run',
      objectId: meta.commandId,
      before: null,
      after: {
        ranAt: now.toISOString(),
        batches: all.filter((run) => run.ran).length,
        updated: all.reduce((sum, run) => sum + run.updated.length, 0),
        failed: all.reduce((sum, run) => sum + run.failed.length, 0),
        aborted: all.filter((run) => run.aborted).length,
      },
    });
    return result;
  });
}

async function sweepTenant(
  db: Db,
  meta: PlatformCommandMeta,
  tenant: TenantRow,
  clock: () => Date,
  now: Date,
): Promise<RetirementTenantRun> {
  const businessDate = tenantLocalDate(now, tenant.timezone);
  const purposes: RetirementPurposeRun[] = [];
  // 预计日期先于弹性范围：弹性范围按人事当前的 P 计算，同一次调度里先落新 P 再算范围
  for (const purpose of PURPOSES) {
    const run: RetirementPurposeRun = {
      purpose,
      businessDate,
      ran: false,
      resumed: false,
      aborted: false,
      abortReason: null,
      updated: [],
      failed: [],
      skippedLocked: 0,
      givenUp: 0,
    };
    purposes.push(run);
    if (localHour(now, tenant.timezone) < RETIREMENT_BATCH_LOCAL_HOUR) continue;
    await sweepPurpose(db, meta, tenant, clock, now, run);
  }
  return { tenantId: tenant.id, purposes };
}

interface Claimed {
  readonly attempts: number;
  readonly position: string | null;
}

const leaseUntil = (clock: () => Date) =>
  new Date(clock().getTime() + RETIREMENT_BATCH_LEASE_MINUTES * 60_000).toISOString();

/** 认领当天批次：新建 / 接管过期租约；开关关闭、已完成、租约仍有效返回 null。 */
async function claim(
  db: Db,
  tenantId: string,
  purpose: RetirementRulePurpose,
  businessDate: string,
  commandId: string,
  clock: () => Date,
  now: Date,
): Promise<(Claimed & { readonly resumed: boolean }) | null> {
  return withTenant(db, tenantId, async (tx) => {
    if (!(await readRetirementSwitch(tx, tenantId, purpose))) return null;
    const lease = leaseUntil(clock);
    const [created] = rowsOf<{ attempts: number }>(
      await tx.execute(sql`INSERT INTO retirement_rule_daily_runs(tenant_id, purpose, business_date, state,
          lease_until, attempts, command_id, updated_at)
        VALUES (${tenantId}, ${purpose}, ${businessDate}::date, 'running', ${lease}::timestamptz, 1, ${commandId},
          ${now.toISOString()}::timestamptz)
        ON CONFLICT DO NOTHING RETURNING attempts`),
    );
    if (created) return { attempts: created.attempts, position: null, resumed: false };
    const [taken] = rowsOf<{ attempts: number; position: string | null }>(
      await tx.execute(sql`UPDATE retirement_rule_daily_runs SET lease_until=${lease}::timestamptz,
          attempts=attempts + 1, command_id=${commandId}, updated_at=${now.toISOString()}::timestamptz
        WHERE tenant_id=${tenantId} AND purpose=${purpose} AND business_date=${businessDate}::date
          AND state='running' AND lease_until < ${now.toISOString()}::timestamptz
        RETURNING attempts, position_employee_id::text AS position`),
    );
    return taken ? { ...taken, resumed: true } : null;
  });
}

interface Batch {
  readonly db: Db;
  readonly tenant: TenantRow;
  readonly purpose: RetirementRulePurpose;
  readonly businessDate: string;
  readonly attempts: number;
  readonly clock: () => Date;
  readonly ctx: EmploymentContext;
}

const runKey = (batch: Batch) =>
  sql`tenant_id=${batch.tenant.id} AND purpose=${batch.purpose} AND business_date=${batch.businessDate}::date`;

async function sweepPurpose(
  db: Db,
  meta: PlatformCommandMeta,
  tenant: TenantRow,
  clock: () => Date,
  now: Date,
  result: RetirementPurposeRun,
) {
  const claimed = await claim(db, tenant.id, result.purpose, result.businessDate, meta.commandId, clock, now);
  if (!claimed) return;
  result.ran = true;
  result.resumed = claimed.resumed;
  const ctx = systemContext({
    tenantId: tenant.id,
    userId: '',
    timezone: tenant.timezone,
    now,
    commandId: meta.commandId,
    expectedRevision: 0,
  });
  const batch: Batch = {
    db,
    tenant,
    purpose: result.purpose,
    businessDate: result.businessDate,
    attempts: claimed.attempts,
    clock,
    ctx,
  };
  try {
    await mainScan(batch, claimed.position, result);
    await secondPass(batch, result);
    await finish(batch);
  } catch (error) {
    if (error instanceof LeaseLost) result.ran = false;
    else {
      result.aborted = true;
      result.abortReason = error instanceof Error ? error.message : String(error);
    }
  }
}

const loadRules = (batch: Batch): Promise<RetirementRule[]> =>
  withTenant(batch.db, batch.tenant.id, (tx) =>
    loadRetirementRulesForRun(tx, batch.tenant.id, batch.purpose, batch.businessDate),
  );

/** 推进进度并续租；租约已被接管（attempts 不符）时抛 LeaseLost，调用方所在事务整体回滚。 */
async function renew(tx: Tx, batch: Batch, position?: string) {
  const [row] = rowsOf(
    await tx.execute(sql`UPDATE retirement_rule_daily_runs SET lease_until=${leaseUntil(batch.clock)}::timestamptz,
        ${position ? sql`position_employee_id=${position}::uuid,` : sql``} updated_at=${batch.ctx.now.toISOString()}::timestamptz
      WHERE ${runKey(batch)} AND state='running' AND attempts=${batch.attempts} RETURNING 1`),
  );
  if (!row) throw new LeaseLost();
}

async function mainScan(batch: Batch, from: string | null, result: RetirementPurposeRun) {
  let position = from;
  for (;;) {
    const { page: size } = RETIREMENT_BATCH_LIMITS;
    const page = await withTenant(batch.db, batch.tenant.id, (tx) =>
      retirementCandidates(tx, batch.tenant.id, batch.businessDate, position, size),
    );
    if (!page.length) return;
    // 规则每页重读：扫描期间被停用 / 改动的规则不再套用到后面的页
    const rules = await loadRules(batch);
    const skipped: string[] = [];
    for (const employeeId of page) {
      const outcome = await settleEmployee(batch, employeeId, rules);
      if (outcome === 'busy') skipped.push(employeeId);
      else collectRetirementOutcome(result, outcome);
    }
    result.skippedLocked += skipped.length;
    position = page.at(-1)!;
    await withTenant(batch.db, batch.tenant.id, async (tx) => {
      await renew(tx, batch, position!);
      if (skipped.length)
        await tx.execute(sql`INSERT INTO retirement_rule_run_skips(tenant_id, purpose, business_date, employee_id, state)
          SELECT ${batch.tenant.id}, ${batch.purpose}, ${batch.businessDate}::date, e, 'pending'
          FROM unnest(${`{${skipped.join(',')}}`}::uuid[]) AS e ON CONFLICT DO NOTHING`);
    });
    if (page.length < size) return;
  }
}

/** 一名员工一个事务：SKIP LOCKED 取锁，被他人持有 → 'busy'；主档不存在没有可办理的对象 → null。 */
async function settleEmployee(batch: Batch, employeeId: string, rules: readonly RetirementRule[]) {
  return withTenant(batch.db, batch.tenant.id, async (tx) => {
    const lock = await lockTransferParticipants(tx, batch.ctx, employeeId, [], { skipLocked: true });
    if (lock === 'busy') return 'busy' as const;
    return lock === 'missing' ? null : applyRetirementRules(tx, batch.ctx, employeeId, batch.purpose, rules);
  });
}

async function secondPass(batch: Batch, result: RetirementPurposeRun) {
  for (;;) {
    const pending = await withTenant(batch.db, batch.tenant.id, async (tx) =>
      rowsOf<{ employeeId: string }>(
        await tx.execute(sql`SELECT employee_id::text AS "employeeId" FROM retirement_rule_run_skips
          WHERE ${runKey(batch)} AND state='pending' ORDER BY employee_id LIMIT ${RETIREMENT_BATCH_LIMITS.page}`),
      ).map((row) => row.employeeId),
    );
    if (!pending.length) return;
    const rules = await loadRules(batch);
    for (const employeeId of pending) await retryEmployee(batch, employeeId, rules, result);
  }
}

/** 第二遍的一名员工：写入（或放弃）与跳过行的收口在同一事务，进程在任意点退出都不会丢行或重复写。 */
async function retryEmployee(
  batch: Batch,
  employeeId: string,
  rules: readonly RetirementRule[],
  result: RetirementPurposeRun,
) {
  await withTenant(batch.db, batch.tenant.id, async (tx) => {
    const lock = await lockTransferParticipants(tx, batch.ctx, employeeId, [], { skipLocked: true });
    const skip = sql`tenant_id=${batch.tenant.id} AND purpose=${batch.purpose}
      AND business_date=${batch.businessDate}::date AND employee_id=${employeeId}::uuid`;
    if (lock === 'busy') {
      await tx.execute(sql`UPDATE retirement_rule_run_skips SET state='given_up' WHERE ${skip}`);
      const [row] = rowsOf(
        await tx.execute(sql`UPDATE retirement_rule_daily_runs SET skipped_count=skipped_count + 1,
            lease_until=${leaseUntil(batch.clock)}::timestamptz, updated_at=${batch.ctx.now.toISOString()}::timestamptz
          WHERE ${runKey(batch)} AND state='running' AND attempts=${batch.attempts} RETURNING 1`),
      );
      if (!row) throw new LeaseLost();
      result.givenUp += 1;
      return;
    }
    if (lock === 'acquired')
      collectRetirementOutcome(result, await applyRetirementRules(tx, batch.ctx, employeeId, batch.purpose, rules));
    await tx.execute(sql`DELETE FROM retirement_rule_run_skips WHERE ${skip}`);
    await renew(tx, batch);
  });
}

/** pending 清空后才置 done。 */
async function finish(batch: Batch) {
  await withTenant(batch.db, batch.tenant.id, async (tx) => {
    const [row] = rowsOf(
      await tx.execute(sql`UPDATE retirement_rule_daily_runs SET state='done',
          updated_at=${batch.ctx.now.toISOString()}::timestamptz
        WHERE ${runKey(batch)} AND state='running' AND attempts=${batch.attempts}
          AND NOT EXISTS (SELECT 1 FROM retirement_rule_run_skips s WHERE s.tenant_id=${batch.tenant.id}
            AND s.purpose=${batch.purpose} AND s.business_date=${batch.businessDate}::date AND s.state='pending')
        RETURNING 1`),
    );
    if (!row) throw new LeaseLost();
  });
}

/** 定时器每个时间槽调用一次：同一槽的命令 ID 相同（多实例同槽只有一个结果登记）；出错只上报，不影响定时生效。 */
export async function runRetirementSlot(
  db: Db,
  slot: number,
  clock: () => Date,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    const result = await runRetirementBatches(db, { actorUserId: null, commandId: `ret-rule:${slot}` }, {}, { clock });
    for (const run of result.runs)
      for (const purpose of run.purposes)
        if (purpose.aborted)
          onError(new Error(`退休规则批次中止（租约过期后续跑）：${run.tenantId} ${purpose.purpose}`));
        else if (purpose.failed.length) onError(new Error(`退休规则批次部分员工未处理：${JSON.stringify(purpose)}`));
  } catch (error) {
    onError(error);
  }
}
