/** 子树遍历所需的最小形状：组织 ID 与行政上级（OrgRecord 满足）。 */
export interface SubtreeNode {
  readonly id: string;
  readonly parents: { readonly admin?: { readonly parentId: string | null } };
}

/**
 * 按行政维度向下 BFS，返回根以下的全部组织 ID（不含根）；本组织在该时点已失效时，仍按下级记录的上级 ID 找到它们。
 * 兄弟按快照出现顺序；根与已见节点跳过，所以重复边、环（含回到根的边）下每个 ID 只输出一次且不死循环。
 * F-470：抽成纯函数以便单测锁定防御性边界（现数据模型的层级校验使环不可达）。
 */
export function adminSubtree(snapshot: readonly SubtreeNode[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const node of snapshot) {
    const parentId = node.parents.admin?.parentId;
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), node.id]);
  }
  const found: string[] = [];
  const seen = new Set<string>(); // 去重改 Set 查找（F-440）；found 仍按遍历顺序输出
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === rootId || seen.has(id)) continue;
    seen.add(id);
    found.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return found;
}
