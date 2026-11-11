/**
 * F-478 S2 详情的路径披露（设计 §4）：`path` 把版本里的节点标成 passed / current / pending / not_on_path，
 * `exits` 是查看人此刻能办理的出口。passed 的出口取自节点最近一次激活的结算结果（单人节点看任务是否走到结算、会签走领域结算，实际走过的），
 * pending 用引擎同一个求值函数按当前快照与默认同意出口推演（walkDefaultPath），不另写一套路由解释。
 */
import { sql, type Tx } from '@italent/db';
import {
  availableBusinessExits,
  BUSINESS_EXIT_LABELS,
  EXIT_LABELS,
  exitRulesOf,
  hasBusinessExits,
  isCountersign,
  nodeExits,
  tenantLocalDate,
  walkDefaultPath,
  type ApprovalNode,
  type AnyNodeExit,
  type ApprovalTypeCode,
  type BusinessExit,
  type NodeExit,
  type PathWalk,
} from '@italent/domain';
import type { BusinessSnapshot } from './adapters.js';
import { rowsOf, type ApprovalContext } from './context.js';
import { settledOutcome } from './countersign.js';
import type { InstanceRow, TaskRow } from './store.js';
import { AWAITING_STATUSES } from './task-state.js';
import { withoutRetrieved } from './task-history.js';
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

interface EntryRow {
  readonly nodeKey: string;
  readonly activationId: string;
  readonly kind: string;
  readonly fromNodeKey: string | null;
  readonly fromActivationId: string | null;
  readonly fromExit: string | null;
}

async function entriesOf(tx: Tx, tenantId: string, instance: InstanceRow): Promise<EntryRow[]> {
  const rows = rowsOf(
    await tx.execute(sql`SELECT activation_id,node_key,entry_kind,from_activation_id,from_node_key,from_exit
      FROM approval_node_activations
      WHERE tenant_id=${tenantId} AND instance_id=${instance.id}::uuid AND round=${instance.round}
      ORDER BY created_seq`),
  );
  return rows.map((row) => ({
    nodeKey: String(row.node_key),
    activationId: String(row.activation_id),
    kind: String(row.entry_kind),
    fromNodeKey: (row.from_node_key as string | null) ?? null,
    fromActivationId: (row.from_activation_id as string | null) ?? null,
    fromExit: (row.from_exit as string | null) ?? null,
  }));
}

/** 任务关闭时记下的出口（approval_tasks.decision_exit）；TaskRow 不带这一列，所以单独取。 */
async function decisionExits(tx: Tx, tenantId: string, instance: InstanceRow): Promise<Map<string, string>> {
  const rows = rowsOf(
    await tx.execute(sql`SELECT id,decision_exit FROM approval_tasks
      WHERE tenant_id=${tenantId} AND instance_id=${instance.id}::uuid AND round=${instance.round}
        AND decision_exit IS NOT NULL`),
  );
  return new Map(rows.map((row) => [String(row.id), String(row.decision_exit)]));
}

/**
 * 单人节点这一次激活的结算出口，与办理引擎同口径。引擎只在两处让单人节点流转出去：不同意（disagreeTask 直接
 * followExit，不论发生在加签链的哪一环）；同意（afterNodeApproved 在本节点再没有待审批 / 排队任务时 followExit）。
 * 任务上的 decision_exit 只是“这一票”的表态——后加签先给本人写同意、前加签人与转交接任人的同意都是中间票——所以不按
 * “哪一票最后”（任务序号随转交、排队加签并不等于办理顺序）取，而看这次激活（剔除撤回作废部分）有没有走到结算：
 * 有不同意 → disagree；被驳回、被跳转 / 取消截断（cancelled）、仍有待办或排队（加签链没走完）→ 没有出口；
 * 其余（至少一张同意 / 跳过且没有未完成任务）→ 流转的同意族出口。本次激活里所有同意 / 跳过任务出口相同（人工恒为
 * approve，自动处理的节点只有一张任务），取其记下的出口，旧任务没有记录时按 approve。
 */
function settledExitOf(activation: readonly TaskRow[], decided: ReadonlyMap<string, string>): string | null {
  const live = withoutRetrieved(activation);
  if (live.some((task) => task.status === 'disagreed')) return 'disagree';
  const unsettled = (task: TaskRow) =>
    task.status === 'rejected' || task.status === 'cancelled' || AWAITING_STATUSES.has(task.status);
  if (live.some(unsettled)) return null;
  const settled = live.find((task) => task.status === 'approved' || task.status === 'skipped');
  return settled ? (decided.get(settled.id) ?? 'approve') : null;
}

