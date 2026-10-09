import { lockTransferParticipants } from '../employment/transfer-locks.js';
/**
 * 异常管理员交接（DEC-098）：异常管理员停用前必须指定替代人——引用其为异常管理员的流程以当前版本为底稿重新发布，
 * 记下替代人，其名下在办的异常任务转给替代人；之后才允许撤销其成员关系（迁移 0030 触发器把关）。
 * F2：替换流程配置只需流程配置权（DEC-102）；改派在途实例是实例干预，逐单复核操作人的实例转交按钮与数据范围，
 * 以及 DEC-092 本人回避。第四轮：范围过滤放进查询（N4），调用者看不到的实例只计数、不列出编号（N3），其他原因
 * 跳过的实例凭游标翻过（N4）；拿到锁后实例已结束或已无待转任务时什么都不写（N5）。
 * DEC-123：成员停用时（平台撤销成员关系或全局停用账号的同一事务内，R4-3），其剩余在途异常待办自动转给替代人或
 * 租户管理员；与派单的串行协议（派单闸）见 resolver.closeAssigneeGate（R4-2 / R5-1 / R5-2）。
 * F-008 / R6-3：一个事务里处理多张单（停用接管、手动交接的一批）时按全局取锁顺序逐单处理，见 LOCK_ORDER。
 */
