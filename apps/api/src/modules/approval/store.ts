/** 审批实例、任务、日志的读写（全部在调用方的租户事务内，查询有界）。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf, type ApprovalContext, type Row } from './context.js';
import type { BusinessType } from './adapters.js';

export const MAX_TASKS = 500;
export const MAX_LOGS = 1000;

export type InstanceStatus = 'running' | 'returned' | 'approved' | 'withdrawn' | 'cancelled';
export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'transferred' | 'skipped' | 'cancelled';

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
  readonly conditionValues: Readonly<Row>;
  readonly status: InstanceStatus;
  readonly currentNodeKey: string | null;
  readonly returnedFromNodeKey: string | null;
  readonly round: number;
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
    conditionValues: (row.condition_values as Row | null) ?? {},
    status: row.status as InstanceStatus,
    currentNodeKey: (row.current_node_key as string | null) ?? null,
    returnedFromNodeKey: (row.returned_from_node_key as string | null) ?? null,
    round: Number(row.round),
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

export async function instanceOfTask(tx: Tx, tenantId: string, taskId: string): Promise<string> {
  const [row] = rowsOf<{ instance_id: string }>(
    await tx.execute(sql`SELECT instance_id FROM approval_tasks WHERE tenant_id=${tenantId} AND id=${taskId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '审批任务不存在');
  return row.instance_id;
}

export async function loadTasks(tx: Tx, tenantId: string, instanceId: string): Promise<TaskRow[]> {
  const rows = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_tasks WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid
      ORDER BY seq LIMIT ${MAX_TASKS + 1}`),
  );
  if (rows.length > MAX_TASKS) throw new AppError('PAYLOAD_TOO_LARGE', '审批任务超过单实例上限');
  return rows.map(taskOf);
}

export interface NewTask {
  readonly round: number;
  readonly nodeKey: string;
  readonly assigneeUserId: string | null;
  readonly origin: string;
  readonly status: TaskStatus;
  readonly isExceptionAdmin?: boolean;
  readonly adminSelfTransfer?: boolean;
  readonly parentTaskId?: string | null;
}

export async function insertTask(tx: Tx, ctx: ApprovalContext, instanceId: string, task: NewTask): Promise<string> {
  const id = randomUUID();
  const actedAt = task.status === 'pending' ? null : ctx.now.toISOString();
  if ((await taskCount(tx, ctx.tenantId, instanceId)) >= MAX_TASKS) {
    throw new AppError('PAYLOAD_TOO_LARGE', '审批任务超过单实例上限');
  }
  await tx.execute(sql`INSERT INTO approval_tasks
    (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,is_exception_admin,
     admin_self_transfer,parent_task_id,acted_at,created_at)
    SELECT ${id},${ctx.tenantId},${instanceId}::uuid,COALESCE(max(seq),0)+1,${task.round},${task.nodeKey},
      ${task.assigneeUserId},${task.origin},${task.status},${task.isExceptionAdmin ?? false},
      ${task.adminSelfTransfer ?? false},${task.parentTaskId ?? null},${actedAt},${ctx.now.toISOString()}
    FROM approval_tasks WHERE tenant_id=${ctx.tenantId} AND instance_id=${instanceId}::uuid`);
  return id;
}

async function taskCount(tx: Tx, tenantId: string, instanceId: string): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM approval_tasks
      WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid`),
  );
  return Number(row?.n ?? 0);
}

export async function closeTask(
  tx: Tx,
  ctx: ApprovalContext,
  taskId: string,
  status: TaskStatus,
  comment: string | null = null,
): Promise<void> {
  await tx.execute(sql`UPDATE approval_tasks SET status=${status},comment=${comment},acted_at=${ctx.now.toISOString()}
    WHERE tenant_id=${ctx.tenantId} AND id=${taskId}::uuid AND status='pending'`);
}

export async function cancelPending(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<void> {
  await tx.execute(sql`UPDATE approval_tasks SET status='cancelled',acted_at=${ctx.now.toISOString()}
    WHERE tenant_id=${ctx.tenantId} AND instance_id=${instanceId}::uuid AND status='pending'`);
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
      ${entry.actorUserId === undefined ? ctx.userId : entry.actorUserId},${entry.adminSelfTransfer ?? false},
      ${JSON.stringify(entry.detail ?? {})}::jsonb,${ctx.now.toISOString()}
    FROM approval_instance_logs WHERE tenant_id=${ctx.tenantId} AND instance_id=${instance.id}::uuid`);
}

export async function loadLogs(tx: Tx, tenantId: string, instanceId: string) {
  return rowsOf(
    await tx.execute(sql`SELECT * FROM approval_instance_logs WHERE tenant_id=${tenantId}
      AND instance_id=${instanceId}::uuid ORDER BY seq LIMIT ${MAX_LOGS}`),
  ).map((row) => ({
    event: String(row.event),
    nodeKey: (row.node_key as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    adminSelfTransfer: Boolean(row.admin_self_transfer),
    detail: row.detail as Row,
    createdAt: iso(row.created_at),
  }));
}

/** 每个审批写命令都推进实例 revision（AGENTS §10「并发」）。 */
export async function updateInstance(
  tx: Tx,
  ctx: ApprovalContext,
  instance: InstanceRow,
  patch: Partial<
    Pick<
      InstanceRow,
      'status' | 'currentNodeKey' | 'returnedFromNodeKey' | 'round' | 'businessVersion' | 'conditionValues'
    >
  >,
): Promise<InstanceRow> {
  const next = { ...instance, ...patch, revision: instance.revision + 1 };
  const done = ['approved', 'withdrawn', 'cancelled'].includes(next.status);
  await tx.execute(sql`UPDATE approval_instances SET status=${next.status},current_node_key=${next.currentNodeKey},
      returned_from_node_key=${next.returnedFromNodeKey},round=${next.round},revision=${next.revision},
      business_version=${next.businessVersion},condition_values=${JSON.stringify(next.conditionValues)}::jsonb,
      updated_at=${ctx.now.toISOString()},completed_at=${done ? ctx.now.toISOString() : null}
    WHERE tenant_id=${ctx.tenantId} AND id=${instance.id}::uuid AND revision=${instance.revision}`);
  return { ...next, completedAt: done ? ctx.now.toISOString() : null };
}
