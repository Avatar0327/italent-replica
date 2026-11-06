/**
 * F-478 节点激活台账（设计 §3.2.1）：每次进入节点追加一行，记录进入方式与来路；路径前驱只从这里取，
 * 不再按“最近一条已同意的任务”或 seq 下标反推。台账只追加（迁移 0197 触发器），命令台账重放不会走到这里。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf, type Row } from './context.js';
import type { Run } from './engine.js';

/** 进入节点的方式与来路：`nodeKey / activationId` 是前驱节点及其那一次激活。 */
export type EntryFrom =
  | { readonly kind: 'start' }
  | {
      readonly kind: 'flow';
      readonly nodeKey: string;
      readonly activationId: string | null;
      readonly exit: string;
      readonly branchNo: number | null;
    }
  | {
      readonly kind: 'jump' | 'reject_previous' | 'resubmit';
      readonly nodeKey: string | null;
      readonly activationId: string | null;
    };

export interface Predecessor {
  readonly nodeKey: string | null;
  readonly activationId: string | null;
}

const NONE: Predecessor = { nodeKey: null, activationId: null };

export function predecessorOf(from: EntryFrom): Predecessor {
  if (from.kind === 'start') return NONE;
  return { nodeKey: from.nodeKey, activationId: from.activationId };
}

/** 进入节点时追加一行；`created_seq` 在实例行锁内按实例递增，保证进入顺序可重放。 */
export async function recordActivation(
  tx: Tx,
  run: Run,
  activationId: string,
  nodeKey: string,
  from: EntryFrom,
): Promise<void> {
  const { ctx, instance } = run;
  const before = predecessorOf(from);
  await tx.execute(sql`INSERT INTO approval_node_activations
    (tenant_id,activation_id,instance_id,round,node_key,entry_kind,from_activation_id,from_node_key,from_exit,
     from_branch_no,created_seq,created_at)
    VALUES (${ctx.tenantId},${activationId}::uuid,${instance.id}::uuid,${instance.round},${nodeKey},${from.kind},
      ${before.activationId}::uuid,${before.nodeKey},${from.kind === 'flow' ? from.exit : null},
      ${from.kind === 'flow' ? from.branchNo : null},
      (SELECT COALESCE(MAX(created_seq),0)+1 FROM approval_node_activations
        WHERE tenant_id=${ctx.tenantId} AND instance_id=${instance.id}::uuid),
      ${ctx.now.toISOString()})`);
}

function predecessorRow(row: Row | undefined): Predecessor | null {
  if (!row) return null;
  return {
    nodeKey: (row.from_node_key as string | null) ?? null,
    activationId: (row.from_activation_id as string | null) ?? null,
  };
}

/** 某次激活的前驱；没有激活行（本片上线前已在途的实例）返回 null，由调用方按 seq 前一节点处理（DEC-402）。 */
export async function predecessorOfActivation(
  tx: Tx,
  tenantId: string,
  activationId: string,
): Promise<Predecessor | null> {
  const result = await tx.execute(sql`SELECT from_node_key,from_activation_id FROM approval_node_activations
    WHERE tenant_id=${tenantId} AND activation_id=${activationId}::uuid`);
  return predecessorRow(rowsOf(result)[0]);
}

/** 版本内 seq 前一节点（现状规则，也是找不到激活行与跳转时的前驱）。 */
export function seqPredecessor(run: Run, nodeKey: string): Predecessor {
  const index = run.version.nodes.findIndex((node) => node.key === nodeKey);
  return index > 0 ? { nodeKey: run.version.nodes[index - 1]!.key, activationId: null } : NONE;
}

/** 当前任务的路径前驱（驳回到上一步的去向、披露与命令共用同一判定）。 */
export async function pathPredecessor(
  tx: Tx,
  run: Run,
  task: { readonly nodeKey: string; readonly activationId: string | null },
): Promise<Predecessor> {
  const found = task.activationId ? await predecessorOfActivation(tx, run.ctx.tenantId, task.activationId) : null;
  return found ?? seqPredecessor(run, task.nodeKey);
}

/** 某节点最近一次激活的前驱：驳回到上一步按本轮，驳回重提（rejecting_node）按全部轮次。 */
export async function latestActivationPredecessor(
  tx: Tx,
  run: Run,
  nodeKey: string,
  thisRoundOnly: boolean,
): Promise<Predecessor | null> {
  const { ctx, instance } = run;
  const result = await tx.execute(sql`SELECT from_node_key,from_activation_id FROM approval_node_activations
    WHERE tenant_id=${ctx.tenantId} AND instance_id=${instance.id}::uuid AND node_key=${nodeKey}
      ${thisRoundOnly ? sql`AND round=${instance.round}` : sql``}
    ORDER BY created_seq DESC LIMIT 1`);
  return predecessorRow(rowsOf(result)[0]);
}

/** 驳回到上一步进入前驱 P：继承 P 被回退前那次激活的前驱；P 本轮从未激活（被跳转越过）取 seq 前一节点。 */
export async function rejectPreviousFrom(tx: Tx, run: Run, previousKey: string): Promise<EntryFrom> {
  const inherited = (await latestActivationPredecessor(tx, run, previousKey, true)) ?? seqPredecessor(run, previousKey);
  return { kind: 'reject_previous', ...inherited };
}

/** 驳回重提（rejecting_node）回到驳回节点 R：继承 R 被驳回时那次激活的前驱。 */
export async function resubmitFrom(tx: Tx, run: Run, rejectedKey: string): Promise<EntryFrom> {
  const inherited =
    (await latestActivationPredecessor(tx, run, rejectedKey, false)) ?? seqPredecessor(run, rejectedKey);
  return { kind: 'resubmit', ...inherited };
}

/** 跳转进入目标 T：不经出口，取 seq 前一节点。 */
export function jumpFrom(run: Run, targetKey: string): EntryFrom {
  return { kind: 'jump', ...seqPredecessor(run, targetKey) };
}