import { sql, type MembershipRevocation, type Tx } from '@italent/db';
import {
  adminRecused,
  avoidSelfExceptionAdmin,
  instanceRecusal,
  tenantLocalDate,
  type Candidate,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { TenantRouteDeps } from '../../routes.js';
import { memberInstanceScope } from './access.js';
import { ADAPTERS, type BusinessType } from './adapters.js';
import { approvalError, assertRevision, auditApproval, rowsOf, type ApprovalContext } from './context.js';
import { mergeSeat, mergesSeat, resettle } from './countersign.js';
import { assertExceptionAdminMember, republishWithExceptionAdmin } from './definitions.js';
import { currentRouting, openRun, persistRun, type Run } from './engine.js';
import { notifyTodo } from './notifications.js';
import {
  closeAssigneeGate,
  directManagerOf,
  isEligibleApprover,
  personOfUser,
  tenantAdminTakeover,
} from './resolver.js';
import { loadRecusalFacts } from './subjects.js';
import { appendLog, closeTask, insertTask, loadInstance, loadTasks, type TaskRow } from './store.js';

/** 单次交接的规模上限（DEC-101：只限制单次操作规模），超出时返回 remaining 与游标，由管理员再次提交。 */
const BATCH = 200;

export interface HandoverInput {
  readonly fromUserId: string;
  readonly toUserId: string;
  /** 上一批最后一个实例的编号：凭它翻过已处理或已跳过的实例（N4）。 */
  readonly cursor?: string;
}

export interface SkippedInstance {
  readonly instanceId: string;
  readonly reason: string;
}

export interface HandoverResult {
  readonly processes: number;
  readonly tasks: number;
  readonly skipped: readonly SkippedInstance[];
  /** 调用者范围外的实例数：不可识别，不给编号（N3）。 */
  readonly unlisted: number;
  readonly remaining: boolean;
  readonly nextCursor: string | null;
}

/**
 * F-008 / R6-3 全局取锁顺序：审批命令先锁实例的异动员工（openRun → 业务适配器），再锁业务单、实例。一个事务处理
 * 多张单时须按（异动员工, 实例编号）升序逐单处理，且整个事务都保持这一顺序（停用接管跨页也一样）：员工锁总是按编号
 * 递增取得，同一员工的业务单与实例都在其员工锁之下串行，两个批量事务不会互持对方要的员工锁。
 * 实例的异动员工即适配器锁住的员工（任职业务 / 员工信息变更申请的员工，发起时写入、之后不改）。该列在表上可空
 * （两种业务都不会写空）：万一为空按最小值排在最前，保证键集游标不会因 NULL 比较而提前结束、漏掉待接管的单。
 */
const LOCK_EMPLOYEE = sql`coalesce(i.subject_employee_id,'00000000-0000-0000-0000-000000000000'::uuid)`;
const LOCK_ORDER = sql`${LOCK_EMPLOYEE},i.id`;

/** 实例及其异动员工（取锁顺序的键）。 */
export interface LockKey {
  readonly id: string;
  readonly employee_id: string;
}

/** 小写规范 UUID 文本的字典序与 PostgreSQL uuid 的排序一致。 */
function compareUuid(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 同 LOCK_ORDER 的内存排序。 */
const byLockOrder = (a: LockKey, b: LockKey) => compareUuid(a.employee_id, b.employee_id) || compareUuid(a.id, b.id);

/** 待转的异常任务所在的在途实例（对 approval_instances 别名 i）。 */
const pendingExceptionOf = (tenantId: string, userId: string) => sql`EXISTS (SELECT 1 FROM approval_tasks t
  WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id AND t.status='pending' AND t.is_exception_admin
    AND t.assignee_user_id=${userId}::uuid) AND i.tenant_id=${tenantId} AND i.status='running'`;

/**
 * @param scope 操作人的实例转交权限（实例转交按钮 + 数据范围，对 approval_instances 别名 i）；没有按钮时为 null
 */
export async function handoverExceptionAdmin(
  tx: Tx,
  ctx: ApprovalContext,
  input: HandoverInput,
  scope: SQL | null,
): Promise<HandoverResult> {
  assertRevision(ctx.expectedRevision, 0);
  if (input.fromUserId === input.toUserId) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '替代人不能是原异常管理员本人');
  }
  await assertTenantMember(tx, ctx.tenantId, input.fromUserId);
  await assertExceptionAdminMember(tx, ctx.tenantId, input.toUserId);
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  if (!(await isEligibleApprover(tx, { tenantId: ctx.tenantId, asOf }, input.toUserId))) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '替代人已离职或不是本租户有效成员');
  }
  const instances = scope ? await transferableInstances(tx, ctx, input, scope) : [];
  const batch = instances.slice(0, BATCH);
  // F-065：员工 → 业务 → 组织的锁必须先于登记替代人 / 重发流程（二者的外键对来源账号与替代人的成员行取 KEY SHARE）。
  // 入职绑定账号的顺序是组织锁 → 成员行 FOR UPDATE，反过来先持成员行再等组织锁会与它成环（org/locks.ts 全局锁序）。
  await lockHandoverParticipants(tx, ctx, batch);
  await designateSuccessor(tx, ctx, input);
  const processes = await republishProcesses(tx, ctx, input);
  let tasks = 0;
  const skipped: SkippedInstance[] = [];
  // R6-3：选批与游标仍按实例编号（对外不变）；批内按全局取锁顺序逐单处理（一批一个事务，批与批之间锁已释放）。
  for (const { id: instanceId } of [...batch].sort(byLockOrder)) {
    const outcome =
      (await ownRequestBlocker(tx, ctx, instanceId)) ?? (await handoverInstance(tx, ctx, instanceId, input));
    if (typeof outcome === 'number') tasks += outcome;
    else if (outcome) skipped.push({ instanceId, reason: outcome });
  }
  const more = instances.length > BATCH;
  return {
    processes: Math.min(processes, BATCH),
    tasks,
    skipped: skipped.sort((a, b) => compareUuid(a.instanceId, b.instanceId)),
    unlisted: await unlistedCount(tx, ctx, input, scope),
    remaining: processes > BATCH || more,
    nextCursor: more ? batch.at(-1)!.id : null,
  };
}

/**
 * R4-1：按调用者当前的实例转交范围裁剪交接结果——首次执行与幂等重放（台账里的首次结果）同样处理。
 * 已不在范围内的实例不再给编号与原因，计入不可识别的 unlisted；游标指向的实例不可见时不给游标。
 */
export async function discloseHandover(
  tx: Tx,
  ctx: ApprovalContext,
  result: HandoverResult,
  scope: SQL | null,
): Promise<HandoverResult> {
  const ids = result.skipped.map((item) => item.instanceId);
  if (result.nextCursor) ids.push(result.nextCursor);
  const visible = new Set(scope && ids.length ? await visibleInstances(tx, ctx.tenantId, ids, scope) : []);
  const skipped = result.skipped.filter((item) => visible.has(item.instanceId));
  return {
    ...result,
    skipped,
    unlisted: result.unlisted + result.skipped.length - skipped.length,
    nextCursor: result.nextCursor && visible.has(result.nextCursor) ? result.nextCursor : null,
  };
}

