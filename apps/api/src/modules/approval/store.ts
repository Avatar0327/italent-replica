/** 审批实例、任务、日志的读写（全部在调用方的租户事务内，查询有界）。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { actorOf, approvalError, auditApproval, rowsOf, type ApprovalContext, type Row } from './context.js';
import type { BusinessType } from './adapters.js';
import { isAssignable } from './resolver.js';

/**
 * DEC-101：历史任务与日志不设总量上限、分页读取；只限制同时在办的任务数与单次读取的批量。
 */
export const MAX_PENDING = 50;
const BATCH = 500;
/** 详情默认展示的最新记录条数；完整历史走分页接口。 */
export const RECENT = 200;

export type InstanceStatus = 'running' | 'returned' | 'approved' | 'withdrawn' | 'cancelled';
/** queued：多人依次加签中排在后面、尚未轮到的加签任务（`14` §11.4）。 */
export type TaskStatus =
  'pending' | 'approved' | 'rejected' | 'transferred' | 'skipped' | 'cancelled' | 'add_signed' | 'queued';

export interface InstanceRow {
  readonly id: string;
  readonly processId: string;
  readonly versionId: string;
  readonly approvalType: string;
  readonly objectCode: string;
  readonly businessType: BusinessType;
  readonly businessId: string;
  readonly subjectEmployeeId: string | null;
  readonly initiatorUserId: string;
  readonly processCode: string | null;
  readonly title: string;
  readonly businessVersion: string;
  readonly status: InstanceStatus;
  readonly currentNodeKey: string | null;
  readonly returnedFromNodeKey: string | null;
  readonly round: number;
  /** 有效历史边界（F7）：序号小于它的任务不再算相同 / 历史审批人。 */
  readonly historyFromSeq: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface TaskRow {
  readonly id: string;
  readonly seq: number;
  readonly round: number;
  readonly nodeKey: string;
  readonly assigneeUserId: string | null;
  /** 按表达式解析出的候选人（DEC-114）。 */
  readonly candidateUserId: string | null;
  readonly origin: string;
  readonly status: TaskStatus;
  readonly isExceptionAdmin: boolean;
  readonly adminSelfTransfer: boolean;
  readonly parentTaskId: string | null;
  readonly comment: string | null;
  readonly actedAt: string | null;
}

const iso = (value: unknown) =>
  value === null || value === undefined ? null : new Date(value as string).toISOString();

function instanceOf(row: Row): InstanceRow {
  return {
    id: String(row.id),
    processId: String(row.process_id),
    versionId: String(row.version_id),
    approvalType: String(row.approval_type),
    objectCode: String(row.object_code),
    businessType: row.business_type as BusinessType,
    businessId: String(row.business_id),
    subjectEmployeeId: (row.subject_employee_id as string | null) ?? null,
    initiatorUserId: String(row.initiator_user_id),
    processCode: (row.process_code as string | null) ?? null,
    title: String(row.title),
    businessVersion: String(row.business_version ?? ''),
    status: row.status as InstanceStatus,
    currentNodeKey: (row.current_node_key as string | null) ?? null,
    returnedFromNodeKey: (row.returned_from_node_key as string | null) ?? null,
    round: Number(row.round),
    historyFromSeq: Number(row.history_from_seq ?? 0),
    revision: Number(row.revision),
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
  };
}

function taskOf(row: Row): TaskRow {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    round: Number(row.round),
    nodeKey: String(row.node_key),
    assigneeUserId: (row.assignee_user_id as string | null) ?? null,
    candidateUserId: (row.candidate_user_id as string | null) ?? null,
    origin: String(row.origin),
    status: row.status as TaskStatus,
    isExceptionAdmin: Boolean(row.is_exception_admin),
    adminSelfTransfer: Boolean(row.admin_self_transfer),
    parentTaskId: (row.parent_task_id as string | null) ?? null,
    comment: (row.comment as string | null) ?? null,
    actedAt: iso(row.acted_at),
  };
}

export async function loadInstance(tx: Tx, tenantId: string, id: string, lock = false): Promise<InstanceRow> {
  const [row] = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_instances WHERE tenant_id=${tenantId} AND id=${id}::uuid
      ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) throw new AppError('NOT_FOUND', '审批实例不存在');
  return instanceOf(row);
}

