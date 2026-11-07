/**
 * F-478 S2 详情的路径披露（设计 §4）：`path` 把版本里的节点标成 passed / current / pending / not_on_path，
 * `exits` 是查看人此刻能办理的出口。passed 的出口取自节点激活台账与任务的 decision_exit（实际走过的），
 * pending 用引擎同一个求值函数按当前快照与默认同意出口推演（walkDefaultPath），不另写一套路由解释。
 */
import { sql, type Tx } from '@italent/db';
import {
  EXIT_LABELS,
  tenantLocalDate,
  walkDefaultPath,
  type ApprovalNode,
  type ApprovalTypeCode,
  type NodeExit,
  type PathWalk,
} from '@italent/domain';
import { rowsOf, type ApprovalContext } from './context.js';
import type { InstanceRow } from './store.js';
import { conditionContext } from './matching.js';

export interface PathFacts {
  /** 本轮进入过的节点 → 离开它时走的出口（最后一个节点或不可考的为 null）。 */
  readonly activated: ReadonlyMap<string, string | null>;
  /** 从当前节点按默认同意出口推演的结果；实例已结束或推演失败为 null。 */
  readonly walk: PathWalk | null;
}

export const NO_PATH_FACTS: PathFacts = { activated: new Map(), walk: null };

export interface PathStepView {
  readonly nodeKey: string;
  readonly name: string;
  readonly state: 'passed' | 'current' | 'pending' | 'not_on_path';
  readonly exit?: string;
}

async function activatedExits(tx: Tx, tenantId: string, instance: InstanceRow) {
  const activated = new Map<string, string | null>();
  const rows = rowsOf(
    await tx.execute(sql`SELECT node_key,entry_kind,from_node_key,from_exit FROM approval_node_activations
      WHERE tenant_id=${tenantId} AND instance_id=${instance.id}::uuid AND round=${instance.round}
      ORDER BY created_seq`),
  );
  for (const row of rows) {
    const key = String(row.node_key);
    if (!activated.has(key)) activated.set(key, null);
    if (row.entry_kind === 'flow') activated.set(String(row.from_node_key), String(row.from_exit));
  }
  // 最后一个节点没有“下一次激活”：出口只记在它关闭的任务上
  const decided = rowsOf(
    await tx.execute(sql`SELECT DISTINCT ON (node_key) node_key,decision_exit FROM approval_tasks
      WHERE tenant_id=${tenantId} AND instance_id=${instance.id}::uuid AND round=${instance.round}
        AND decision_exit IS NOT NULL ORDER BY node_key,seq DESC`),
  );
  for (const row of decided) {
    const key = String(row.node_key);
    if (activated.has(key) && activated.get(key) === null) activated.set(key, String(row.decision_exit));
  }
  return activated;
}

/** 推演不能让详情失败：版本配置异常（引擎自己会报 ROUTE_LOOP / 无后继）时只是不画 pending。 */
async function pendingWalk(
  tx: Tx,
  ctx: ApprovalContext,
  instance: InstanceRow,
  nodes: readonly ApprovalNode[],
  values: Readonly<Record<string, unknown>>,
) {
  if (instance.status !== 'running' || !instance.currentNodeKey) return null;
  const hasRoutes = nodes.some((node) => node.routes?.length);
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  try {
    const context = hasRoutes
      ? await conditionContext(tx, ctx.tenantId, asOf, instance.approvalType as ApprovalTypeCode, values)
      : { values: {}, orgAncestors: {} };
    return walkDefaultPath(nodes, instance.currentNodeKey, instance.approvalType, context, false);
  } catch {
    return null;
  }
}

export async function loadPathFacts(
  tx: Tx,
  ctx: ApprovalContext,
  instance: InstanceRow,
  nodes: readonly ApprovalNode[],
  conditionValues: Readonly<Record<string, unknown>>,
): Promise<PathFacts> {
  return {
    activated: await activatedExits(tx, ctx.tenantId, instance),
    walk: await pendingWalk(tx, ctx, instance, nodes, conditionValues),
  };
}

/** 节点状态：当前 > 推演路径上 > 已走过 > 推演停住之后（不预判）> 路径外。 */
export function pathView(
  nodes: readonly ApprovalNode[],
  currentNodeKey: string | null,
  facts: PathFacts,
): PathStepView[] {
  const onWalk = new Set((facts.walk?.steps ?? []).map((step) => step.nodeKey));
  const lastWalked = facts.walk?.steps.at(-1)?.nodeKey;
  const stopped = facts.walk !== null && facts.walk.end !== 'end';
  const stopIndex = lastWalked === undefined ? -1 : nodes.findIndex((node) => node.key === lastWalked);
  const currentIndex = nodes.findIndex((node) => node.key === currentNodeKey);
  // 本片上线前已在途的实例没有激活行（DEC-402）：按节点顺序，当前节点之前都算走过
  const legacy = facts.activated.size === 0 && currentIndex > 0;
  return nodes.map((node, index): PathStepView => {
    const base = { nodeKey: node.key, name: node.name };
    if (node.key === currentNodeKey) return { ...base, state: 'current' };
    if (onWalk.has(node.key)) return { ...base, state: 'pending' };
    if (facts.activated.has(node.key) || (legacy && index < currentIndex)) {
      const exit = facts.activated.get(node.key);
      return { ...base, state: 'passed', ...(exit ? { exit } : {}) };
    }
    return { ...base, state: stopped && index > stopIndex ? 'pending' : 'not_on_path' };
  });
}

export interface ExitView {
  readonly code: NodeExit;
  readonly label: string;
  readonly family: NodeExit;
}

/** 与 actions 同一判定：公布了「同意 / 不同意」才有对应出口（业务出口由 S3 随出口组登记后接入）。 */
export function exitsView(actions: readonly string[]): ExitView[] {
  return (['approve', 'disagree'] as const)
    .filter((code) => actions.includes(code))
    .map((code) => ({ code, label: EXIT_LABELS[code], family: code }));
}