async function visibleInstances(tx: Tx, tenantId: string, ids: readonly string[], scope: SQL) {
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`,`,
  );
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT i.id FROM approval_instances i
      WHERE i.tenant_id=${tenantId} AND i.id IN (${list}) AND ${scope}`),
  );
  return rows.map((row) => row.id);
}

/** R4-6：原异常管理员须是本租户成员（含已撤销的），否则是无效输入（400），不让外键错误变成 500。 */
async function assertTenantMember(tx: Tx, tenantId: string, userId: string) {
  const [member] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM tenant_memberships WHERE tenant_id=${tenantId} AND user_id=${userId}::uuid`),
  );
  if (!member) throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '原异常管理员不是本租户成员');
}

/**
 * DEC-123：记下替代人（再次交接即改写），成员停用时据此自动转派剩余异常待办。
 * R4-5：先“不存在才插入”；已存在（含并发的另一方刚插入并提交）时锁住该行读出真实旧值再改写，审计旧值即被覆盖的值。
 */
/** 指定替代人（DEC-123）；交接与按租户恢复的对账（以现网指定为准）共用。 */
export async function designateSuccessor(tx: Tx, ctx: ApprovalContext, input: HandoverInput) {
  const now = ctx.now.toISOString();
  const inserted = rowsOf(
    await tx.execute(sql`INSERT INTO approval_exception_admin_successors
      (tenant_id,user_id,successor_user_id,designated_by,command_id,created_at,updated_at)
      VALUES (${ctx.tenantId},${input.fromUserId}::uuid,${input.toUserId}::uuid,${ctx.userId}::uuid,${ctx.commandId},
        ${now},${now})
      ON CONFLICT (tenant_id,user_id) DO NOTHING RETURNING id`),
  );
  let before: string | null = null;
  if (!inserted.length) {
    const [row] = rowsOf<{ successor_user_id: string }>(
      await tx.execute(sql`SELECT successor_user_id FROM approval_exception_admin_successors
        WHERE tenant_id=${ctx.tenantId} AND user_id=${input.fromUserId}::uuid FOR UPDATE`),
    );
    before = row!.successor_user_id;
    await tx.execute(sql`UPDATE approval_exception_admin_successors SET successor_user_id=${input.toUserId}::uuid,
      designated_by=${ctx.userId}::uuid,command_id=${ctx.commandId},updated_at=${now},revision=revision+1
      WHERE tenant_id=${ctx.tenantId} AND user_id=${input.fromUserId}::uuid`);
  }
  await auditApproval(tx, ctx, {
    action: 'approval.exception_admin.designate_successor',
    objectType: 'approval-exception-admin',
    objectId: input.fromUserId,
    before: { successorUserId: before },
    after: { successorUserId: input.toUserId },
  });
}

async function republishProcesses(tx: Tx, ctx: ApprovalContext, input: HandoverInput): Promise<number> {
  const processes = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT p.id FROM approval_processes p
      JOIN approval_process_versions v ON v.tenant_id=p.tenant_id AND v.id=p.current_version_id
      WHERE p.tenant_id=${ctx.tenantId} AND p.status='active' AND v.exception_admin_user_id=${input.fromUserId}::uuid
      ORDER BY p.code LIMIT ${BATCH + 1}`),
  );
  for (const process of processes.slice(0, BATCH)) {
    await republishWithExceptionAdmin(tx, ctx, process.id, input.toUserId);
  }
  return processes.length;
}

/** N4：调用者范围在限量之前过滤；游标之后的实例按编号排序。 */
async function transferableInstances(tx: Tx, ctx: ApprovalContext, input: HandoverInput, scope: SQL) {
  const after = input.cursor ? sql`AND i.id>${input.cursor}::uuid` : sql``;
  return rowsOf<LockKey>(
    await tx.execute(sql`SELECT i.id,${LOCK_EMPLOYEE} AS employee_id FROM approval_instances i
      WHERE ${pendingExceptionOf(ctx.tenantId, input.fromUserId)} AND ${scope} ${after}
      ORDER BY i.id LIMIT ${BATCH + 1}`),
  );
}

/**
 * N3：调用者看不到（不在其实例转交范围内）的实例只计数，不返回编号与原因。
 * R4-7：范围谓词可能为 NULL（如“使用用户”维度遇到员工子集变更），用 IS NOT TRUE 计入，授权侧仍按不成立拒绝。
 */
async function unlistedCount(tx: Tx, ctx: ApprovalContext, input: HandoverInput, scope: SQL | null) {
  const outside = scope ? sql`AND (${scope}) IS NOT TRUE` : sql``;
  const [row] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM approval_instances i
      WHERE ${pendingExceptionOf(ctx.tenantId, input.fromUserId)} ${outside}`),
  );
  return Number(row?.n ?? 0);
}

