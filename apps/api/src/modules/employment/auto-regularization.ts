/**
 * R2 BE-15a 自动转正的执行（docs/02_业务建模/29 PB-R18 / R19 / R21 / R22；差距表 B57、补证结论 R2e7；DEC-539①）。
 * - 适用对象（PB-R19）：当前生效主职为试用、内部员工，本任职周期有预计试用结束日，命中启用中的规则（优先级最小者）；
 * - 触发（R2e7，03 口径）：目标日 = 预计结束日 − N 天，目标日 ≤ 当天即发起（补发）；同一任职同一规则只发起一次——
 *   发起台账（规则 × 本任职周期的开启记录）在员工锁内复核，主键兜底；
 * - 失败（PB-R21）：本周期已有已驳回 / 不通过 / 作废 / 审批中 / 通过 / 生效的转正业务，发起人找不到，或转正入口拒绝
 *   （PB-R9 互斥、试用结果已停用等）——整人回滚到保存点，台账记 failed、次数与原因，下一次执行重试（DEC-052）；
 * - 发起：经 BE-3 的单一入口 launchRegularization（默认转正日期 = 预计结束日次日，F-205；申请走同一提交与审批发起），
 *   发起人取规则配置，审批日志与台账带“系统代发”标记（R2e7 第 4 条）。
 */
import { sql, type Tx } from '@italent/db';
import {
  AUTO_REGULARIZATION_BLOCKING_STATES,
  autoRegularizationTargetDate,
  EMPLOYEE_STATUS,
  matchAutoRegularizationRule,
  tenantLocalDate,
} from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { EmploymentError } from './errors.js';
import {
  loadEnabledAutoRegularizationRules,
  readAutoRegularizationEnabled,
  type ExpandedAutoRegularizationRule,
} from './auto-regularization-rules.js';
import { loadProbationCycle, type ProbationCycle } from './probation.js';
import { findCurrentRecord } from './read-model.js';
import { rowsOf } from './record-store.js';
import { launchRegularization } from './regularization.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';

export interface AutoRegularizationLaunched {
  readonly employeeId: string;
  readonly ruleId: string;
  readonly businessId: string;
  readonly businessStatus: string;
  readonly initiatorUserId: string;
}

export interface AutoRegularizationFailed {
  readonly employeeId: string;
  readonly ruleId: string;
  readonly reason: string;
}

export type AutoRegularizationOutcome =
  | ({ readonly kind: 'launched' } & AutoRegularizationLaunched)
  | ({ readonly kind: 'failed' } & AutoRegularizationFailed)
  | null;

export interface AutoRegularizationRun {
  readonly businessDate: string;
  readonly launched: AutoRegularizationLaunched[];
  readonly failed: AutoRegularizationFailed[];
}

const kinds = (list: readonly string[]) =>
  sql.join(
    list.map((item) => sql`${item}`),
    sql`, `,
  );

