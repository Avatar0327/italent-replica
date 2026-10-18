/**
 * R2 BE-15b2 自动发起试用期考核的执行（docs/02_业务建模/29 PB-R16 / R17 / R19 / R20 / R22；差距表 B58；DEC-539①）。
 * - 适用对象（PB-R19）：当前生效主职为试用、内部员工，命中启用中的规则（适用组织含主职部门、入职日 + N 天 = 当天）；
 * - 触发（AC-PB-06）：只在“入职后第 N 天”当天发起，过了不补发——与自动转正（目标日 ≤ 当天补发）不同；同一任职同一规则
 *   只发起一次：发起台账（规则 × 本任职周期的开启记录）在员工锁内复核，主键兜底；
 * - 失败（PB-R20）：本任职周期已有审批中 / 通过 / 生效的转正记录或审批中的考核，发起人找不到，或考核发起入口拒绝
 *   （PB-R9 互斥、没有匹配的流程等）——整人回滚到保存点，台账记 failed、次数与原因，同一天再执行可重试（DEC-052）；
 * - 发起：经 BE-15b1 的单一入口 launchAssessment（initiation = auto、system_proxy，审批发起日志 detail.systemProxy），
 *   发起人取规则配置；PB-R9 / 并行规则由入口里的 assertProbationProcessesIdle 统一判定，这里不另写互斥；
 * - F-223：员工锁内按最新规则状态复核（预筛后被停用 / 改动的规则不再发起）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  AUTO_ASSESSMENT_BLOCKING_REGULARIZATION_STATES,
  EMPLOYEE_STATUS,
  matchAutoAssessmentRules,
  tenantLocalDate,
} from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { launchAssessment } from './assessment.js';
import {
  currentAutoAssessmentRules,
  loadEnabledAutoAssessmentRules,
  readAutoAssessmentEnabled,
  type ExpandedAutoAssessmentRule,
} from './auto-assessment-rules.js';
import { autoRegularizationCandidates, findCycleRegularization, resolveInitiator } from './auto-regularization.js';
import { EmploymentError } from './errors.js';
import { loadProbationCycle, type ProbationCycle } from './probation.js';
import { findCurrentRecord } from './read-model.js';
import { rowsOf } from './record-store.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';

export interface AutoAssessmentLaunched {
  readonly employeeId: string;
  readonly ruleId: string;
  readonly assessmentId: string;
  readonly assessmentStatus: string;
  readonly initiatorUserId: string;
}

export interface AutoAssessmentFailed {
  readonly employeeId: string;
  readonly ruleId: string;
  readonly reason: string;
}

export type AutoAssessmentOutcome =
  | ({ readonly kind: 'launched' } & AutoAssessmentLaunched)
  | ({ readonly kind: 'failed' } & AutoAssessmentFailed)
  | null;

export interface AutoAssessmentRun {
  readonly businessDate: string;
  readonly launched: AutoAssessmentLaunched[];
  readonly failed: AutoAssessmentFailed[];
}

interface Subject {
  readonly cycle: ProbationCycle;
  readonly departmentId: string | null;
}

/** PB-R19：当前生效主职为试用状态、内部员工；否则不是适用对象（不记失败）。 */
async function subjectOf(tx: Tx, tenantId: string, employeeId: string, today: string): Promise<Subject | null> {
  const cycle = await loadProbationCycle(tx, tenantId, employeeId, today);
  if (!cycle) return null;
  const current = await findCurrentRecord(tx, tenantId, employeeId, today);
  if (!current || current.employeeStatus !== EMPLOYEE_STATUS.probation || current.fields.employType !== 'internal')
    return null;
  return { cycle, departmentId: current.fields.departmentId ?? null };
}

async function launchedBefore(tx: Tx, tenantId: string, ruleId: string, anchorId: string): Promise<boolean> {
  const [row] = rowsOf<{ state: string }>(
    await tx.execute(sql`SELECT state FROM employment_auto_assessment_launches
      WHERE tenant_id=${tenantId} AND rule_id=${ruleId}::uuid AND anchor_id=${anchorId}::uuid`),
  );
  return row?.state === 'launched';
}