/**
 * 节点这一次激活实际走的出口。会签按领域结算（票的口径与引擎同源），不用某一个人的票代替；单人节点见 settledExitOf。
 * 只有激活里没有任何任务（本版本上线前办理、没有激活行的节点）才退回台账里的流转行——撤回会让同一次激活重新办理，
 * 台账里那条流转行可能已作废，有任务时一律以任务结算为准。
 */
function exitOfActivation(
  node: ApprovalNode | undefined,
  activation: readonly TaskRow[],
  decided: ReadonlyMap<string, string>,
  flowFallback: string | null,
): string | null {
  if (node && isCountersign(node)) {
    const outcome = settledOutcome(activation, exitRulesOf(node.transitionRule, nodeExits(node)));
    return outcome.kind === 'flow' ? outcome.exit : null;
  }
  return activation.length === 0 ? flowFallback : settledExitOf(activation, decided);
}

/** 台账里从这次激活出去的最近一条流转（兼容本版本上线前在途、没有激活行的节点：来路激活为空）。 */
function flowFrom(entries: readonly EntryRow[], nodeKey: string, activationId: string | null): string | null {
  const flow = entries
    .filter(
      (entry) =>
        entry.kind === 'flow' &&
        entry.fromNodeKey === nodeKey &&
        (activationId === null ? entry.fromActivationId === null : entry.fromActivationId === activationId),
    )
    .at(-1);
  return flow?.fromExit ?? null;
}

/**
 * 本轮进入过的节点 → 它最近一次激活的实际出口。重入（驳回到上一步、跳转、撤回后重办）以最近一次激活为准，旧出口
 * 随之作废；没有走出去的激活（办理中、被驳回 / 跳转中断）没有出口。
 */
async function activatedExits(
  tx: Tx,
  tenantId: string,
  instance: InstanceRow,
  nodes: readonly ApprovalNode[],
  allTasks: readonly TaskRow[],
): Promise<Map<string, string | null>> {
  const entries = await entriesOf(tx, tenantId, instance);
  const latest = new Map<string, string | null>();
  for (const entry of entries) {
    latest.set(entry.nodeKey, entry.activationId);
    if (entry.kind === 'flow' && entry.fromNodeKey && !latest.has(entry.fromNodeKey)) {
      latest.set(entry.fromNodeKey, null);
    }
  }
  const tasks = allTasks.filter((task) => task.round === instance.round);
  const decided = await decisionExits(tx, tenantId, instance);
  const activated = new Map<string, string | null>();
  for (const [nodeKey, activationId] of latest) {
    const activation = tasks.filter((task) => activationId !== null && task.activationId === activationId);
    const node = nodes.find((candidate) => candidate.key === nodeKey);
    activated.set(nodeKey, exitOfActivation(node, activation, decided, flowFrom(entries, nodeKey, activationId)));
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
  /** 详情已加载的完整任务（readDetail.allTasks），复用以免再扫一遍任务表。 */
  allTasks: readonly TaskRow[],
): Promise<PathFacts> {
  return {
    activated: await activatedExits(tx, ctx.tenantId, instance, nodes, allTasks),
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
  readonly code: AnyNodeExit;
  readonly label: string;
  readonly family: NodeExit;
}

/**
 * 与 actions 同一判定：公布了「同意 / 不同意」才有对应出口。业务出口节点（F-478 S4）的「同意」换成守卫成立的业务出口
 * （办理人不能改变 reEmployed，所以只剩一个），名称取业务出口的名称；守卫都不成立时不披露任何同意出口，办理入口同样 409。
 */
export function exitsView(
  actions: readonly string[],
  node?: ApprovalNode | null,
  snapshot?: Pick<BusinessSnapshot, 'approvalType' | 'conditionValues'>,
): ExitView[] {
  const business =
    node && snapshot && hasBusinessExits(node)
      ? availableBusinessExits(node, snapshot.approvalType, snapshot.conditionValues ?? {})
      : null;
  return (['approve', 'disagree'] as const)
    .filter((code) => actions.includes(code))
    .flatMap((code): ExitView[] => {
      if (code !== 'approve' || business === null) return [{ code, label: EXIT_LABELS[code], family: code }];
      return business.map((exit) => ({
        code: exit as AnyNodeExit,
        label: BUSINESS_EXIT_LABELS[exit as BusinessExit],
        family: 'approve',
      }));
    });
}
