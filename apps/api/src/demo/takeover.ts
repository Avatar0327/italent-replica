/**
 * 种子台账与用户接管判定（DEC-477）：种子场景的单据上一旦出现任何不是种子自己发起的操作，就视为用户接管，种子此后永不再动
 * 这张单。判定不枚举“转交 / 加签 / 干预……”这类已知操作，而是反过来要求实例上的一切都能对上种子台账——对不上即接管，
 * 将来新增的操作类型自动生效。
 *
 * 种子台账 = 命令台账（command_ledger）里种子写入的确定性命令 ID，与业务写入同事务落库，种子中途被打断也不会丢：
 * - 发起：`demo-seed:<租户 ID>:DEMO-TRF-nn`（第 1 轮，transfers.scenarioCommandId）；
 * - 每一步：`demo-seed-step:DEMO-TRF-nn:r<轮次>:<操作>:<对象 ID>`，审批 / 驳回的对象是任务 ID，撤回的对象是实例 ID。
 * 命令台账按租户分区，所以步骤 ID 不再带租户（命令 ID 限 100 字符，commands.ts）。
 */
import { APP_ROLE, type Db, sql, type Tx, withTenant } from '@italent/db';

export type SeedAction = 'approve' | 'reject' | 'withdraw';

export interface LedgerStep {
  readonly action: SeedAction;
  readonly round: number;
  /** 审批 / 驳回：任务 ID；撤回：实例 ID。 */
  readonly targetId: string;
}

export interface SeedLedger {
  /** 台账里种子本场景的全部命令 ID（含发起）。 */
  readonly commandIds: ReadonlySet<string>;
  readonly steps: readonly LedgerStep[];
}

export interface ObservedTask {
  readonly id: string;
  readonly round: number;
  readonly status: string;
  readonly assigneeUserId: string | null;
  readonly origin: string;
  readonly parentTaskId: string | null;
}

export interface ObservedInstance {
  readonly id: string;
  readonly status: string;
  readonly round: number;
  readonly revision: number;
  readonly initiatorUserId: string;
}

/** 一张种子单据在库里的完整现状（全部轮次的日志与任务，不受详情接口“最近若干条”与记录隐藏的影响）。 */
export interface Observed {
  readonly instances: readonly ObservedInstance[];
  readonly tasks: readonly ObservedTask[];
  /** 审批日志：只取判定要用的列；actorUserId 为空的是流程引擎自动写的（分配、跳过、结束等）。 */
  readonly logs: readonly { round: number; taskId: string | null; actorUserId: string | null }[];
  /** 写到这张业务单或其审批实例上的全部审计事件的命令 ID（AGENTS §5：所有写操作都进统一变更日志）。 */
  readonly auditCommandIds: readonly (string | null)[];
  /** 业务单头：revision（业务单的任何写入都会推进）与被调动员工（写入路径的第一把锁）。 */
  readonly business: { readonly revision: number; readonly employeeId: string } | null;
  readonly ledger: SeedLedger;
}

const STEP_PREFIX = 'demo-seed-step:';

export const stepCommandId = (scenarioId: string, step: LedgerStep): string =>
  `${STEP_PREFIX}${scenarioId}:r${step.round}:${step.action}:${step.targetId}`;

const STEP_PATTERN = /^demo-seed-step:DEMO-TRF-\d+:r(\d+):(approve|reject|withdraw):([0-9a-f-]{36})$/;

function parseStep(commandId: string): LedgerStep | null {
  const match = STEP_PATTERN.exec(commandId);
  if (!match) return null;
  return { round: Number(match[1]), action: match[2] as SeedAction, targetId: match[3]! };
}

/**
 * 流程定义在节点激活时自动生成的任务来源（审批人解析、自审跳过、异常管理员兜底、同人 / 历史 / 无审批人自动处理、盲审、
 * 主体回避）。这是白名单：转交、加签、管理员转交 / 干预、交接、审批人撤回、会签重开以及将来任何新来源都不在其中，出现即接管。
 */