/** 当天主职为试用状态的员工（候选，员工 ID 升序分页）；是否命中、是否到期在员工锁内逐人判定。 */
export async function autoRegularizationCandidates(
  tx: Tx,
  tenantId: string,
  today: string,
  cursor: string | null,
  limit: number,
): Promise<string[]> {
  const rows = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT DISTINCT cr.employee_id::text AS "employeeId" FROM employment_timeline cur
      JOIN employment_records cr ON cr.tenant_id=cur.tenant_id AND cr.id=cur.record_id
      LEFT JOIN LATERAL employment_record_status(cr.tenant_id, cr.id) st ON true
      WHERE cur.tenant_id=${tenantId} AND cur.valid_during @> ${today}::date
        AND st.employee_status=${EMPLOYEE_STATUS.probation}
        AND (${cursor}::uuid IS NULL OR cr.employee_id>${cursor}::uuid)
      ORDER BY 1 LIMIT ${limit}`),
  );
  return rows.map((row) => row.employeeId);
}

interface Subject {
  readonly cycle: ProbationCycle;
  readonly expectedEndDate: string;
  readonly departmentId: string | null;
}

/** PB-R19：当前生效主职为试用、内部员工、有预计试用结束日；否则不是适用对象（不记失败）。 */
async function subjectOf(tx: Tx, tenantId: string, employeeId: string, today: string): Promise<Subject | null> {
  const cycle = await loadProbationCycle(tx, tenantId, employeeId, today);
  if (!cycle?.info.hasProbation || !cycle.info.expectedEndDate) return null;
  const current = await findCurrentRecord(tx, tenantId, employeeId, today);
  if (!current || current.fields.employType !== 'internal') return null;
  const [status] = rowsOf<{ status: number }>(
    await tx.execute(sql`SELECT employee_status::integer AS status
      FROM employment_record_status(${tenantId}, ${current.id}::uuid)`),
  );
  if (status?.status !== EMPLOYEE_STATUS.probation) return null;
  return { cycle, expectedEndDate: cycle.info.expectedEndDate, departmentId: current.fields.departmentId ?? null };
}

async function launchedBefore(tx: Tx, tenantId: string, ruleId: string, anchorId: string): Promise<boolean> {
  const [row] = rowsOf<{ state: string }>(
    await tx.execute(sql`SELECT state FROM employment_auto_regularization_launches
      WHERE tenant_id=${tenantId} AND rule_id=${ruleId}::uuid AND anchor_id=${anchorId}::uuid`),
  );
  return row?.state === 'launched';
}

/** PB-R21（转正记录部分）：本任职周期里处于阻断状态的转正业务。 */
async function assertNoCycleRegularization(tx: Tx, tenantId: string, subject: Subject) {
  const { employeeId, staffId } = subject.cycle.anchor;
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT b.id FROM employment_business_objects b
      JOIN LATERAL (SELECT p.kind, p.selected_staff_id FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
        AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT s.state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
        AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
      LEFT JOIN employment_records rg ON rg.tenant_id=b.tenant_id AND rg.id=b.id
      WHERE b.tenant_id=${tenantId} AND b.employee_id=${employeeId}::uuid AND p.kind='regularization'
        AND s.state IN (${kinds(AUTO_REGULARIZATION_BLOCKING_STATES)})
        AND COALESCE(rg.staff_id, p.selected_staff_id)=${staffId}::uuid
      LIMIT 1`),
  );
  if (row)
    throw new AppError('CONFLICT', '本任职周期已有转正记录，不能自动转正', {
      reason: 'REGULARIZATION_EXISTS',
      businessId: row.id,
    });
}

/** 有效账号（本租户成员关系有效、全局账号未停用），同审批中心 userOfPerson 的口径；人员没有账号为空。 */
async function activeUser(tx: Tx, tenantId: string, condition: ReturnType<typeof sql>): Promise<string | null> {
  const [row] = rowsOf<{ userId: string }>(
    await tx.execute(sql`SELECT m.user_id::text AS "userId" FROM tenant_memberships m
      WHERE m.tenant_id=${tenantId} AND m.status='active' AND tenant_account_active(m.user_id) AND ${condition}
      LIMIT 1`),
  );
  return row?.userId ?? null;
}

/** 发起人（R2e6 / R2e7）：当前管理员 = 规则保存人；按身份取主职部门当天组织版本上的 HRBP / 负责人的账号。 */
async function resolveInitiator(
  tx: Tx,
  tenantId: string,
  rule: ExpandedAutoRegularizationRule,
  departmentId: string | null,
  today: string,
): Promise<string> {
  let userId: string | null = null;
  if (rule.initiatorType === 'rule_operator') {
    userId = await activeUser(tx, tenantId, sql`m.user_id=${rule.operatorUserId}::uuid`);
  } else if (departmentId) {
    const column = rule.initiatorType === 'department_hrbp' ? sql`hrbp_id` : sql`person_in_charge_id`;
    const [org] = rowsOf<{ personId: string | null }>(
      await tx.execute(sql`SELECT ${column}::text AS "personId" FROM org_versions
        WHERE tenant_id=${tenantId} AND org_id=${departmentId}::uuid AND start_date<=${today}::date
        ORDER BY start_date DESC, version_no DESC LIMIT 1`),
    );
    if (org?.personId)
      userId = await activeUser(
        tx,
        tenantId,
        sql`EXISTS (SELECT 1 FROM permission_user_person_links l WHERE l.tenant_id=m.tenant_id
          AND l.user_id=m.user_id AND l.employee_id=${org.personId}::uuid)`,
      );
  }
  if (!userId)
    throw new AppError('CONFLICT', '找不到规则配置的发起人', {
      reason: 'INITIATOR_NOT_FOUND',
      initiatorType: rule.initiatorType,
    });
  return userId;
}

