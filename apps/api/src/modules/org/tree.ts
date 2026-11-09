/**
 * 完整组织树的服务端组装（F-474-2b #1，R1a §2.2）。
 * 输入是已按查看人范围裁剪的节点（范围外组织根本不在其中），层级关系取全量边：
 * 可见节点挂到最近的可见祖先；一路上没有可见祖先就成为根（与组织调整预览同口径，R2-T08 §4.5）。
 * 同级顺序沿用输入顺序（组织名次，DEC-089）。
 */
import type { DimensionEdges } from './headcount.js';

/** 层级校验保证无环；防御性深度上限，超过按无可见祖先处理。 */
const MAX_DEPTH = 64;

export type TreeNode<T> = T & { children: TreeNode<T>[] };

/** 每个节点最近的可见祖先在 ids 中的下标；没有则为 null。 */
export function nearestVisibleParents(ids: readonly string[], edges: Pick<DimensionEdges, 'parentOf'>) {
  const index = new Map(ids.map((id, position) => [id, position]));
  return ids.map((id) => {
    let cursor = edges.parentOf.get(id);
    for (let depth = 0; cursor && depth < MAX_DEPTH; depth++) {
      const found = index.get(cursor);
      if (found !== undefined) return found;
      cursor = edges.parentOf.get(cursor);
    }
    return null;
  });
}

/** 按 parents（下标）把平铺节点嵌套成树；下标成环的节点（防御）也放根层，保证不丢节点。 */
export function nestTree<T extends object>(nodes: readonly T[], parents: readonly (number | null)[]): TreeNode<T>[] {
  const built: TreeNode<T>[] = nodes.map((node) => ({ ...node, children: [] }));
  const roots: TreeNode<T>[] = [];
  built.forEach((node, position) => {
    const parent = parents[position] ?? null;
    if (parent !== null && !cyclic(position, parents)) built[parent]!.children.push(node);
    else roots.push(node);
  });
  return roots;
}

function cyclic(start: number, parents: readonly (number | null)[]) {
  const seen = new Set([start]);
  let cursor = parents[start] ?? null;
  while (cursor !== null) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parents[cursor] ?? null;
  }
  return false;
}
