/**
 * R2 BE-15b2 自动发起试用期考核的每日批次（DEC-539①；docs/02_业务建模/29 PB-R16 / R17）：挂在定时生效的进程内定时器上
 * （activation-scheduler.ts runSlot，自动转正批次之后），每个租户在本地 04:00 之后的调度推进当天批次。
 * - 当天批次是“推进进度”，不是一次性占位（第 1 轮 P2-1）：业务日登记记录 swept（当天候选已扫过一遍）与 completed_at；
 *   被他人持锁而跳过（SKIP LOCKED）或存储临时出错的员工写入待续跑表，同日后续调度只重试这些人，处理完即删除，
 *   没有待续跑的人才标记当天完成；总开关关闭的日子不推进，打开后的下一次调度即开始；
 * - 仍按租户当地业务日判定：自动考核只在“入职后第 N 天”当天命中、不补发，次日是新的业务日，不接昨天未完成的人；
 * - 只经平台路径触发：遍历租户读平台表，逐员工切到租户路径（withTenant + RLS）；多实例同时推进同一天时，员工锁
 *   SKIP LOCKED + 发起台账保证同一任职同一规则只发起一次；
 * - 非业务错误整名员工回滚、不记业务失败，进入待续跑；业务拒绝（PB-R20、发起人找不到等）记台账 failed，算处理完。
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
import { AUTO_REGULARIZATION_LOCAL_HOUR, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { activeTenants, type TenantRow } from './active-tenants.js';
import { autoAssessEmployee, collectAutoAssessmentOutcomes, type AutoAssessmentRun } from './auto-assessment.js';
import {
  loadEnabledAutoAssessmentRules,
  readAutoAssessmentEnabled,
  type ExpandedAutoAssessmentRule,
} from './auto-assessment-rules.js';
import { autoRegularizationCandidates } from './auto-regularization.js';
import { localHour } from './auto-regularization-scheduler.js';
import { EmploymentError } from './errors.js';
import { rowsOf } from './record-store.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';

const RUN_OPERATION = 'employment.auto-assessment.run';
const PAGE = 200;

export interface AutoAssessmentTenantRun extends AutoAssessmentRun {
  readonly tenantId: string;
  /** false = 未到本地批次时点、总开关关闭，或当天批次已跑过。 */
  readonly ran: boolean;
  readonly skippedLocked: number;
  readonly errors: { readonly employeeId: string; readonly code: string }[];
}

/** 运维 / 调度入口。clock 只由进程注入（测试替身），不接受调用方传入“现在”。 */
export async function runAutoAssessments(
  db: Db,
  meta: PlatformCommandMeta,
  input: { readonly tenantId?: string } = {},
  options: { readonly clock?: () => Date } = {},
): Promise<{ runs: AutoAssessmentTenantRun[] }> {
  if (input.tenantId !== undefined && !isUuid(input.tenantId))
    throw new AppError('VALIDATION_FAILED', '租户标识必须是 UUID');
  const normalized = { tenantId: input.tenantId ?? null };
  const replay = await findPlatformCommandResult<{ runs: AutoAssessmentTenantRun[] }>(
    db,
    meta,
    RUN_OPERATION,
    normalized,
  );
  if (replay) return replay.value;
  const now = (options.clock ?? (() => new Date()))();
  const runs: AutoAssessmentTenantRun[] = [];
  for await (const tenant of activeTenants(db, normalized.tenantId))
    runs.push(await sweepTenant(db, meta, tenant, now));
  const result = { runs };
  return runPlatformCommand(db, meta, RUN_OPERATION, normalized, async (ctx) => {
    await ctx.auditPlatform({
      action: RUN_OPERATION,
      objectType: 'employment-auto-assessment-run',
      objectId: meta.commandId,
      before: null,
      after: {
        ranAt: now.toISOString(),
        tenants: runs.filter((run) => run.ran).length,
        launched: runs.reduce((sum, run) => sum + run.launched.length, 0),
        failed: runs.reduce((sum, run) => sum + run.failed.length, 0),
        errors: runs.reduce((sum, run) => sum + run.errors.length, 0),
      },
    });
    return result;
  });
}