export async function activeInstanceOf(
  tx: Tx,
  tenantId: string,
  businessType: BusinessType,
  businessId: string,
): Promise<InstanceRow | null> {
  const [row] = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_instances WHERE tenant_id=${tenantId}
      AND business_type=${businessType} AND business_id=${businessId}::uuid AND status IN ('running','returned')
      FOR UPDATE`),
  );
  return row ? instanceOf(row) : null;
}

/**
 * 业务单最近一次可重提的实例（DEC-103）：在办、被驳回或已撤回。撤回不新开实例，重新提交时沿用这一个。
 */
export async function resumableInstanceOf(
  tx: Tx,
  tenantId: string,
  businessType: BusinessType,
  businessId: string,
): Promise<InstanceRow | null> {
  const [row] = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_instances WHERE tenant_id=${tenantId}
      AND business_type=${businessType} AND business_id=${businessId}::uuid
      AND status IN ('running','returned','withdrawn') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`),
  );
  return row ? instanceOf(row) : null;
}

export async function instanceOfTask(tx: Tx, tenantId: string, taskId: string): Promise<string> {
  const [row] = rowsOf<{ instance_id: string }>(
    await tx.execute(sql`SELECT instance_id FROM approval_tasks WHERE tenant_id=${tenantId} AND id=${taskId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '审批任务不存在');
  return row.instance_id;
}

/** 实例的全部任务（流转判定用）：按序号分批读取，每条语句有界，不因历史累积而拒绝（DEC-101）。 */
export async function loadTasks(tx: Tx, tenantId: string, instanceId: string): Promise<TaskRow[]> {
  const tasks: TaskRow[] = [];
  for (;;) {
    const after = tasks.at(-1)?.seq ?? 0;
    const rows = rowsOf(
      await tx.execute(sql`SELECT * FROM approval_tasks WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid
        AND seq>${after} ORDER BY seq LIMIT ${BATCH}`),
    );
    tasks.push(...rows.map(taskOf));
    if (rows.length < BATCH) return tasks;
  }
}

/**
 * 详情展示窗口：最新的若干条任务与全部在办 / 排队任务（按序号正序）。只用于展示；授权、披露与动作判定一律按
 * 完整任务计算（F1），不受这个窗口影响。
 */
export function displayWindow(tasks: readonly TaskRow[]): TaskRow[] {
  const from = tasks.length - RECENT;
  return tasks.filter((task, index) => index >= from || task.status === 'pending' || task.status === 'queued');
}

/** 完整历史分页（最新在前）。 */
export async function pageTasks(tx: Tx, tenantId: string, instanceId: string, page: { limit: number; offset: number }) {
  return rowsOf(
    await tx.execute(sql`SELECT * FROM approval_tasks WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid
      ORDER BY seq DESC LIMIT ${page.limit} OFFSET ${page.offset}`),
  ).map(taskOf);
}

export interface NewTask {
  readonly round: number;
  readonly nodeKey: string;
  readonly assigneeUserId: string | null;
  readonly candidateUserId?: string | null;
  readonly origin: string;
  readonly status: TaskStatus;
  readonly isExceptionAdmin?: boolean;
  readonly adminSelfTransfer?: boolean;
  readonly parentTaskId?: string | null;
}

/** 任务字段级审计（清单 12）：创建（含自动跳过）、关闭、取消都按任务 ID 记录前后值，与写入同事务。 */
async function auditTask(tx: Tx, ctx: ApprovalContext, action: string, taskId: string, before: Row | null, after: Row) {
  await auditApproval(tx, ctx, { action, objectType: 'approval-task', objectId: taskId, before, after });
}

export async function insertTask(tx: Tx, ctx: ApprovalContext, instanceId: string, task: NewTask): Promise<string> {
  const id = randomUUID();
  const open = task.status === 'pending' || task.status === 'queued';
  const actedAt = open ? null : ctx.now.toISOString();
  if (task.status === 'pending') await assertPendingRoom(tx, ctx.tenantId, instanceId);
  if (open && task.assigneeUserId) await assertAssigneeUsable(tx, ctx, task.assigneeUserId);
  await auditTask(tx, ctx, 'approval.task.create', id, null, {
    instanceId,
    round: task.round,
    nodeKey: task.nodeKey,
    assigneeUserId: task.assigneeUserId,
    candidateUserId: task.candidateUserId ?? null,
    origin: task.origin,
    status: task.status,
    isExceptionAdmin: task.isExceptionAdmin ?? false,
    adminSelfTransfer: task.adminSelfTransfer ?? false,
    parentTaskId: task.parentTaskId ?? null,
  });
  await tx.execute(sql`INSERT INTO approval_tasks
    (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,candidate_user_id,origin,status,
     is_exception_admin,admin_self_transfer,parent_task_id,acted_at,created_at)
    SELECT ${id},${ctx.tenantId},${instanceId}::uuid,COALESCE(max(seq),0)+1,${task.round},${task.nodeKey},
      ${task.assigneeUserId},${task.candidateUserId ?? null},${task.origin},${task.status},
      ${task.isExceptionAdmin ?? false},${task.adminSelfTransfer ?? false},${task.parentTaskId ?? null},${actedAt},
      ${ctx.now.toISOString()}
    FROM approval_tasks WHERE tenant_id=${ctx.tenantId} AND instance_id=${instanceId}::uuid`);
  return id;
}

/**
 * R4-2：写入新待办前对接手人做最终资格复核（取派单闸）。派单决策时已按 isEligibleApprover 选人，这里是兜底：
 * 接手人此刻正在停用或已停用即拒绝本次操作，不让新待办落到不能处理它的人名下。
 */
async function assertAssigneeUsable(tx: Tx, ctx: ApprovalContext, userId: string): Promise<void> {
  if (await isAssignable(tx, ctx.tenantId, userId)) return;
  throw approvalError('CONFLICT', 'APPROVAL_ASSIGNEE_UNAVAILABLE', '接手人账号已停用或正在停用，请刷新后重试');
}

async function assertPendingRoom(tx: Tx, tenantId: string, instanceId: string): Promise<void> {
  const [row] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM approval_tasks
      WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid AND status='pending'`),
  );
  if (Number(row?.n ?? 0) >= MAX_PENDING) {
    throw new AppError('PAYLOAD_TOO_LARGE', `同一审批单同时在办的任务不能超过 ${MAX_PENDING} 个`, {
      reason: 'APPROVAL_TOO_MANY_PENDING',
    });
  }
}

