/**
 * 盘点流程定义的读写（设计 §2.2 flows / nodes / node_roles；DEC-304）。流程是一个聚合：有序节点及其角色随流程整组读写，
 * 修改时 nodes 整组提交——带稳定 id 的是已有节点（node_key 保存后不可改，按 id 判定），不带 id 的是新增，缺席的删除。
 * 节点约束在领域层 checkFlowNodes（countersign 只 evaluate + single；single 恰一个角色、countersign ≥ 1；node_key 流程内唯一）。
 * 引用的角色须当前操作人在角色范围内可见（reference-kit.ts）；角色被节点引用时拒删；流程被模板引用时拒删（B6 登记守卫）。
 * 修改流程不影响已有模板版本：模板版本保存时冻结节点副本（B6），本表只是配置源。
 */
import {
  and,
  asc,
  eq,
  inArray,
  talentReviewFlowNodeRoles as NR,
  talentReviewFlowNodes as N,
  talentReviewFlows as FL,
  talentReviewRoles as R,
  type Tx,
} from '@italent/db';
import { checkFlowNodes } from '@italent/domain';
import { AppError } from '../../errors.js';
import { requireConfigCreatable } from './access.js';
import {
  auditConfig,
  type ConfigSpec,
  type ConfigTable,
  createConfig,
  deleteConfig,
  lockConfigRow,
  registerConfigReferenceGuard,
  requireSeeAllToRename,
  uniqueOr,
} from './config-kit.js';
import type { FlowCreate, FlowNodeBody, FlowPatch } from './form-flow-input.js';
import { checkReferences, type ReferenceWriteContext, type ReferencedTable } from './reference-kit.js';

const row = {
  id: FL.id,
  name: FL.name,
  sortNo: FL.sortNo,
  enabled: FL.enabled,
  revision: FL.revision,
  createdBy: FL.createdBy,
  createdAt: FL.createdAt,
  updatedBy: FL.updatedBy,
  updatedAt: FL.updatedAt,
};
type FlowRow = Omit<typeof FL.$inferSelect, 'tenantId'>;
export interface FlowNodeView {
  readonly id: string;
  readonly nodeKey: string;
  readonly name: string;
  readonly kind: string;
  readonly stepType: string;
  readonly mode: string;
  readonly allowReturn: boolean;
  readonly allowTransfer: boolean;
  readonly allowDisagree: boolean;
  readonly roleIds: string[];
}
export type FlowView = FlowRow & { nodes: FlowNodeView[] };

/** 列表与详情共用：一次查出这批流程的全部节点与角色，按流程归位。 */
export async function withNodes(tx: Tx, tenantId: string, rows: FlowRow[]): Promise<FlowView[]> {
  if (rows.length === 0) return [];
  const nodes = await tx
    .select()
    .from(N)
    .where(
      and(
        eq(N.tenantId, tenantId),
        inArray(
          N.flowId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(N.sortNo), asc(N.id));
  const roles = nodes.length
    ? await tx
        .select()
        .from(NR)
        .where(
          and(
            eq(NR.tenantId, tenantId),
            inArray(
              NR.nodeId,
              nodes.map((n) => n.id),
            ),
          ),
        )
        .orderBy(asc(NR.sortNo), asc(NR.id))
    : [];
  return rows.map((r) => ({
    ...r,
    nodes: nodes
      .filter((n) => n.flowId === r.id)
      .map((n) => ({
        id: n.id,
        nodeKey: n.nodeKey,
        name: n.name,
        kind: n.kind,
        stepType: n.stepType,
        mode: n.mode,
        allowReturn: n.allowReturn,
        allowTransfer: n.allowTransfer,
        allowDisagree: n.allowDisagree,
        roleIds: roles.filter((role) => role.nodeId === n.id).map((role) => role.roleId),
      })),
  }));
}

export const FLOW: ConfigSpec<FlowView> = {
  object: 'flow',
  label: '盘点流程',
  table: FL as unknown as ConfigTable,
  view: row,
  orderBy: [
    ['sortNo', FL.sortNo],
    ['name', FL.name],
  ],
  duplicate: 'FLOW_DUPLICATE',
  inUse: 'FLOW_IN_USE',
  load: async (tx, tenantId, id) => {
    const rows = await tx
      .select(row)
      .from(FL)
      .where(and(eq(FL.tenantId, tenantId), eq(FL.id, id)));
    return (await withNodes(tx, tenantId, rows))[0];
  },
};

const ROLE_REFERENCE = {
  table: R as unknown as ReferencedTable,
  object: 'role',
  disabledReason: 'FLOW_ROLE_DISABLED',
  label: '盘点角色',
} as const;

const invalid = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });

/** 节点结构校验（不读库）：已有节点按 id 对照库中状态，key 不可改；其余由领域层 checkFlowNodes 判定。 */
function checkNodes(nodes: readonly FlowNodeBody[], existing: readonly FlowNodeView[]) {
  const byId = new Map(existing.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (node.id === undefined) continue;
    const held = byId.get(node.id);
    if (!held) throw invalid('FLOW_NODE_NOT_FOUND', '节点不属于本流程');
    if (held.nodeKey !== node.nodeKey) throw invalid('FLOW_NODE_KEY_IMMUTABLE', '节点标识保存后不能修改');
  }
  for (const node of nodes) {
    if (new Set(node.roleIds).size !== node.roleIds.length) {
      throw invalid('FLOW_ROLE_DUPLICATE', `节点 ${node.nodeKey} 的角色重复`);
    }
  }
  const problem = checkFlowNodes(nodes.map((node) => ({ ...node, roleCount: node.roleIds.length })));
  if (problem) throw invalid(problem.reason, problem.message);
}

