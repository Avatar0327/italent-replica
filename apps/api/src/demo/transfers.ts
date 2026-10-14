/**
 * 演示调动流程与调动单：在途 6、已完成 6、驳回 2、撤回 1，分别由员工自助、经理、HR 按真实流程发起，
 * 由演示身份（经理、HR、异常管理员）逐节点审批。每个场景用确定性命令 ID 发起、逐步推进，全部记入种子台账（takeover.ts）；
 * 重复运行时按台账认领本场景的单子并续做到目标状态，不重复发起。单据上一旦出现种子台账外的操作，即视为用户接管，
 * 种子此后永不再动这张单（DEC-477）；要回到干净的演示数据用 pnpm demo:reset，重跑种子不复原被接管的单据。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { TRANSFER_FORM_FIELDS } from '@italent/domain';
import { type DemoClock, type Json, listAll } from './client.js';
import { DEMO_TRANSFER_PROCESS_CODE, type OrgKey } from './data.js';
import { transferSubjects } from './scale-data.js';
import type { SeedProgress } from './progress.js';
import {
  fingerprint,
  type Observed,
  type ObservedInstance,
  observe,
  recheckLocked,
  type SeedAction,
  stepCommandId,
  takeoverReason,
} from './takeover.js';
import type { DemoWorld } from './world.js';

const BASE = '/api/tenant';

type End = 'pending' | 'effective' | 'reject' | 'withdraw';
export interface Scenario {
  /** DEMO-TRF-nn：仅用于日志与进度。 */
  readonly id: string;
  readonly via: 'self' | 'manager' | 'hr';
  /** 被调动人：演示身份 key，或 [直属研发部, 序号] 指向的生成员工。 */
  readonly subject: string | readonly [OrgKey, number];
  /** 发起人（演示身份 key）；本人发起时即被调动人。 */
  readonly actor?: string;
  /** 调往的组织。 */
  readonly target: OrgKey;
  /** 提交距今天数：已完成的调动按这个历史日期提交、生效；其余是提交了几天的在途 / 驳回 / 撤回单。 */
  readonly daysAgo: number;
  /** 先同意的节点数，之后按 end 收尾。 */
  readonly approvals: number;
  readonly end: End;
}

type Subject = Scenario['subject'];
type Row = readonly [Scenario['via'], Subject, OrgKey, string | null, number, number, End];

/**
 * 15 张调动单。审批节点：① 被调动人所在部门负责人（平台 / 数据研发部 = 演示经理）→ ② 调入部门 HRBP（= HR 专员）。
 * 两个节点都开启自审回避：经理给自己部门的员工发起、HR 自己发起时，本人节点自审跳过，转异常管理员。
 * 异常管理员没有任职记录字段的查看权限，无法审批（盲审限制），所以停在这个节点的单只能是在途单；已完成的 6 张
 * 都由员工本人发起、走经理 → HR 两个节点。
 * 行：[入口, 被调动人, 调往组织, 发起人（经理 / HR 入口）, 提交距今天数, 先同意的节点数, 收尾]。
 */
const ROWS: readonly Row[] = [
  // 在途 6：停在不同审批步
  ['self', 'employeeB', 'frontend', null, 1, 0, 'pending'], // 经理待办
  ['self', ['platform', 0], 'backend', null, 2, 1, 'pending'], // HR 待办（第二节点）
  ['self', 'auditor', 'finance', null, 3, 0, 'pending'], // 财务部负责人待办（部门不变，职位随部门）
  ['manager', ['platform', 1], 'infra', 'platformManager', 1, 0, 'pending'], // 自审跳过 → 异常管理员
  ['manager', ['data', 0], 'algo', 'dataManager', 2, 0, 'pending'], // 自审跳过 → 异常管理员
  ['self', 'employeeC', 'dataplat', null, 1, 0, 'pending'], // 经理待办
  // 已完成 6：员工本人发起，经理 → HR 通过，按历史日期生效
  ['self', ['platform', 2], 'pm', null, 120, 2, 'effective'],
  ['self', ['data', 1], 'design', null, 95, 2, 'effective'],
  ['self', ['platform', 3], 'frontend', null, 70, 2, 'effective'],
  ['self', ['data', 2], 'dataplat', null, 55, 2, 'effective'],
  ['self', ['platform', 4], 'backend', null, 40, 2, 'effective'],
  ['self', ['data', 3], 'algo', null, 25, 2, 'effective'],
  // 驳回 2、撤回 1
  ['self', 'employeeA', 'data', null, 5, 0, 'reject'], // 经理驳回
  ['hr', ['platform', 5], 'recruit', 'hr', 4, 0, 'reject'], // 经理驳回
  ['hr', ['data', 4], 'product', 'hr', 6, 0, 'withdraw'], // HR 撤回
];

