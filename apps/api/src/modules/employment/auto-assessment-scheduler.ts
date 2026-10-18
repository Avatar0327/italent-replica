/**
 * R2 BE-15b2 自动发起试用期考核的每日批次（DEC-539①；docs/02_业务建模/29 PB-R16 / R17）：挂在定时生效的进程内定时器上
 * （activation-scheduler.ts runSlot，自动转正批次之后），每个租户在本地 04:00 之后的第一次调度跑一次当天批次。
 * 结构同自动转正批次（auto-regularization-scheduler.ts）：
 * - 当天批次登记（租户 × 业务日）在总开关打开时才占用：开关关闭的日子不占，打开后的下一次调度即补跑当天；
 * - 只经平台路径触发：遍历租户读平台表，逐员工切到租户路径（withTenant + RLS），员工锁 SKIP LOCKED，被“立即执行”、
 *   手工入口或其他实例持有就跳过——持有方按同一发起台账与 PB-R9 / PB-R20 复核，同一任职同一规则只发起一次；
 * - 自动考核只在“入职后第 N 天”当天命中、不补发：被锁跳过的人当天不再重试，需要的话由管理员当天“立即执行”；
 * - 非业务错误（存储不可用等）整名员工回滚、不记失败。
 */
import {
  findPlatformCommandResult,
  isUuid,
  runPlatformCommand,
  sql,
  type Db,
  type PlatformCommandMeta,
  withTenant,
} from '@italent/db';
import { AUTO_REGULARIZATION_LOCAL_HOUR, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { activeTenants, type TenantRow } from './active-tenants.js';
import { autoAssessEmployee, collectAutoAssessmentOutcome, type AutoAssessmentRun } from './auto-assessment.js';
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

/** 总开关打开且当天还没跑过时占用当天批次。 */
async function claimDailyRun(db: Db, tenantId: string, businessDate: string, commandId: string) {
  return withTenant(db, tenantId, async (tx) => {
    if (!(await readAutoAssessmentEnabled(tx, tenantId))) return false;
    const claimed = rowsOf(
      await tx.execute(sql`INSERT INTO employment_auto_assessment_daily_runs(tenant_id, business_date, command_id)
        VALUES (${tenantId}, ${businessDate}::date, ${commandId}) ON CONFLICT DO NOTHING RETURNING business_date`),
    );
    return claimed.length > 0;
  });
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
  if (!(await claimDailyRun(db, tenant.id, businessDate, meta.commandId))) return { ...run, ran: false };
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
  if (!rules.length) return result;
  let cursor: string | null = null;
  for (;;) {
    const page: string[] = await withTenant(db, tenant.id, (tx) =>
      autoRegularizationCandidates(tx, tenant.id, businessDate, cursor, PAGE),
    );
    for (const employeeId of page) await sweepEmployee(db, ctx, employeeId, rules, result);
    if (page.length < PAGE) return result;
    cursor = page.at(-1)!;
  }
}

async function sweepEmployee(
  db: Db,
  ctx: EmploymentContext,
  employeeId: string,
  rules: readonly ExpandedAutoAssessmentRule[],
  result: AutoAssessmentTenantRun & { skippedLocked: number },
) {
  try {
    const outcome = await withTenant(db, ctx.tenantId, async (tx) => {
      if (!(await lockTransferParticipants(tx, ctx, employeeId, [], { skipLocked: true }))) return 'locked' as const;
      return autoAssessEmployee(tx, ctx, employeeId, rules);
    });
    if (outcome === 'locked') result.skippedLocked += 1;
    else collectAutoAssessmentOutcome(result, outcome);
  } catch (error) {
    const code = error instanceof AppError || error instanceof EmploymentError ? error.code : 'INTERNAL_ERROR';
    result.errors.push({ employeeId, code });
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