/** 依次加签轮到排队中的下一位：queued → pending（`14` §11.4）。 */
export async function activateTask(tx: Tx, ctx: ApprovalContext, instanceId: string, taskId: string): Promise<void> {
  await assertPendingRoom(tx, ctx.tenantId, instanceId);
  const activated = rowsOf(
    await tx.execute(sql`UPDATE approval_tasks SET status='pending'
      WHERE tenant_id=${ctx.tenantId} AND id=${taskId}::uuid AND status='queued' RETURNING id`),
  );
  if (activated.length)
    await auditTask(tx, ctx, 'approval.task.activate', taskId, { status: 'queued' }, { status: 'pending' });
}

/** 排队中的加签人已不可审批（F8）：排队任务改记为已转交，由调用方另建异常管理员任务接替。 */
export async function closeQueued(tx: Tx, ctx: ApprovalContext, taskId: string): Promise<void> {
  const closed = rowsOf(
    await tx.execute(sql`UPDATE approval_tasks SET status='transferred',acted_at=${ctx.now.toISOString()}
      WHERE tenant_id=${ctx.tenantId} AND id=${taskId}::uuid AND status='queued' RETURNING id`),
  );
  if (closed.length)
    await auditTask(tx, ctx, 'approval.task.close', taskId, { status: 'queued' }, { status: 'transferred' });
}

export async function closeTask(
  tx: Tx,
  ctx: ApprovalContext,
  taskId: string,
  status: TaskStatus,
  comment: string | null = null,
): Promise<void> {
  const closed = rowsOf(
    await tx.execute(sql`UPDATE approval_tasks SET status=${status},comment=${comment},acted_at=${ctx.now.toISOString()}
    WHERE tenant_id=${ctx.tenantId} AND id=${taskId}::uuid AND status='pending' RETURNING id`),
  );
  if (closed.length)
    await auditTask(tx, ctx, 'approval.task.close', taskId, { status: 'pending', comment: null }, { status, comment });
}