/** DEC-092 / DEC-329②：本人发起或本人为本单涵盖主体的实例，操作人不能改派（与管理员转交入口同一判断，实例级）。 */
async function ownRequestBlocker(tx: Tx, ctx: ApprovalContext, instanceId: string) {
  const instance = await loadInstance(tx, ctx.tenantId, instanceId);
  const facts = await loadRecusalFacts(tx, ctx.tenantId, instance);
  return instanceRecusal({ userId: ctx.userId }, facts) ? 'APPROVAL_ADMIN_SELF' : null;
}

interface Step {
  readonly task: TaskRow;
  readonly userId: string;
  readonly reason: string;
}

/**
 * 加锁后重新读取实例与待转任务（N5）：实例已结束或已无待转任务时返回 null，什么都不写。
 * @returns 改派的任务数；替代人本人回避后无人接替时返回原因，整单不动
 */
async function handoverInstance(tx: Tx, ctx: ApprovalContext, instanceId: string, input: HandoverInput) {
  const run = await openRun(tx, ctx, instanceId, true);
  const pending = await pendingExceptionTasks(tx, run, input.fromUserId);
  if (!pending.length) return null;
  const plan: Step[] = [];
  for (const task of pending) {
    const routing = await currentRouting(tx, run, task.nodeKey);
    const successor: Candidate = {
      userId: input.toUserId,
      personId: await personOfUser(tx, ctx.tenantId, input.toUserId),
    };
    // DEC-091 / DEC-329②：替代人恰为本单发起人或任一主体时同样回避给其直线经理。
    const manager = adminRecused(successor, routing.facts)
      ? await directManagerOf(tx, routing.subject, successor)
      : undefined;
    const choice = avoidSelfExceptionAdmin(successor, routing.facts, manager);
    if (choice.kind === 'unavailable') return 'APPROVAL_EXCEPTION_ADMIN_SELF';
    plan.push({ task, userId: choice.userId, reason: choice.reason });
  }
  await reassignAll(tx, run, plan, input.fromUserId, 'exception_admin_handover', 'approval.instance.handover');
  return plan.length;
}

async function pendingExceptionTasks(tx: Tx, run: Run, userId: string): Promise<TaskRow[]> {
  if (run.instance.status !== 'running') return [];
  return (await loadTasks(tx, run.ctx.tenantId, run.instance.id)).filter(
    (task) => task.status === 'pending' && task.isExceptionAdmin && task.assigneeUserId === userId,
  );
}

/**
 * 逐条改派。F-003：接替的任务沿用原任务的节点激活，会签节点里这一票随之转给接手人；接手人已在本节点占着一席时，
 * 这一席记为“由同一人接手、不重复计票”（一人一票，P2-1），改派完再按一人一票重新结算该节点。
 */
async function reassignAll(
  tx: Tx,
  run: Run,
  plan: readonly Step[],
  from: string,
  event: string,
  action: string,
  settle = true,
) {
  const { ctx, instance } = run;
  const merged: TaskRow[] = [];
  for (const step of plan) {
    await closeTask(tx, ctx, step.task.id, 'transferred', '异常管理员交接');
    if (mergesSeat(run, await loadTasks(tx, ctx.tenantId, instance.id), step.task, step.userId)) {
      // 不结算模式（按租户恢复的对账）：合席会重新结算并推进流转，恢复期间不得发生，整单拒绝由调用方处理
      if (!settle) {
        throw approvalError(
          'CONFLICT',
          'APPROVAL_TAKEOVER_NEEDS_SETTLEMENT',
          '接管会合并会签席位并重新结算，须人工处理',
        );
      }
      await mergeSeat(tx, run, step.task, step.userId, 'handover');
      merged.push(step.task);
      continue;
    }
    const next = await insertTask(tx, ctx, instance.id, {
      round: instance.round,
      nodeKey: step.task.nodeKey,
      assigneeUserId: step.userId,
      origin: 'handover',
      status: 'pending',
      isExceptionAdmin: true,
      parentTaskId: step.task.id,
      activationId: step.task.activationId,
    });
    await appendLog(tx, ctx, instance, {
      event,
      nodeKey: step.task.nodeKey,
      taskId: next,
      detail: { fromUserId: from, toUserId: step.userId, reason: step.reason },
    });
    await notifyTodo(tx, ctx, instance, next, step.userId);
  }
  for (const task of merged) await resettle(tx, run, task);
  run.events.push('approval.task.transferred');
  await persistRun(tx, run, action);
}

