/**
 * F-326-L 自动变量生命周期（S7e1 骨架）：同一 key 下的提交前任务统一由 `flushAutoVariableLifecycle` 处理，取锁只此一处。
 * 本片只有两种登记：重提判定（§6.2，此时还没有系统停用，判定恒通过）与交接 / 恢复重发推迟的保存收尾（§3.4）；
 * 停用检测（§2.4 的触发点与 `retireDrainedVersions`）随 S7e2，本文件不提前实现。
 * 另含发起与发布互斥的 `lockBoundProcess`（§4）。
 */
import { beforeTransactionCommit, inArray, sql, and, approvalVariables, eq, type Tx } from '@italent/db';
import { approvalError, rowsOf, type ApprovalContext } from './context.js';
import { retireUnreferencedAutoVariables } from './auto-variables.js';
import { lockVariableBatch } from './variables.js';

type Task =
  | { readonly kind: 'save-close'; readonly ctx: ApprovalContext; readonly candidateIds: readonly string[] }
  | {
      readonly kind: 'resume-check';
      readonly ctx: ApprovalContext;
      readonly versionId: string;
      readonly variableIds: readonly string[];
    };

const keyOf = (tenantId: string) => `approval-auto-retire:${tenantId}`;

function register(tx: Tx, task: Task): void {
  beforeTransactionCommit(tx, keyOf(task.ctx.tenantId), task, flushAutoVariableLifecycle);
}

/** 重提的权威判定：提交前，与保存收尾 / 停用检测同一批变量锁之后执行（§6.2、§6.3）。 */
export function registerResumeCheck(
  tx: Tx,
  ctx: ApprovalContext,
  version: { readonly id: string },
  variableIds: readonly string[],
): void {
  register(tx, { kind: 'resume-check', ctx, versionId: version.id, variableIds });
}

/** 交接 / 恢复重发推迟的保存收尾（§3.4）：以原上下文（操作者、口径）在提交前执行，结果与中段执行相同。 */
export function registerSaveClose(tx: Tx, ctx: ApprovalContext, candidateIds: readonly string[]): void {
  register(tx, { kind: 'save-close', ctx, candidateIds });
}

const restartError = () => approvalError('CONFLICT', 'APPROVAL_PROCESS_UPDATED_RESTART', '流程已更新，请重新发起');

/**
 * 版本引用的自动变量里已被“系统停用”的（§6.2）。S7e1 还没有系统停用动作（停用检测随 S7e2），恒为空；
 * 预检与提交前判定都经它，S7e2 只需替换这一个函数体。
 */
export async function systemRetiredVariables(
  _tx: Tx,
  _ctx: ApprovalContext,
  _versionId: string,
  _variableIds: readonly string[],
): Promise<string[]> {
  return [];
}

/** 重提预检（事务中段，不加锁）：有结果即 409，给出明确错误，避免后续先因 `[nobody]` 等报别的错。 */
export async function assertResumable(
  tx: Tx,
  ctx: ApprovalContext,
  version: { readonly id: string },
  variableIds: readonly string[],
): Promise<void> {
  if ((await systemRetiredVariables(tx, ctx, version.id, variableIds)).length) throw restartError();
}

/**
 * 提交前任务（§2.4）：快路径不加锁地算出要锁的变量；为空就结束，不取任何锁。
 * 否则一批 FOR UPDATE（升序，经锁台账：台账为空正常取，非空须是已持 UPDATE 的子集，否则程序错误并回滚），
 * 锁后先做重提判定，再执行推迟的保存收尾。
 */
export async function flushAutoVariableLifecycle(tx: Tx, tasks: Task[]): Promise<void> {
  const tenantId = tasks[0]!.ctx.tenantId;
  const resumeIds = [...new Set(tasks.flatMap((task) => (task.kind === 'resume-check' ? task.variableIds : [])))];
  const autoOfResume = resumeIds.length
    ? await tx
        .select({ id: approvalVariables.id })
        .from(approvalVariables)
        .where(
          and(
            eq(approvalVariables.tenantId, tenantId),
            eq(approvalVariables.origin, 'auto'),
            inArray(approvalVariables.id, resumeIds),
          ),
        )
    : [];
  const closeIds = tasks.flatMap((task) => (task.kind === 'save-close' ? task.candidateIds : []));
  const wanted = [...new Set([...autoOfResume.map((row) => row.id), ...closeIds])].sort();
  if (!wanted.length) return;
  await lockVariableBatch(
    tx,
    { tenantId },
    wanted.map((id) => ({ id, mode: 'update' as const })),
  );
  for (const task of tasks)
    if (
      task.kind === 'resume-check' &&
      (await systemRetiredVariables(tx, task.ctx, task.versionId, task.variableIds)).length
    )
      throw restartError();
  for (const task of tasks)
    if (task.kind === 'save-close')
      await retireUnreferencedAutoVariables(tx, task.ctx, { update: [...task.candidateIds].sort() });
}

/**
 * 发起与发布互斥（§4）：在插入实例之前对流程头取 FOR SHARE，并确认匹配到的版本仍是当前版本。
 * 发布 / 作废对流程头取 FOR UPDATE，与它互斥：发起先拿到则发布等到实例落库；发布先拿到则这里读到新状态，
 * 409 让用户重新发起（不自动重新匹配，规则可能已变，§4.2）。
 */
export async function lockBoundProcess(
  tx: Tx,
  ctx: ApprovalContext,
  matched: { readonly processId: string; readonly version: { readonly id: string } },
): Promise<void> {
  const [head] = rowsOf<{ status: string; current_version_id: string | null }>(
    await tx.execute(sql`SELECT status, current_version_id::text AS current_version_id FROM approval_processes
      WHERE tenant_id=${ctx.tenantId}::uuid AND id=${matched.processId}::uuid FOR SHARE`),
  );
  if (!head || head.status !== 'active' || head.current_version_id !== matched.version.id)
    throw approvalError('CONFLICT', 'APPROVAL_PROCESS_VERSION_CHANGED', '流程已更新，请重新发起');
}