async function recordOutcome(
  tx: Tx,
  ctx: EmploymentContext,
  key: { readonly ruleId: string; readonly anchorId: string; readonly employeeId: string },
  outcome: {
    readonly businessId: string | null;
    readonly initiatorUserId: string | null;
    readonly reason: string | null;
  },
) {
  const now = ctx.now.toISOString();
  const state = outcome.businessId ? 'launched' : 'failed';
  // launched 只写一次：已发起的行不再更新（WHERE 条件），failed 行累计次数
  await tx.execute(sql`INSERT INTO employment_auto_regularization_launches AS l(tenant_id, rule_id, anchor_id,
      employee_id, state, business_id, initiator_user_id, system_proxy, attempts, last_reason, command_id,
      created_at, updated_at)
    VALUES (${ctx.tenantId}, ${key.ruleId}::uuid, ${key.anchorId}::uuid, ${key.employeeId}::uuid, ${state},
      ${outcome.businessId}::uuid, ${outcome.initiatorUserId}::uuid, true, 1, ${outcome.reason}, ${ctx.commandId},
      ${now}::timestamptz, ${now}::timestamptz)
    ON CONFLICT (tenant_id, rule_id, anchor_id) DO UPDATE SET state=EXCLUDED.state, business_id=EXCLUDED.business_id,
      initiator_user_id=EXCLUDED.initiator_user_id, attempts=l.attempts + 1, last_reason=EXCLUDED.last_reason,
      command_id=EXCLUDED.command_id, updated_at=EXCLUDED.updated_at
    WHERE l.state='failed'`);
}

function reasonOf(error: AppError | EmploymentError): string {
  const details = (error as { details?: unknown }).details;
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' ? reason : error.code;
}

/**
 * 一名员工：调用方已持该员工锁（立即执行等待、每日批次 SKIP LOCKED）。不适用 / 未到期 / 已由该规则发起返回 null。
 * ctx 为系统上下文（userId 不用于发起）；发起时换成规则配置的发起人并带 systemProxy。
 */