/**
 * DEC-123：成员停用的同一事务内，把其名下剩余的在途异常待办自动转派——交接时指定的替代人能接手的（具备审批资格、
 * 数据范围覆盖该实例、不是发起人或异动本人）转给替代人；其余以及没有指定替代人的，转给租户管理员（DEC-098 的接管
 * 口径；租户管理员恰为本人时按 DEC-091 回避给其直线经理）。无人可接手即拒绝本次停用，保证不停顿。
 */
export async function takeOverOnDeactivation(
  tx: Tx,
  deps: TenantRouteDeps,
  revocation: MembershipRevocation,
  options: { readonly settle?: boolean } = {},
) {
  const { tenantId, userId, timezone, actorUserId, commandId } = revocation;
  // 先关派单闸（排他，可以等）：此后的派单拿不到闸、不会再派给他；已拿到闸的派单提交后，下面的扫描能看到。
  await closeAssigneeGate(tx, tenantId, userId);
  await assertNotActiveExceptionAdmin(tx, tenantId, userId);
  const ctx: ApprovalContext = {
    tenantId,
    userId: actorUserId ?? userId,
    actorUserId,
    timezone,
    now: deps.clock(),
    commandId,
    expectedRevision: 0,
  };
  const successor = await designatedSuccessor(tx, tenantId, userId);
  const successorScope = successor
    ? await memberInstanceScope(deps, { tenantId, userId: successor, timezone }, tx)
    : null;
  // F-017：会签合席可能推进业务。跨页先收齐参与闭包，不能在持实例锁后追加较小员工锁。
  let after: LockKey | null = null;
  const instances: LockKey[] = [];
  for (;;) {
    const page = await pendingInLockOrder(tx, tenantId, userId, after);
    instances.push(...page);
    if (page.length < BATCH) break;
    after = page.at(-1)!;
  }
  await lockHandoverParticipants(tx, ctx, instances);
  for (const { id } of instances)
    await takeOverInstance(tx, ctx, id, userId, successor, successorScope, options.settle ?? true);
}

/**
 * 停用者名下待转的在途实例，按 LOCK_ORDER 从 after 之后取一页（键集游标）。
 * @param limit 页长；只在验收测试里调小，以验证跨页仍沿全局顺序延续
 */
export async function pendingInLockOrder(
  tx: Tx,
  tenantId: string,
  userId: string,
  after: LockKey | null,
  limit = BATCH,
): Promise<LockKey[]> {
  const from = after ? sql`AND (${LOCK_EMPLOYEE},i.id)>(${after.employee_id}::uuid,${after.id}::uuid)` : sql``;
  return rowsOf<LockKey>(
    await tx.execute(sql`SELECT i.id,${LOCK_EMPLOYEE} AS employee_id FROM approval_instances i
      WHERE ${pendingExceptionOf(tenantId, userId)} ${from} ORDER BY ${LOCK_ORDER} LIMIT ${limit}`),
  );
}

/**
 * DEC-098 停用保护：仍是可用流程（当前生效版本）的异常管理员时拒绝停用，须先交接。撤销成员关系与全局停用账号
 * 共用这一判断（R4-3）；撤销成员关系另有迁移 0030 的触发器兜底。
 */
