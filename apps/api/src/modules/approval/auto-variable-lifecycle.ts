/** F-326-L §2.4：停用、重提判定、重发收尾在同一提交前任务合并取锁。 */
import { beforeTransactionCommit, inArray, sql, and, approvalVariables, eq, type Tx } from '@italent/db';
import { approvalError, rowsOf, type ApprovalContext } from './context.js';
import { retireUnreferencedAutoVariables } from './auto-variables.js';
import { drainedVersions, versionAutoVariableReferences } from './source-usages.js';
import type { InstanceRow } from './store.js';
import { lockVariableBatch } from './variables.js';

const OLD_VERSION_REASON = '旧版本在途单清零自动停用';
const DISCARDED_PROCESS_REASON = '作废流程在途单清零自动停用';

type Trigger =
  | { kind: 'instance'; instanceId: string; status: InstanceRow['status'] }
  | { kind: 'publish'; newVersionId: string }
  | { kind: 'discard' };
interface RetirementTask {
  readonly kind: 'retire';
  readonly ctx: ApprovalContext;
  readonly versionIds: readonly string[];
  readonly trigger: Trigger;
}

type Task =
  | RetirementTask
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

/** 三个挂点只登记版本与触发命令，事务主体不为停用取锁。 */
export function registerRetirement(
  tx: Tx,
  ctx: ApprovalContext,
  versionIds: readonly string[],
  trigger: Trigger,
): void {
  if (versionIds.length) register(tx, { kind: 'retire', ctx, versionIds, trigger });
}

const restartError = () => approvalError('CONFLICT', 'APPROVAL_PROCESS_UPDATED_RESTART', '流程已更新，请重新发起');

/** F-326-L §6.2：最近一次状态类审计同时满足动作、系统操作者和原因，才属于系统停用。 */
export async function systemRetiredVariables(
  tx: Tx,
  ctx: ApprovalContext,
  _versionId: string,
  variableIds: readonly string[],
): Promise<string[]> {
  if (!variableIds.length) return [];
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT v.id FROM approval_variables v
      CROSS JOIN LATERAL (
        SELECT a.action, a.actor_user_id, a.after
        FROM audit_events a LEFT JOIN approval_outbox o
          ON o.tenant_id=a.tenant_id AND o.object_type=a.object_type AND o.object_id=v.id
            AND o.event_type=a.action AND o.command_id=a.command_id
        WHERE a.tenant_id=v.tenant_id AND a.object_type='approval-public-variable' AND a.object_id=v.id::text
          AND a.action IN ('approval.public_variable.enable', 'approval.public_variable.disable',
            'approval.public_variable.auto_disable')
        -- 同时钟或请求先到、后取锁时，修订号仍能给出真正的写入顺序。
        ORDER BY o.revision DESC NULLS LAST, a.occurred_at DESC, a.id DESC LIMIT 1
      ) latest
      WHERE v.tenant_id=${ctx.tenantId}::uuid AND v.origin='auto' AND v.status='disabled'
        AND v.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(variableIds)}::jsonb))
        AND latest.action='approval.public_variable.auto_disable' AND latest.actor_user_id IS NULL
        AND latest.after->>'reason' IN (${OLD_VERSION_REASON}, ${DISCARDED_PROCESS_REASON})`),
  );
  return rows.map((row) => row.id);
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

async function retireDrainedVersions(
  tx: Tx,
  ctx: ApprovalContext,
  registered: ReadonlyMap<string, RetirementTask>,
  references: Awaited<ReturnType<typeof versionAutoVariableReferences>>,
) {
  if (!references.length) return;
  const byVersion = new Map<string, string[]>();
  for (const { version_id, variable_id } of references) {
    const ids = byVersion.get(version_id);
    if (ids) ids.push(variable_id);
    else byVersion.set(version_id, [variable_id]);
  }
  const candidates = new Map<string, { ctx: ApprovalContext; after: Record<string, unknown> }>();
  for (const version of await drainedVersions(tx, ctx.tenantId, [...byVersion.keys()])) {
    const task = registered.get(version.id)!;
    const after = {
      reason: version.discarded ? DISCARDED_PROCESS_REASON : OLD_VERSION_REASON,
      processId: version.process_id,
      versionId: version.id,
      versionNo: version.version_no,
      trigger: task.trigger,
    };
    // drainedVersions 按版本号、版本 ID 排序，同一变量采用首个清零版本的命令和审计信息。
    for (const id of byVersion.get(version.id)!)
      if (!candidates.has(id)) candidates.set(id, { ctx: { ...task.ctx, actorUserId: null }, after });
  }
  await retireUnreferencedAutoVariables(
    tx,
    ctx,
    { update: [...candidates.keys()].sort() },
    {
      usage: 'lifecycle',
      after: (id) => candidates.get(id)!.after,
      context: (id) => candidates.get(id)!.ctx,
    },
  );
}

/**
 * 提交前任务（§2.4）：快路径不加锁地算出要锁的变量；为空就结束，不取任何锁。
 * 否则一批 FOR UPDATE（升序，经锁台账：台账为空正常取，非空须是已持 UPDATE 的子集，否则程序错误并回滚），
 * 锁后先做重提判定，再检测清零版本与推迟的保存收尾。
 */
export async function flushAutoVariableLifecycle(tx: Tx, tasks: Task[]): Promise<void> {
  const ctx = tasks[0]!.ctx;
  const { tenantId } = ctx;
  const registered = new Map<string, RetirementTask>();
  for (const task of tasks)
    if (task.kind === 'retire')
      for (const versionId of task.versionIds) if (!registered.has(versionId)) registered.set(versionId, task);
  const references = await versionAutoVariableReferences(tx, tenantId, [...registered.keys()]);
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
  const wanted = [
    ...new Set([...autoOfResume.map((row) => row.id), ...closeIds, ...references.map((row) => row.variable_id)]),
  ].sort();
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
  await retireDrainedVersions(tx, ctx, registered, references);
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