export async function autoRegularizeEmployee(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  rules: readonly ExpandedAutoRegularizationRule[],
): Promise<AutoRegularizationOutcome> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const subject = await subjectOf(tx, ctx.tenantId, employeeId, today);
  if (!subject) return null;
  const rule = matchAutoRegularizationRule(rules, subject.departmentId);
  if (!rule || autoRegularizationTargetDate(subject.expectedEndDate, rule.daysBefore) > today) return null;
  const key = { ruleId: rule.id, anchorId: subject.cycle.anchor.id, employeeId };
  if (await launchedBefore(tx, ctx.tenantId, rule.id, key.anchorId)) return null;
  try {
    const launched = await tx.transaction(async (savepoint) => {
      await assertNoCycleRegularization(savepoint, ctx.tenantId, subject);
      const initiatorUserId = await resolveInitiator(savepoint, ctx.tenantId, rule, subject.departmentId, today);
      const [employee] = rowsOf<{ revision: number }>(
        await savepoint.execute(sql`SELECT revision FROM employment_employees
          WHERE tenant_id=${ctx.tenantId} AND id=${employeeId}::uuid`),
      );
      const business = await launchRegularization(
        savepoint,
        { ...ctx, userId: initiatorUserId, expectedRevision: employee!.revision, systemProxy: true },
        employeeId,
        { kind: 'regularization', mode: rule.mode, probationResult: rule.probationResult },
      );
      return { business, initiatorUserId };
    });
    await recordOutcome(tx, ctx, key, {
      businessId: launched.business.id,
      initiatorUserId: launched.initiatorUserId,
      reason: null,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorUserId: null,
      action: 'employment.auto_regularization.launch',
      objectType: 'employment-business',
      objectId: launched.business.id,
      before: null,
      after: { ruleId: rule.id, mode: rule.mode, initiatorUserId: launched.initiatorUserId, systemProxy: true },
      commandId: ctx.commandId,
      occurredAt: ctx.now,
    });
    return {
      kind: 'launched',
      employeeId,
      ruleId: rule.id,
      businessId: launched.business.id,
      businessStatus: launched.business.status,
      initiatorUserId: launched.initiatorUserId,
    };
  } catch (error) {
    if (!(error instanceof AppError || error instanceof EmploymentError)) throw error;
    const reason = reasonOf(error);
    await recordOutcome(tx, ctx, key, { businessId: null, initiatorUserId: null, reason });
    return { kind: 'failed', employeeId, ruleId: rule.id, reason };
  }
}

/** 把逐人结果收进回执（launched / failed 两列，按员工 ID 顺序）。 */
export function collectOutcome(run: AutoRegularizationRun, outcome: AutoRegularizationOutcome): void {
  if (!outcome) return;
  const { kind, ...item } = outcome;
  if (kind === 'launched') run.launched.push(item as AutoRegularizationLaunched);
  else run.failed.push(item as AutoRegularizationFailed);
}

const RUN_PAGE = 200;
/** 立即执行单次处理的候选上限；超出的人由下一次执行（每日批次或再次立即执行）接着处理。 */
export const AUTO_REGULARIZATION_RUN_LIMIT = 2000;

/**
 * “立即执行”（DEC-539①）：在请求事务内按员工 ID 升序逐人取锁（等待，不跳过）、逐人保存点办理，同 BE-3 批量转正的锁序；
 * 与每日批次重叠时，后取到锁的一方按发起台账复核，不重复发起。按规则的适用组织扫描，不叠加操作人的数据范围（系统批次提前执行）。
 * 不占用当天的每日批次登记：当天批次照常跑，已发起的人在台账上跳过。
 */
export async function runAutoRegularizationNow(
  tx: Tx,
  ctx: EmploymentContext,
): Promise<AutoRegularizationRun & { readonly hasMore: boolean }> {
  if (!(await readAutoRegularizationEnabled(tx, ctx.tenantId)))
    throw new AppError('CONFLICT', '自动转正未开启', { reason: 'AUTO_REGULARIZATION_DISABLED' });
  const system: EmploymentContext = { ...ctx, scope: undefined, expectedRevision: 0 };
  const businessDate = tenantLocalDate(ctx.now, ctx.timezone);
  const run: AutoRegularizationRun = { businessDate, launched: [], failed: [] };
  const rules = await loadEnabledAutoRegularizationRules(tx, ctx.tenantId, businessDate);
  if (!rules.length) return { ...run, hasMore: false };
  let cursor: string | null = null;
  for (let seen = 0; seen < AUTO_REGULARIZATION_RUN_LIMIT;) {
    const page = await autoRegularizationCandidates(tx, ctx.tenantId, businessDate, cursor, RUN_PAGE);
    for (const employeeId of page.slice(0, AUTO_REGULARIZATION_RUN_LIMIT - seen)) {
      await lockTransferParticipants(tx, system, employeeId);
      collectOutcome(run, await autoRegularizeEmployee(tx, system, employeeId, rules));
      seen += 1;
      cursor = employeeId;
    }
    if (page.length < RUN_PAGE) return { ...run, hasMore: false };
  }
  return { ...run, hasMore: true };
}