const DEFINITION_ORIGINS: ReadonlySet<string> = new Set([
  'resolved',
  'self_skip',
  'self_skip_manager',
  'exception_admin',
  'same_skip',
  'history_skip',
  'no_assignee_skip',
  'no_assignee_approve',
  'blind_review',
  'subject_skip',
]);

/** 种子各步留下的“人工”日志签名（轮次 | 任务 | 操作人）：发起与撤回由发起人写、不带任务，审批 / 驳回由该任务的审批人写。 */
function expectedHumanLogs(observed: Observed, initiator: string): Map<string, number> {
  const tasks = new Map(observed.tasks.map((task) => [task.id, task]));
  const keys = [`1|-|${initiator}`];
  for (const step of observed.ledger.steps) {
    if (step.action === 'withdraw') keys.push(`${step.round}|-|${initiator}`);
    else keys.push(`${step.round}|${step.targetId}|${tasks.get(step.targetId)?.assigneeUserId ?? '?'}`);
  }
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

const STEP_RESULT: Readonly<Record<'approve' | 'reject', string>> = { approve: 'approved', reject: 'rejected' };

/**
 * 接管判定：返回接管原因，对得上种子台账则返回 null。依次核对——
 * ① 只有一个审批实例，实例与全部日志 / 任务的轮次都在台账记过的轮次内（重提会增加轮次）；
 * ② 业务单与实例上的每条审计都出自种子台账里的命令（任何人、任何操作类型的写入都会留下自己的命令 ID）；
 * ③ 每条人工日志都对得上种子的一步（同一轮、同一任务、同一操作人，逐条抵消）；
 * ④ 种子处理过的任务保持种子给的结果；其余任务都是流程定义自动生成的，没有父任务（转交 / 加签会派生新任务）。
 */
export function takeoverReason(observed: Observed): string | null {
  const { instances, ledger } = observed;
  if (instances.length !== 1) return `审批实例数为 ${instances.length}`;
  const instance = instances[0]!;
  const rounds = new Set([1, ...ledger.steps.map((step) => step.round)]);
  const strayRound = [instance, ...observed.logs, ...observed.tasks].find((row) => !rounds.has(row.round));
  if (strayRound) return `出现台账外的轮次 ${strayRound.round}`;
  const strayCommand = observed.auditCommandIds.find((id) => id === null || !ledger.commandIds.has(id));
  if (strayCommand !== undefined) return `出现台账外的操作（命令 ${strayCommand ?? '无'}）`;
  const expected = expectedHumanLogs(observed, instance.initiatorUserId);
  for (const log of observed.logs) {
    if (log.actorUserId === null) continue;
    const key = `${log.round}|${log.taskId ?? '-'}|${log.actorUserId}`;
    const left = expected.get(key) ?? 0;
    if (left === 0) return `出现台账外的审批记录（操作人 ${log.actorUserId}）`;
    expected.set(key, left - 1);
  }
  const acted = new Map(ledger.steps.filter((step) => step.action !== 'withdraw').map((s) => [s.targetId, s.action]));
  for (const task of observed.tasks) {
    const action = acted.get(task.id) as 'approve' | 'reject' | undefined;
    if (action) {
      if (task.status !== STEP_RESULT[action]) return `种子处理过的任务被改为 ${task.status}`;
    } else if (task.parentTaskId !== null || !DEFINITION_ORIGINS.has(task.origin)) {
      return `出现台账外的任务（来源 ${task.origin}）`;
    }
  }
  return null;
}

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

/** 只读观测：直接读本租户的库（RLS 限定租户），取全部轮次的日志、任务、审计与种子台账。 */
export async function observe(
  db: Db,
  tenantId: string,
  scenarioId: string,
  createCommandId: string,
  businessId: string,
): Promise<Observed> {
  return withTenant(db, tenantId, (tx) => observeIn(tx, scenarioId, createCommandId, businessId));
}

async function observeIn(tx: Tx, scenarioId: string, createCommandId: string, businessId: string): Promise<Observed> {
  const query = async <T>(statement: ReturnType<typeof sql>) => rowsOf<T>(await tx.execute(statement));
  const instances = await query<ObservedInstance>(
    sql`SELECT id, status, round, revision, initiator_user_id AS "initiatorUserId" FROM approval_instances
      WHERE business_id = ${businessId}::uuid ORDER BY created_at, id`,
  );
  const ids = `{${instances.map((row) => row.id).join(',')}}`;
  const tasks = await query<ObservedTask>(
    sql`SELECT id, round, status, assignee_user_id AS "assigneeUserId", origin, parent_task_id AS "parentTaskId"
      FROM approval_tasks WHERE instance_id = ANY(${ids}::uuid[]) ORDER BY instance_id, seq`,
  );
  const logs = await query<Observed['logs'][number]>(
    sql`SELECT round, task_id AS "taskId", actor_user_id AS "actorUserId" FROM approval_instance_logs
      WHERE instance_id = ANY(${ids}::uuid[]) ORDER BY instance_id, seq`,
  );
  const audits = await query<{ commandId: string | null }>(
    sql`SELECT command_id AS "commandId" FROM audit_events
      WHERE object_id = ${businessId} OR object_id = ANY(${ids}::text[]) ORDER BY occurred_at, id`,
  );
  const [business] = await query<{ revision: number; employeeId: string }>(
    sql`SELECT revision, employee_id AS "employeeId" FROM employment_business_objects WHERE id = ${businessId}::uuid`,
  );
  const ledgerIds = await query<{ commandId: string }>(
    sql`SELECT command_id AS "commandId" FROM command_ledger
      WHERE command_id = ${createCommandId} OR command_id LIKE ${`${STEP_PREFIX}${scenarioId}:%`}
      ORDER BY command_id`,
  );
  const commandIds = new Set(ledgerIds.map((row) => row.commandId));
  const steps = [...commandIds].map(parseStep).filter((step): step is LedgerStep => step !== null);
  return {
    instances,
    tasks,
    logs,
    auditCommandIds: audits.map((row) => row.commandId),
    business: business ?? null,
    ledger: { commandIds, steps },
  };
}

/** 观测结果的稳定指纹：任一行、任一列有变化（含新增日志、审计、台账、任务与 revision）指纹就不同。 */
export function fingerprint(observed: Observed): string {
  return JSON.stringify({ ...observed, ledger: [...observed.ledger.commandIds].sort() });
}

/**
 * 写入事务里的接管复核（#309 第 5 轮）：在种子写入所在的同一事务开头，按业务写路径的锁序先锁被调动员工行
 * （transfer-locks.lockTransferParticipants 的第一把锁，审批 / 业务单的一切写入都先取它），再锁审批实例行，
 * 然后重新观测。与判定时的指纹一致才放行：说明判定之后没有任何台账外的写入，且锁一直持有到种子的写入提交，
 * 用户操作要么在复核前已可见、要么排在种子写入之后。本步命令 ID 已在台账里，说明本步已经提交，同一请求之后的
 * 读取事务（如返回详情）直接放行。
 */
export async function recheckLocked(
  tx: Tx,
  tenantId: string,
  decided: {
    readonly scenarioId: string;
    readonly createCommandId: string;
    readonly businessId: string;
    readonly stepCommandId: string;
  },
  expected: string,
): Promise<boolean> {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
  await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
  await tx.execute(sql`SELECT e.id FROM employment_employees e JOIN employment_business_objects b
    ON b.tenant_id = e.tenant_id AND b.employee_id = e.id WHERE b.id = ${decided.businessId}::uuid
    FOR NO KEY UPDATE OF e`);
  await tx.execute(sql`SELECT id FROM approval_instances WHERE business_id = ${decided.businessId}::uuid
    ORDER BY created_at, id FOR UPDATE`);
  const now = await observeIn(tx, decided.scenarioId, decided.createCommandId, decided.businessId);
  return now.ledger.commandIds.has(decided.stepCommandId) || fingerprint(now) === expected;
}