type DayState = 'off' | 'done' | 'sweep' | 'pending';

/** 当天批次的进度：总开关关闭不推进；当天第一次登记 / 上次扫描中途中断 → 整体扫描；已扫完未完成 → 只续跑待办的人。 */
async function claimDay(db: Db, tenantId: string, businessDate: string, commandId: string): Promise<DayState> {
  return withTenant(db, tenantId, async (tx) => {
    if (!(await readAutoAssessmentEnabled(tx, tenantId))) return 'off';
    const claimed = rowsOf(
      await tx.execute(sql`INSERT INTO employment_auto_assessment_daily_runs(tenant_id, business_date, command_id)
        VALUES (${tenantId}, ${businessDate}::date, ${commandId}) ON CONFLICT DO NOTHING RETURNING business_date`),
    );
    if (claimed.length) return 'sweep';
    const [row] = rowsOf<{ swept: boolean; completed: boolean }>(
      await tx.execute(sql`SELECT swept, completed_at IS NOT NULL AS completed
        FROM employment_auto_assessment_daily_runs
        WHERE tenant_id=${tenantId} AND business_date=${businessDate}::date`),
    );
    if (row!.completed) return 'done';
    return row!.swept ? 'pending' : 'sweep';
  });
}

const markPending = (db: Db, tenantId: string, businessDate: string, employeeId: string, reason: 'locked' | 'error') =>
  withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO employment_auto_assessment_daily_pending AS p(tenant_id, business_date, employee_id,
        reason, attempts, updated_at)
      VALUES (${tenantId}, ${businessDate}::date, ${employeeId}::uuid, ${reason}, 1, now())
      ON CONFLICT (tenant_id, business_date, employee_id) DO UPDATE SET reason=EXCLUDED.reason,
        attempts=p.attempts + 1, updated_at=EXCLUDED.updated_at`),
  );

/** 待续跑的员工（员工 ID 升序分页）。 */
async function pendingEmployees(db: Db, tenantId: string, businessDate: string, cursor: string | null) {
  return withTenant(db, tenantId, async (tx) =>
    rowsOf<{ employeeId: string }>(
      await tx.execute(sql`SELECT employee_id::text AS "employeeId" FROM employment_auto_assessment_daily_pending
        WHERE tenant_id=${tenantId} AND business_date=${businessDate}::date
          AND (${cursor}::uuid IS NULL OR employee_id>${cursor}::uuid)
        ORDER BY employee_id LIMIT ${PAGE}`),
    ).map((row) => row.employeeId),
  );
}

/** 当天扫描完成；没有待续跑的人则同时标记当天完成。 */
async function finishSweep(db: Db, tenantId: string, businessDate: string) {
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`UPDATE employment_auto_assessment_daily_runs SET swept=true
      WHERE tenant_id=${tenantId} AND business_date=${businessDate}::date`);
    await completeIfIdle(tx, tenantId, businessDate);
  });
}

async function completeIfIdle(tx: Tx, tenantId: string, businessDate: string) {
  await tx.execute(sql`UPDATE employment_auto_assessment_daily_runs SET completed_at=now()
    WHERE tenant_id=${tenantId} AND business_date=${businessDate}::date AND swept
      AND NOT EXISTS (SELECT 1 FROM employment_auto_assessment_daily_pending
        WHERE tenant_id=${tenantId} AND business_date=${businessDate}::date)`);
}

async function sweepTenant(
  db: Db,
  meta: PlatformCommandMeta,
  tenant: TenantRow,
  now: Date,
): Promise<AutoAssessmentTenantRun> {
  const businessDate = tenantLocalDate(now, tenant.timezone);
  const run = { tenantId: tenant.id, businessDate, launched: [], failed: [], skippedLocked: 0, errors: [] };
  if (localHour(now, tenant.timezone) < AUTO_REGULARIZATION_LOCAL_HOUR) return { ...run, ran: false };
  const day = await claimDay(db, tenant.id, businessDate, meta.commandId);
  if (day === 'off' || day === 'done') return { ...run, ran: false };
  const result: AutoAssessmentTenantRun = { ...run, ran: true };
  const ctx: EmploymentContext = {
    tenantId: tenant.id,
    userId: SYSTEM_USER_ID,
    timezone: tenant.timezone,
    now,
    commandId: meta.commandId,
    expectedRevision: 0,
  };
  const rules = await withTenant(db, tenant.id, (tx) => loadEnabledAutoAssessmentRules(tx, tenant.id, businessDate));
  const page = day === 'sweep' ? candidatePage : pendingEmployees;
  let cursor: string | null = null;
  for (;;) {
    const employees: string[] = rules.length ? await page(db, tenant.id, businessDate, cursor) : [];
    for (const employeeId of employees) await sweepEmployee(db, ctx, employeeId, rules, result);
    if (employees.length < PAGE) break;
    cursor = employees.at(-1)!;
  }
  if (day === 'sweep') await finishSweep(db, tenant.id, businessDate);
  else
    await withTenant(db, tenant.id, async (tx) => {
      // 当天已没有启用规则时，待续跑的人没有事可做：清掉后收尾
      if (!rules.length)
        await tx.execute(sql`DELETE FROM employment_auto_assessment_daily_pending
          WHERE tenant_id=${tenant.id} AND business_date=${businessDate}::date`);
      await completeIfIdle(tx, tenant.id, businessDate);
    });
  return result;
}

const candidatePage = (db: Db, tenantId: string, businessDate: string, cursor: string | null) =>
  withTenant(db, tenantId, (tx) => autoRegularizationCandidates(tx, tenantId, businessDate, cursor, PAGE));

/** 一名员工：持锁办理成功（含业务失败记台账、不再适用）→ 清掉待续跑；被锁 / 存储出错 → 记入待续跑，同日后续调度重试。 */
async function sweepEmployee(
  db: Db,
  ctx: EmploymentContext,
  employeeId: string,
  rules: readonly ExpandedAutoAssessmentRule[],
  result: AutoAssessmentTenantRun & { skippedLocked: number },
) {
  const businessDate = tenantLocalDate(ctx.now, ctx.timezone);
  try {
    const outcomes = await withTenant(db, ctx.tenantId, async (tx) => {
      if (!(await lockTransferParticipants(tx, ctx, employeeId, [], { skipLocked: true }))) return 'locked' as const;
      const done = await autoAssessEmployee(tx, ctx, employeeId, rules);
      await tx.execute(sql`DELETE FROM employment_auto_assessment_daily_pending
        WHERE tenant_id=${ctx.tenantId} AND business_date=${businessDate}::date AND employee_id=${employeeId}::uuid`);
      return done;
    });
    if (outcomes === 'locked') {
      result.skippedLocked += 1;
      await markPending(db, ctx.tenantId, businessDate, employeeId, 'locked');
    } else collectAutoAssessmentOutcomes(result, outcomes);
  } catch (error) {
    const code = error instanceof AppError || error instanceof EmploymentError ? error.code : 'INTERNAL_ERROR';
    result.errors.push({ employeeId, code });
    await markPending(db, ctx.tenantId, businessDate, employeeId, 'error');
  }
}

/** 定时器每个时间槽调用一次：同一槽的命令 ID 相同（多实例同槽只有一个结果登记）；出错只上报，不影响定时生效。 */
export async function runAutoAssessmentSlot(
  db: Db,
  slot: number,
  clock: () => Date,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    const result = await runAutoAssessments(
      db,
      { actorUserId: null, commandId: `emp-auto-assess:${slot}` },
      {},
      { clock },
    );
    for (const run of result.runs)
      if (run.errors.length) onError(new Error(`自动发起考核部分员工未处理：${JSON.stringify(run)}`));
  } catch (error) {
    onError(error);
  }
}