/** PB-R20：本任职周期已有审批中 / 通过 / 生效的转正记录，或审批中的考核（不论类型）。 */
async function assertNoCycleConflict(tx: Tx, tenantId: string, subject: Subject) {
  const { anchor } = subject.cycle;
  const regularization = await findCycleRegularization(
    tx,
    tenantId,
    anchor,
    AUTO_ASSESSMENT_BLOCKING_REGULARIZATION_STATES,
  );
  const [assessment] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id::text AS id FROM employment_probation_assessments
      WHERE tenant_id=${tenantId} AND employee_id=${anchor.employeeId}::uuid AND anchor_id=${anchor.id}::uuid
        AND status='in_review' LIMIT 1`),
  );
  if (regularization || assessment)
    throw new AppError('CONFLICT', '本任职周期已有转正记录或审批中的考核，不能自动发起考核', {
      reason: 'AUTO_ASSESSMENT_CYCLE_CONFLICT',
      ...(regularization ? { businessId: regularization } : { assessmentId: assessment!.id }),
    });
}

async function recordOutcome(
  tx: Tx,
  ctx: EmploymentContext,
  key: { readonly ruleId: string; readonly anchorId: string; readonly employeeId: string },
  outcome: {
    readonly assessmentId: string | null;
    readonly initiatorUserId: string | null;
    readonly reason: string | null;
  },
) {
  const now = ctx.now.toISOString();
  const state = outcome.assessmentId ? 'launched' : 'failed';
  // launched 只写一次：已发起的行不再更新（WHERE 条件），failed 行累计次数
  await tx.execute(sql`INSERT INTO employment_auto_assessment_launches AS l(tenant_id, rule_id, anchor_id,
      employee_id, state, assessment_id, initiator_user_id, system_proxy, attempts, last_reason, command_id,
      created_at, updated_at)
    VALUES (${ctx.tenantId}, ${key.ruleId}::uuid, ${key.anchorId}::uuid, ${key.employeeId}::uuid, ${state},
      ${outcome.assessmentId}::uuid, ${outcome.initiatorUserId}::uuid, true, 1, ${outcome.reason}, ${ctx.commandId},
      ${now}::timestamptz, ${now}::timestamptz)
    ON CONFLICT (tenant_id, rule_id, anchor_id) DO UPDATE SET state=EXCLUDED.state,
      assessment_id=EXCLUDED.assessment_id, initiator_user_id=EXCLUDED.initiator_user_id, attempts=l.attempts + 1,
      last_reason=EXCLUDED.last_reason, command_id=EXCLUDED.command_id, updated_at=EXCLUDED.updated_at
    WHERE l.state='failed'`);
}

function reasonOf(error: AppError | EmploymentError): string {
  const details = (error as { details?: unknown }).details;
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' ? reason : error.code;
}

/**
 * 今天待发起的规则（不取锁，可用于预筛；办理前须在员工锁内再判一次）：适用对象、命中规则（今天是它的第 N 天）、
 * 该规则尚未对本任职发起。已发起的只跳过这一条，不影响同天到期的其他规则（第 1 轮 P2-2）。
 */
async function dueRulesOf(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  rules: readonly ExpandedAutoAssessmentRule[],
  today: string,
): Promise<{ readonly subject: Subject; readonly rules: ExpandedAutoAssessmentRule[] } | null> {
  const subject = await subjectOf(tx, tenantId, employeeId, today);
  if (!subject) return null;
  const pending: ExpandedAutoAssessmentRule[] = [];
  for (const rule of matchAutoAssessmentRules(rules, subject.departmentId, subject.cycle.anchor.entryDate, today))
    if (!(await launchedBefore(tx, tenantId, rule.id, subject.cycle.anchor.id))) pending.push(rule);
  return pending.length ? { subject, rules: pending } : null;
}

/** 一条规则 × 一名员工：保存点内发起；业务拒绝记台账 failed（原因、次数），其余错误向上抛由整人回滚。 */
async function launchByRule(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  subject: Subject,
  rule: ExpandedAutoAssessmentRule,
  today: string,
): Promise<AutoAssessmentOutcome> {
  const key = { ruleId: rule.id, anchorId: subject.cycle.anchor.id, employeeId };
  try {
    const launched = await tx.transaction(async (savepoint) => {
      await assertNoCycleConflict(savepoint, ctx.tenantId, subject);
      const initiatorUserId = await resolveInitiator(savepoint, ctx.tenantId, rule, subject.departmentId, today);
      const assessment = await launchAssessment(
        savepoint,
        { ...ctx, userId: initiatorUserId },
        {
          employeeId,
          assessmentType: rule.assessmentType,
          assessmentName: rule.name,
          assessmentDate: today,
          initiation: 'auto',
        },
      );
      return { assessment, initiatorUserId };
    });
    await recordOutcome(tx, ctx, key, {
      assessmentId: launched.assessment.id,
      initiatorUserId: launched.initiatorUserId,
      reason: null,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorUserId: null,
      action: 'employment.auto_assessment.launch',
      objectType: 'probation-assessment',
      objectId: launched.assessment.id,
      before: null,
      after: {
        ruleId: rule.id,
        assessmentType: rule.assessmentType,
        initiatorUserId: launched.initiatorUserId,
        systemProxy: true,
      },
      commandId: ctx.commandId,
      occurredAt: ctx.now,
    });
    return {
      kind: 'launched',
      employeeId,
      ruleId: rule.id,
      assessmentId: launched.assessment.id,
      assessmentStatus: launched.assessment.status,
      initiatorUserId: launched.initiatorUserId,
    };
  } catch (error) {
    if (!(error instanceof AppError || error instanceof EmploymentError)) throw error;
    const reason = reasonOf(error);
    await recordOutcome(tx, ctx, key, { assessmentId: null, initiatorUserId: null, reason });
    return { kind: 'failed', employeeId, ruleId: rule.id, reason };
  }
}

/**
 * 一名员工：调用方已持该员工锁（立即执行等待、每日批次 SKIP LOCKED）。不适用 / 今天没有到期规则 / 到期规则都已发起返回空。
 * 同天到期的多条规则按优先级逐条办理、各自一条台账：先办的发起后，后面的经 PB-R20（本周期已有审批中的考核）记失败。
 * ctx 为系统上下文（userId 不用于发起）；发起时换成规则配置的发起人。
 */
export async function autoAssessEmployee(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  rules: readonly ExpandedAutoAssessmentRule[],
): Promise<AutoAssessmentOutcome[]> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  // F-223：规则快照只是提示，员工锁内按最新规则状态复核
  const due = await dueRulesOf(
    tx,
    ctx.tenantId,
    employeeId,
    await currentAutoAssessmentRules(tx, ctx.tenantId, rules, today),
    today,
  );
  if (!due) return [];
  const outcomes: AutoAssessmentOutcome[] = [];
  for (const rule of due.rules) outcomes.push(await launchByRule(tx, ctx, employeeId, due.subject, rule, today));
  return outcomes;
}

/** 把逐人结果收进回执（launched / failed 两列，按员工 ID 顺序）。 */
export function collectAutoAssessmentOutcomes(
  run: AutoAssessmentRun,
  outcomes: readonly AutoAssessmentOutcome[],
): void {
  for (const outcome of outcomes) {
    if (!outcome) continue;
    const { kind, ...item } = outcome;
    if (kind === 'launched') run.launched.push(item as AutoAssessmentLaunched);
    else run.failed.push(item as AutoAssessmentFailed);
  }
}

const RUN_PAGE = 200;
/** 立即执行的单次上限（同自动转正）：scan = 最多扫描的候选数，chunk = 最多办理的到期人数；到上限时回执带续跑句柄。 */
export const AUTO_ASSESSMENT_RUN_LIMITS = { scan: 2000, chunk: 100 };

/** 只读预筛：从游标之后按员工 ID 升序扫描，收集今天待发起的人；到扫描或办理上限即停，返回续跑游标。 */
async function scanDue(
  tx: Tx,
  tenantId: string,
  rules: readonly ExpandedAutoAssessmentRule[],
  today: string,
  cursor: string | null,
): Promise<{ readonly due: string[]; readonly nextCursor: string | null }> {
  const { scan, chunk } = AUTO_ASSESSMENT_RUN_LIMITS;
  const due: string[] = [];
  let scanned = 0;
  let last = cursor;
  for (;;) {
    const requested = Math.min(RUN_PAGE, scan - scanned);
    const page = await autoRegularizationCandidates(tx, tenantId, today, last, requested);
    for (const employeeId of page) {
      scanned += 1;
      last = employeeId;
      if (!(await dueRulesOf(tx, tenantId, employeeId, rules, today))) continue;
      due.push(employeeId);
      if (due.length >= chunk) return { due, nextCursor: employeeId };
    }
    if (page.length < requested) return { due, nextCursor: null };
    if (scanned >= scan) return { due, nextCursor: last };
  }
}

/**
 * “立即执行”（DEC-539①）：在请求事务内办理，结构同自动转正的立即执行——先只读预筛，再一次按全局顺序锁住本批全部联动参与者，
 * 然后逐人在锁内复核、在保存点内办理；与每日批次重叠时后取到锁的一方按发起台账复核，不重复发起。按规则的适用组织扫描，
 * 不叠加操作人的数据范围（回执由路由按操作人当前范围裁剪）；不占用当天的每日批次登记。
 */
export async function runAutoAssessmentNow(
  tx: Tx,
  ctx: EmploymentContext,
  cursorHandle: string | null = null,
): Promise<AutoAssessmentRun & { readonly nextCursor: string | null }> {
  if (!(await readAutoAssessmentEnabled(tx, ctx.tenantId)))
    throw new AppError('CONFLICT', '自动发起试用期考核未开启', { reason: 'AUTO_ASSESSMENT_DISABLED' });
  // 只带系统任务需要的键：请求方的授权器、配置对象编码与数据范围不进入发起（发起人由规则决定）
  const system: EmploymentContext = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    timezone: ctx.timezone,
    now: ctx.now,
    commandId: ctx.commandId,
    expectedRevision: 0,
  };
  const businessDate = tenantLocalDate(ctx.now, ctx.timezone);
  const run: AutoAssessmentRun = { businessDate, launched: [], failed: [] };
  const cursor = cursorHandle ? await cursorPosition(tx, ctx, businessDate, cursorHandle) : null;
  const rules = await loadEnabledAutoAssessmentRules(tx, ctx.tenantId, businessDate);
  if (!rules.length) return { ...run, nextCursor: null };
  const { due, nextCursor } = await scanDue(tx, ctx.tenantId, rules, businessDate, cursor);
  if (due.length) await lockTransferParticipants(tx, system, due[0]!, due.slice(1));
  for (const employeeId of due)
    collectAutoAssessmentOutcomes(run, await autoAssessEmployee(tx, system, employeeId, rules));
  return { ...run, nextCursor: nextCursor ? await issueCursor(tx, ctx, businessDate, nextCursor) : null };
}

/** 续跑句柄：回执只给随机 UUID，内部位置留在库里；只对签发它的租户 × 操作人 × 业务日有效，其余一律 400（不泄露别人的句柄）。 */
async function issueCursor(tx: Tx, ctx: EmploymentContext, businessDate: string, position: string) {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO employment_auto_assessment_run_cursors(id, tenant_id, user_id, business_date,
      position_employee_id, command_id, created_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${ctx.userId}::uuid, ${businessDate}::date, ${position}::uuid,
      ${ctx.commandId}, ${ctx.now.toISOString()}::timestamptz)`);
  return id;
}

async function cursorPosition(tx: Tx, ctx: EmploymentContext, businessDate: string, handle: string) {
  const [row] = rowsOf<{ position: string }>(
    await tx.execute(sql`SELECT position_employee_id::text AS position FROM employment_auto_assessment_run_cursors
      WHERE tenant_id=${ctx.tenantId} AND id=${handle}::uuid AND user_id=${ctx.userId}::uuid
        AND business_date=${businessDate}::date`),
  );
  if (!row)
    throw new AppError('VALIDATION_FAILED', '续跑游标无效或已过期，请重新执行', { reason: 'AUTO_RUN_CURSOR_INVALID' });
  return row.position;
}