export const DEMO_TRANSFERS: readonly Scenario[] = ROWS.map(
  ([via, subject, target, actor, daysAgo, approvals, end], index) => ({
    id: `DEMO-TRF-${String(index + 1).padStart(2, '0')}`,
    via,
    subject,
    ...(actor ? { actor } : {}),
    target,
    daysAgo,
    approvals,
    end,
  }),
);

const dayOffset = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** 场景的结果：走到了目标状态，或被用户接管（DEC-477，此后永久跳过）。 */
type Outcome = { readonly kind: 'completed' } | { readonly kind: 'takenOver'; readonly reason: string };

export async function seedTransfers(world: DemoWorld, clock: DemoClock, progress?: SeedProgress): Promise<void> {
  const done = new Set([
    ...((await progress?.completedTransfers(world.tenantId)) ?? []),
    ...((await progress?.takenOverTransfers(world.tenantId)) ?? []),
  ]);
  // 全部场景都已完成或被用户接管：整体跳过，后续启动不碰用户已经在操作的调动单
  if (DEMO_TRANSFERS.every((scenario) => done.has(scenario.id))) return;
  await publishTransferProcess(world);
  for (const scenario of DEMO_TRANSFERS) {
    if (done.has(scenario.id)) continue;
    clock.setDay(null);
    const today = clock.now().toISOString().slice(0, 10);
    // 业务日期按租户时区：北京时间上午 10:00 的时钟与 UTC 同日
    const day = dayOffset(today, -scenario.daysAgo);
    clock.setDay(day);
    let outcome: Outcome;
    try {
      outcome = await runScenario(world, scenario, day);
    } catch (error) {
      throw new Error(`${scenario.id}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clock.setDay(null);
    }
    if (outcome.kind === 'completed') await progress?.markTransferCompleted(world.tenantId, scenario.id);
    else await progress?.markTransferTakenOver(world.tenantId, scenario.id);
  }
}

/** 被调动人的员工 ID、账号（本人发起或需要读取时）。 */
async function subjectOf(world: DemoWorld, scenario: Scenario) {
  const key = scenario.subject;
  if (typeof key === 'string') {
    return { employeeId: world.employees.get(key)!, userId: world.accounts.get(key)!, email: undefined };
  }
  const staff = transferSubjects(key[0])[key[1]]!;
  return { employeeId: world.employees.get(staff.code)!, userId: await world.lookup(staff.email), email: staff.email };
}

const INITIATOR = { self: 'employee', manager: 'manager', hr: 'hr' } as const;
/**
 * 场景的确定性命令 ID（Idempotency-Key）：命令台账里持久、按租户唯一，是“这张单子由种子的本场景发起”的关联。
 * 没有用备注当标记：员工本人入口不允许编辑备注（403），三种入口得用同一种办法。
 */
export const scenarioCommandId = (tenantId: string, scenario: Scenario): string =>
  `demo-seed:${tenantId}:${scenario.id}`;

async function runScenario(world: DemoWorld, scenario: Scenario, day: string): Promise<Outcome> {
  const subject = await subjectOf(world, scenario);
  const actor = scenario.via === 'self' ? subject.userId : world.accounts.get(scenario.actor!)!;
  let businessId = await claimedTransfer(world.db, world.tenantId, subject.employeeId, scenario);
  if (!businessId) {
    businessId = await create(world, scenario, subject, actor, day);
    await world.wrote('transfers', scenario.id);
  }
  return advance(world, scenario, businessId, actor);
}

/**
 * 本场景已发起的调动单：命令台账里查本场景的确定性命令 ID，再核对被调动人与发起入口。用户自己提交的申请（随机命令 ID）
 * 一律不认领，也不计入种子。
 */
async function claimedTransfer(db: Db, tenantId: string, employeeId: string, scenario: Scenario) {
  const rows = await withTenant(db, tenantId, async (tx) =>
    tx.execute(sql`SELECT tr.business_id AS id FROM command_ledger cl
      JOIN transfer_requests tr ON tr.tenant_id = cl.tenant_id AND tr.business_id = (cl.response_body->>'id')::uuid
      WHERE cl.tenant_id = ${tenantId} AND cl.command_id = ${scenarioCommandId(tenantId, scenario)}
        AND tr.employee_id = ${employeeId}::uuid AND tr.initiator = ${INITIATOR[scenario.via]} LIMIT 1`),
  );
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { id: string }[];
  return list[0]?.id ?? null;
}

async function create(
  world: DemoWorld,
  scenario: Scenario,
  subject: { employeeId: string; userId: string },
  actor: string,
  day: string,
): Promise<string> {
  // 已完成的调动当天生效；其余单子的生效日都在以后
  const effectiveDate = scenario.end === 'effective' ? day : dayOffset(day, 14 + scenario.daysAgo);
  const fields = { departmentId: world.orgs.get(scenario.target)!.id };
  const commandId = scenarioCommandId(world.tenantId, scenario);
  const base = '/api/tenant';
  if (scenario.via === 'self') {
    const profile = (await world.call(actor, 'GET', `${base}/self-service/profile`)) as { employee: Json };
    const saved = await world.call(
      actor,
      'POST',
      `${base}/self-service/transfer`,
      { effectiveDate, fields },
      Number(profile.employee.revision),
      commandId,
    );
    return String(saved.id);
  }
  const employee = await world.call(world.admin, 'GET', `${base}/employment/employees/${subject.employeeId}`);
  const hr = scenario.via === 'hr';
  const saved = await world.call(
    actor,
    'POST',
    `${base}/employment/transfers/employees/${subject.employeeId}`,
    {
      initiator: scenario.via,
      transferTypeCode: hr ? 'cross_department' : 'in_department',
      ...(hr ? {} : { formId: 'TenantBase.TransferMultiFormView' }),
      mode: 'application',
      submit: true,
      effectiveDate,
      fields,
    },
    Number(employee.revision),
    commandId,
  );
  return String(saved.id);
}

type Decision =
  | { readonly kind: 'takeover'; readonly reason: string }
  | { readonly kind: 'done' }
  | { readonly kind: 'act'; readonly action: SeedAction; readonly taskId: string; readonly instance: ObservedInstance };

/**
 * 种子推进的唯一入口（DEC-477）：先做接管判定——实例上有任何对不上种子台账的操作或任务结构变化，就返回 takeover，
 * 种子此后永不再动这张单；对得上才按台账里种子已走的步数决定下一步：审批数不足预设就审批当前待办，恰好达到预设就按收尾
 * 驳回 / 撤回，其余（流程已结束、业务单不在审批中、没有唯一待办）都是 done。审批、驳回、撤回三类动作只能经这里决定。
 */
export function nextSeedAction(
  scenario: Pick<Scenario, 'approvals' | 'end'>,
  observed: Observed,
  businessStatus: string,
): Decision {
  const reason = takeoverReason(observed);
  if (reason) return { kind: 'takeover', reason };
  const instance = observed.instances[0]!;
  const steps = observed.ledger.steps;
  if (instance.status !== 'running' || businessStatus !== 'in_review') return { kind: 'done' };
  if (steps.some((step) => step.action !== 'approve')) return { kind: 'done' };
  const pending = observed.tasks.filter((task) => task.status === 'pending');
  if (pending.length !== 1) return { kind: 'done' };
  const approved = steps.length;
  const act = (action: SeedAction): Decision => ({ kind: 'act', action, taskId: pending[0]!.id, instance });
  if (approved < scenario.approvals) return act('approve');
  if (approved > scenario.approvals) return { kind: 'done' };
  if (scenario.end === 'reject') return act('reject');
  if (scenario.end === 'withdraw') return act('withdraw');
  return { kind: 'done' };
}

/**
 * 按种子台账续做，直到 nextSeedAction 给出 done / takeover。每一步都用确定性命令 ID（takeover.stepCommandId）提交，
 * 与业务写入同事务记入种子台账；中途被打断时这一步要么整体没发生、要么连同台账一起落库，续跑据此接着判定。
 * 写入一律经 world.guarded：同一事务里先加锁复核“判定之后没有任何变化”，再执行写入（#309 第 5 轮，见 protectedStep）。
 */
async function advance(world: DemoWorld, scenario: Scenario, businessId: string, initiator: string): Promise<Outcome> {
  const createCommandId = scenarioCommandId(world.tenantId, scenario);
  for (;;) {
    const observed = await observe(world.db, world.tenantId, scenario.id, createCommandId, businessId);
    // 员工本人入口的发起人读不到业务单，读取用系统管理员（演示里看全部）
    const business = await world.call(world.admin, 'GET', `${BASE}/employment/businesses/${businessId}`);
    const next = nextSeedAction(scenario, observed, String(business.status));
    if (next.kind === 'takeover') return { kind: 'takenOver', reason: next.reason };
    if (next.kind === 'done') return { kind: 'completed' };
    const { action, taskId, instance } = next;
    const targetId = action === 'withdraw' ? instance.id : taskId;
    const commandId = stepCommandId(scenario.id, { action, round: instance.round, targetId });
    const decided = { scenarioId: scenario.id, createCommandId, businessId, stepCommandId: commandId };
    const expected = fingerprint(observed);
    const written = await world.guarded(
      (tx) => recheckLocked(tx, world.tenantId, decided, expected),
      () => {
        const context = { observed, businessId, businessRevision: Number(business.revision), initiator, commandId };
        return protectedStep(world, next, context);
      },
    );
    if (!written.ok) return { kind: 'takenOver', reason: '判定之后、写入之前出现台账外的操作' };
    await world.wrote('transfers', `${scenario.id}:${action}`);
  }
}

/**
 * 种子改变调动单据状态的唯一写入口：审批、驳回、撤回三类动作都只由 nextSeedAction 决定、只在这里发出，且只在
 * world.guarded 的复核事务里执行。撤回走业务单接口（带业务单 revision），审批 / 驳回走任务接口（带实例 revision）；
 * 两者都由 recheckLocked 在同一事务里先确认实例、任务、日志、审计、台账与业务单 revision 都没变。
 */
async function protectedStep(
  world: DemoWorld,
  next: Extract<Decision, { kind: 'act' }>,
  context: { observed: Observed; businessId: string; businessRevision: number; initiator: string; commandId: string },
): Promise<void> {
  const { action, taskId, instance } = next;
  const { commandId } = context;
  if (action === 'withdraw') {
    // 发起人（HR）撤回在途申请 → 业务单回到草稿（普通员工没有“撤回”按钮，所以撤回单由 HR 发起）
    const path = `${BASE}/employment/businesses/${context.businessId}/withdraw`;
    await world.call(context.initiator, 'POST', path, {}, context.businessRevision, commandId);
    return;
  }
  const assignee = context.observed.tasks.find((task) => task.id === taskId)!.assigneeUserId!;
  const comment = action === 'reject' ? '演示：信息不全，请补充后重新提交' : undefined;
  await world.call(
    assignee,
    'POST',
    `${BASE}/approval/tasks/${taskId}/${action}`,
    { comment },
    instance.revision,
    commandId,
  );
}

/**
 * 演示调动流程：直接上级审批 → 调入部门 HRBP 审核。复刻首版没有“直接上级”审批人表达式（REQ-APV-002），
 * 与预置离职流程相同，用“最新任职记录部门负责人”近似（DEC-230，表达式待 F-028）；演示数据里员工的直线经理即部门负责人。
 * 优先级 -1 先于出厂预置的标准调动流程（同为 TransferProcessNew 发起条件，DEC-017 按优先级取第一个）。
 */
async function publishTransferProcess(world: DemoWorld): Promise<void> {
  const processes = await listAll(world.call, world.admin, '/api/tenant/approval/processes');
  let process = processes.find((row) => row.code === DEMO_TRANSFER_PROCESS_CODE);
  if (!process) {
    const node = (key: string, name: string, approver: string) => ({
      key,
      name,
      approver,
      formFields: TRANSFER_FORM_FIELDS,
      // 自审回避（DEC-318 K-37）：发起人恰是本节点审批人时跳过本人，转直线经理 / 异常管理员，不自己审自己的单
      actions: { avoidSelf: true },
    });
    process = await world.as(
      'approval/processes',
      'POST',
      {
        code: DEMO_TRANSFER_PROCESS_CODE,
        name: '演示调动流程',
        approvalType: 'transfer',
        priority: -1,
        exceptionAdminUserId: world.accounts.get('exception'),
        conditions: {
          items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }],
          expression: '1',
        },
        nodes: [
          node('direct_head', '直接上级审批', 'latest_record_department_head'),
          node('in_hrbp', '调入部门HRBP审核', 'record_department_hrbp'),
        ],
      },
      0,
    );
    await world.wrote('transfers', DEMO_TRANSFER_PROCESS_CODE);
  }
  if (process.currentVersion) return;
  await world.as(`approval/processes/${String(process.id)}/publish`, 'POST', undefined, Number(process.revision));
  await world.wrote('transfers', `${DEMO_TRANSFER_PROCESS_CODE}:publish`);
}