async function assertNotActiveExceptionAdmin(tx: Tx, tenantId: string, userId: string) {
  const [referenced] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM approval_processes p
      JOIN approval_process_versions v ON v.tenant_id=p.tenant_id AND v.id=p.current_version_id
      WHERE p.tenant_id=${tenantId} AND p.status='active' AND v.exception_admin_user_id=${userId}::uuid LIMIT 1`),
  );
  if (referenced) {
    throw approvalError(
      'CONFLICT',
      'APPROVAL_EXCEPTION_ADMIN_HANDOVER_REQUIRED',
      '该成员是审批流程的异常管理员，请先在审批中心指定替代人',
    );
  }
}

async function designatedSuccessor(tx: Tx, tenantId: string, userId: string): Promise<string | null> {
  const [row] = rowsOf<{ successor_user_id: string }>(
    await tx.execute(sql`SELECT successor_user_id FROM approval_exception_admin_successors
      WHERE tenant_id=${tenantId} AND user_id=${userId}::uuid`),
  );
  return row?.successor_user_id ?? null;
}

async function takeOverInstance(
  tx: Tx,
  ctx: ApprovalContext,
  instanceId: string,
  leaving: string,
  successor: string | null,
  successorScope: SQL | null,
  settle: boolean,
) {
  const run = await openRun(tx, ctx, instanceId, true);
  const pending = await pendingExceptionTasks(tx, run, leaving);
  if (!pending.length) return;
  const plan: Step[] = [];
  for (const task of pending) {
    plan.push({ task, ...(await takeoverTarget(tx, run, task, leaving, successor, successorScope)) });
  }
  const action = 'approval.instance.exception_admin_takeover';
  await reassignAll(tx, run, plan, leaving, 'exception_admin_takeover', action, settle);
}

async function takeoverTarget(
  tx: Tx,
  run: Run,
  task: TaskRow,
  leaving: string,
  successor: string | null,
  successorScope: SQL | null,
): Promise<{ userId: string; reason: string }> {
  const { tenantId } = run.ctx;
  const routing = await currentRouting(tx, run, task.nodeKey);
  if (successor && successorScope) {
    const candidate: Candidate = { userId: successor, personId: await personOfUser(tx, tenantId, successor) };
    const [covered] = rowsOf(
      await tx.execute(sql`SELECT 1 FROM approval_instances i
        WHERE i.tenant_id=${tenantId} AND i.id=${run.instance.id}::uuid AND ${successorScope}`),
    );
    const eligible = await isEligibleApprover(tx, routing.subject, successor);
    if (covered && eligible && !adminRecused(candidate, routing.facts)) {
      return { userId: successor, reason: '原异常管理员停用，转交接时指定的替代人' };
    }
  }
  // R4-4：回退的租户管理员同样复核审批资格，已离职或不可用的跳过、改找下一个；一个都没有即拒绝本次停用。
  const takeover = await tenantAdminTakeover(tx, routing.subject, routing.facts, leaving);
  if (takeover?.kind !== 'assign') {
    const why = takeover?.reason ?? '替代人不能接手，且租户没有具备审批资格的管理员';
    throw approvalError('CONFLICT', 'APPROVAL_EXCEPTION_ADMIN_UNAVAILABLE', `异常待办无人可接手，不能停用：${why}`);
  }
  return { userId: takeover.userId, reason: `原异常管理员停用，替代人不能接手，转租户管理员；${takeover.reason}` };
}

/**
 * 交接前统一取锁：员工（任职业务的参与闭包）→ 各业务的业务行与资源锁（适配器 lockMany，按业务自己的规范顺序，任职业务
 * 含组织锁）→ 之后逐单锁实例。登记替代人等会对成员行取 KEY SHARE 的写入必须排在这些锁之后（F-065）。发展计划的批量干预按计划 ID 升序锁计划再锁实例，这里同样先按计划 ID 升序锁齐本批的计划，两边锁序一致，
 * 不会交错互等（PR #115 第 2 轮 P3-2）。
 */
async function lockHandoverParticipants(tx: Tx, ctx: ApprovalContext, batch: readonly LockKey[]) {
  const employees = [...new Set(batch.map((item) => item.employee_id))]
    .filter((id) => id !== '00000000-0000-0000-0000-000000000000')
    .sort();
  if (employees.length) await lockTransferParticipants(tx, ctx, employees[0]!, employees.slice(1));
  if (!batch.length) return;
  const rows = rowsOf<{ business_type: BusinessType; business_id: string }>(
    await tx.execute(sql`SELECT business_type, business_id::text FROM approval_instances
      WHERE tenant_id=${ctx.tenantId} AND id = ANY(${`{${batch.map((item) => item.id).join(',')}}`}::uuid[])`),
  );
  const byType = new Map<BusinessType, string[]>();
  for (const row of rows) byType.set(row.business_type, [...(byType.get(row.business_type) ?? []), row.business_id]);
  for (const [type, ids] of byType) await ADAPTERS[type].lockMany?.(tx, ctx, ids);
}