/** 结束实例时取消在办与排队中的任务，逐个写任务审计（AGENTS §10「审计」）。 */
export async function cancelPending(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<void> {
  const open = rowsOf<{ id: string; status: string }>(
    await tx.execute(sql`SELECT id,status FROM approval_tasks WHERE tenant_id=${ctx.tenantId}
      AND instance_id=${instanceId}::uuid AND status IN ('pending','queued') ORDER BY seq FOR UPDATE`),
  );
  for (const task of open) {
    await tx.execute(sql`UPDATE approval_tasks SET status='cancelled',acted_at=${ctx.now.toISOString()}
      WHERE tenant_id=${ctx.tenantId} AND id=${task.id}::uuid`);
    await auditTask(tx, ctx, 'approval.task.cancel', task.id, { status: task.status }, { status: 'cancelled' });
  }
}

export interface LogEntry {
  readonly event: string;
  readonly nodeKey?: string | null;
  readonly taskId?: string | null;
  readonly actorUserId?: string | null;
  readonly adminSelfTransfer?: boolean;
  readonly detail?: Row;
}

export async function appendLog(tx: Tx, ctx: ApprovalContext, instance: InstanceRow, entry: LogEntry): Promise<void> {
  await tx.execute(sql`INSERT INTO approval_instance_logs
    (id,tenant_id,instance_id,seq,round,node_key,task_id,event,actor_user_id,admin_self_transfer,detail,created_at)
    SELECT ${randomUUID()},${ctx.tenantId},${instance.id}::uuid,COALESCE(max(seq),0)+1,${instance.round},
      ${entry.nodeKey ?? null},${entry.taskId ?? null},${entry.event},
      ${entry.actorUserId === undefined ? actorOf(ctx) : entry.actorUserId},${entry.adminSelfTransfer ?? false},
      ${JSON.stringify(entry.detail ?? {})}::jsonb,${ctx.now.toISOString()}
    FROM approval_instance_logs WHERE tenant_id=${ctx.tenantId} AND instance_id=${instance.id}::uuid`);
}

/** X-19：详情默认展示最新的若干条日志（按时间正序），完整历史分页读取（pageLogs）。 */
export async function loadLogs(tx: Tx, tenantId: string, instanceId: string) {
  return rowsOf(
    await tx.execute(sql`SELECT * FROM (
        SELECT * FROM approval_instance_logs WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid
        ORDER BY seq DESC LIMIT ${RECENT}
      ) recent ORDER BY seq`),
  ).map(logOf);
}

/** 完整日志分页（最新在前）。 */
export async function pageLogs(tx: Tx, tenantId: string, instanceId: string, page: { limit: number; offset: number }) {
  return rowsOf(
    await tx.execute(sql`SELECT * FROM approval_instance_logs WHERE tenant_id=${tenantId}
      AND instance_id=${instanceId}::uuid ORDER BY seq DESC LIMIT ${page.limit} OFFSET ${page.offset}`),
  ).map(logOf);
}

export type LogView = ReturnType<typeof logOf>;

function logOf(row: Row) {
  return {
    event: String(row.event),
    nodeKey: (row.node_key as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    adminSelfTransfer: Boolean(row.admin_self_transfer),
    detail: row.detail as Row,
    createdAt: iso(row.created_at),
  };
}

/** 每个审批写命令都推进实例 revision（AGENTS §10「并发」）。 */
export async function updateInstance(
  tx: Tx,
  ctx: ApprovalContext,
  instance: InstanceRow,
  patch: Partial<
    Pick<
      InstanceRow,
      'status' | 'currentNodeKey' | 'returnedFromNodeKey' | 'round' | 'businessVersion' | 'historyFromSeq'
    >
  >,
): Promise<InstanceRow> {
  const next = { ...instance, ...patch, revision: instance.revision + 1 };
  const done = ['approved', 'withdrawn', 'cancelled'].includes(next.status);
  await tx.execute(sql`UPDATE approval_instances SET status=${next.status},current_node_key=${next.currentNodeKey},
      returned_from_node_key=${next.returnedFromNodeKey},round=${next.round},revision=${next.revision},
      history_from_seq=${next.historyFromSeq},
      business_version=${next.businessVersion},
      updated_at=${ctx.now.toISOString()},completed_at=${done ? ctx.now.toISOString() : null}
    WHERE tenant_id=${ctx.tenantId} AND id=${instance.id}::uuid AND revision=${instance.revision}`);
  return { ...next, completedAt: done ? ctx.now.toISOString() : null };
}
