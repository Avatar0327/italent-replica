/**
 * R2-T08 §5.2：把本单组织明细叠到生效日行政树上，判循环、层级 1～10、挂到本单停用整支下、明细引用。
 * 纯函数、不读库；租户根不计层级（根的直接下级为第 1 层）。暂存行不报问题、不改树，但暂存的新增行仍可被引用
 * （引用暂存行由提交校验报 STAGED_REFERENCE）。
 */
export type OrgAdjustType = 1 | 2 | 3;

export interface OrgPlanItem {
  readonly id: string;
  readonly adjustType: OrgAdjustType;
  readonly targetOrgId: string | null;
  readonly parent: { readonly kind: 'org' | 'item'; readonly id: string } | null;
  readonly isStaged?: boolean;
}

export type OrgPlanReason =
  | 'ORG_ADJUSTMENT_CYCLE'
  | 'ORG_ADJUSTMENT_LEVEL_EXCEEDED'
  | 'ORG_ADJUSTMENT_PARENT_STOPPED'
  | 'ORG_ADJUSTMENT_ITEM_REFERENCE';

export interface OrgPlanIssue {
  readonly itemId: string;
  readonly reason: OrgPlanReason;
  /**
   * 违规的树节点（`o:组织ID` / `i:明细ID`）：超层为超过 10 级的各节点，其它为该行自己的节点。问题行只是归属，
   * 写入按“原因 + 节点”比较操作前后，判断是否本次操作新造成（第 2 轮 P2-5）。
   */
  readonly nodes: readonly string[];
}

export const ORG_MAX_LEVEL = 10;

const nodeOf = (item: OrgPlanItem) => (item.adjustType === 1 ? `i:${item.id}` : `o:${item.targetOrgId}`);

export function planOrgTree(input: {
  readonly rootId: string;
  readonly orgs: readonly { readonly id: string; readonly parentId: string | null }[];
  readonly items: readonly OrgPlanItem[];
}): OrgPlanIssue[] {
  const root = `o:${input.rootId}`;
  const original = new Map<string, string | null>(
    input.orgs.map((org) => [`o:${org.id}`, org.parentId === null ? null : `o:${org.parentId}`]),
  );
  const parentOf = new Map(original);
  const known = (key: string) => key === root || original.has(key);
  const creates = new Map(input.items.filter((item) => item.adjustType === 1).map((item) => [item.id, item]));
  const issues: { itemId: string; reason: OrgPlanReason; nodes: string[] }[] = [];
  const report = (item: OrgPlanItem, reason: OrgPlanReason, node = nodeOf(item)) => {
    if (item.isStaged) return;
    const found = issues.find((issue) => issue.itemId === item.id && issue.reason === reason);
    if (!found) issues.push({ itemId: item.id, reason, nodes: [node] });
    else if (!found.nodes.includes(node)) found.nodes.push(node);
  };
  const resolve = (parent: OrgPlanItem['parent']) => {
    if (!parent) return undefined;
    if (parent.kind === 'item') return creates.has(parent.id) ? `i:${parent.id}` : undefined;
    return known(`o:${parent.id}`) ? `o:${parent.id}` : undefined;
  };
  const stopRoots = new Set(
    input.items
      .filter((item) => item.adjustType === 3 && !item.isStaged && item.targetOrgId)
      .map((item) => `o:${item.targetOrgId}`),
  );
  // 停用整支按生效日原树展开（与连带行同一口径）。
  const stopped = (key: string) => {
    for (let at: string | null | undefined = key, steps = 0; at && steps <= original.size; steps++) {
      if (stopRoots.has(at)) return true;
      at = original.get(at);
    }
    return false;
  };

  const owners = new Map<string, OrgPlanItem>();
  for (const item of input.items) {
    if (item.isStaged && item.adjustType !== 1) continue;
    if (item.adjustType !== 1 && !(item.targetOrgId && known(`o:${item.targetOrgId}`))) {
      report(item, 'ORG_ADJUSTMENT_ITEM_REFERENCE');
      continue;
    }
    if (item.adjustType === 3 || (item.adjustType === 2 && !item.parent)) continue;
    const key = item.adjustType === 1 ? `i:${item.id}` : `o:${item.targetOrgId}`;
    const parent = resolve(item.parent);
    owners.set(key, item);
    // 未知上级视为父链断开：不参与循环与层级判断。
    parentOf.set(key, parent ?? null);
    if (!parent) report(item, 'ORG_ADJUSTMENT_ITEM_REFERENCE');
    else if (parent.startsWith('o:') && stopped(parent)) report(item, 'ORG_ADJUSTMENT_PARENT_STOPPED');
  }

  const cyclic = new Set<string>();
  for (const [key, item] of owners) {
    let at = parentOf.get(key);
    for (let steps = 0; at && steps <= parentOf.size; steps++) {
      if (at === key) {
        cyclic.add(key);
        report(item, 'ORG_ADJUSTMENT_CYCLE');
        break;
      }
      at = parentOf.get(at);
    }
  }

  reportLevels(root, parentOf, owners, cyclic, report);
  return issues;
}

/** 叠加后深度超过 10 级：新增行报自己；整支被压深时报离该组织最近的改上级行。循环上的节点不计深度。 */
function reportLevels(
  root: string,
  parentOf: ReadonlyMap<string, string | null>,
  owners: ReadonlyMap<string, OrgPlanItem>,
  cyclic: ReadonlySet<string>,
  report: (item: OrgPlanItem, reason: OrgPlanReason, node?: string) => void,
) {
  const depths = new Map<string, number | null>([[root, 0]]);
  const depthOf = (key: string): number | null => {
    const path: string[] = [];
    let at: string | null | undefined = key;
    while (at && !depths.has(at) && !path.includes(at)) {
      path.push(at);
      at = parentOf.get(at);
    }
    let depth = at && depths.has(at) && !path.includes(at) ? depths.get(at)! : null;
    for (const node of path.reverse()) {
      depth = depth === null || cyclic.has(node) ? null : depth + 1;
      depths.set(node, depth);
    }
    return depths.get(key) ?? null;
  };
  for (const key of parentOf.keys()) {
    if ((depthOf(key) ?? 0) <= ORG_MAX_LEVEL) continue;
    const own = owners.get(key);
    if (own?.adjustType === 1) report(own, 'ORG_ADJUSTMENT_LEVEL_EXCEEDED', key);
    // 整支被压深：报离该组织最近的改上级行（发起行）。
    for (let at: string | null | undefined = key; at; at = parentOf.get(at)) {
      const owner = owners.get(at);
      if (owner?.adjustType !== 2) continue;
      report(owner, 'ORG_ADJUSTMENT_LEVEL_EXCEEDED', key);
      break;
    }
  }
}