const nodeColumns = (node: FlowNodeBody, index: number) => ({
  name: node.name,
  kind: node.kind,
  stepType: node.stepType,
  mode: node.mode,
  allowReturn: node.allowReturn,
  allowTransfer: node.allowTransfer,
  allowDisagree: node.allowDisagree,
  sortNo: index + 1,
});
const roleRows = (tenantId: string, nodeId: string, roleIds: readonly string[]) =>
  roleIds.map((roleId, index) => ({ tenantId, nodeId, roleId, sortNo: index + 1 }));

/** 节点同步：缺席的删除（级联角色）、已有的更新并整组替换角色、不带 id 的新增。 */
async function syncNodes(tx: Tx, ctx: ReferenceWriteContext, flowId: string, nodes: readonly FlowNodeBody[]) {
  const scope = and(eq(N.tenantId, ctx.tenantId), eq(N.flowId, flowId));
  const kept = nodes.flatMap((node) => (node.id === undefined ? [] : [node.id]));
  const removed = await tx.select({ id: N.id }).from(N).where(scope);
  const gone = removed.map((n) => n.id).filter((id) => !kept.includes(id));
  if (gone.length > 0) await tx.delete(N).where(and(scope, inArray(N.id, gone)));
  for (const [index, node] of nodes.entries()) {
    let nodeId = node.id;
    if (nodeId === undefined) {
      const [created] = await tx
        .insert(N)
        .values({ tenantId: ctx.tenantId, flowId, nodeKey: node.nodeKey, ...nodeColumns(node, index) })
        .returning({ id: N.id });
      nodeId = created!.id;
    } else {
      await tx
        .update(N)
        .set(nodeColumns(node, index))
        .where(and(eq(N.tenantId, ctx.tenantId), eq(N.id, nodeId)));
      await tx.delete(NR).where(and(eq(NR.tenantId, ctx.tenantId), eq(NR.nodeId, nodeId)));
    }
    if (node.roleIds.length > 0) await tx.insert(NR).values(roleRows(ctx.tenantId, nodeId, node.roleIds));
  }
}

/**
 * 已停用的角色只在“原节点保留原角色”时豁免（审查第 1 轮 P2-01）：按（节点 id × 角色 id）判定，不能把整份流程出现过的角色
 * 合成一个集合——否则任意节点都能沿用其他节点的停用角色。新增节点（含删除后不带 id 重建）、已有节点新增或换成另一节点
 * 原有的角色都算新引用；同一角色只要在任一节点是新引用，就不在返回的豁免集合里。
 */
function heldRoles(existing: readonly FlowNodeView[], nodes: readonly FlowNodeBody[] | undefined): Set<string> {
  const heldBy = new Map(existing.map((n) => [n.id, new Set(n.roleIds)]));
  const requested = nodes ?? existing;
  const fresh = new Set<string>();
  for (const node of requested) {
    const kept = node.id === undefined ? undefined : heldBy.get(node.id);
    for (const roleId of node.roleIds) if (!kept?.has(roleId)) fresh.add(roleId);
  }
  return new Set(requested.flatMap((node) => node.roleIds).filter((roleId) => !fresh.has(roleId)));
}

export async function createFlow(tx: Tx, ctx: ReferenceWriteContext, input: FlowCreate): Promise<FlowView> {
  const { nodes, ...columns } = input;
  requireConfigCreatable(ctx.scope, 'flow');
  checkNodes(nodes, []);
  await checkReferences(tx, ctx, ROLE_REFERENCE, ctx.references ?? [], new Set());
  return createConfig(tx, FLOW, ctx, columns, (id) => syncNodes(tx, ctx, id, nodes));
}

export async function updateFlow(tx: Tx, ctx: ReferenceWriteContext, id: string, patch: FlowPatch): Promise<FlowView> {
  await lockConfigRow(tx, FLOW, ctx, id);
  const before = (await FLOW.load!(tx, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name);
  const { nodes, ...columns } = patch;
  if (nodes !== undefined) checkNodes(nodes, before.nodes);
  await checkReferences(tx, ctx, ROLE_REFERENCE, ctx.references ?? [], heldRoles(before.nodes, nodes));
  await uniqueOr(FLOW.duplicate, FLOW.label, () =>
    tx
      .update(FL)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(FL.tenantId, ctx.tenantId), eq(FL.id, id))),
  );
  if (nodes !== undefined) await syncNodes(tx, ctx, id, nodes);
  const after = (await FLOW.load!(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'flow', 'update', id, before, after);
  return after;
}

export const deleteFlow = (tx: Tx, ctx: ReferenceWriteContext, id: string): Promise<FlowView> =>
  deleteConfig(tx, FLOW, ctx, id);

// 角色被流程节点引用时拒删（外键 restrict 兜底；这里给出可读的 409 ROLE_IN_USE 而不是 500）
registerConfigReferenceGuard('role', async (tx, tenantId, id) => {
  const [found] = await tx
    .select({ id: NR.id })
    .from(NR)
    .where(and(eq(NR.tenantId, tenantId), eq(NR.roleId, id)))
    .limit(1);
  return found ? 'FLOW_NODE_ROLE' : null;
});
