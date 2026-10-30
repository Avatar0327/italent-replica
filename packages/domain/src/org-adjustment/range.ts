/** 已有组织与本单新增明细分开标识，避免尚无 orgId 的新增组织和已有组织混用。 */
export type AdjustmentOrgRef = { readonly kind: 'org' | 'item'; readonly id: string };
export interface AdjustmentRangeNode {
  readonly ref: AdjustmentOrgRef;
  readonly parent: AdjustmentOrgRef | null;
}
const keyOf = (ref: AdjustmentOrgRef) => `${ref.kind}:${ref.id}`;

/**
 * R2-T08 §5.6：所选组织在生效日的行政子树，叠加本单新增组织。调用方提供同租户、生效日的行政父链与本单新增项；
 * 不混入业务/财务维度，不以明细拟变更上级扩大已有组织范围。空范围、未知引用、断链、循环均不放行。
 */
export function isInAdjustmentRange(
  target: AdjustmentOrgRef,
  selectedOrgIds: readonly string[],
  nodes: readonly AdjustmentRangeNode[],
): boolean {
  if (selectedOrgIds.length === 0) return false;
  const roots = new Set(selectedOrgIds);
  const byKey = new Map(nodes.map((node) => [keyOf(node.ref), node]));
  const visited = new Set<string>();
  let ref: AdjustmentOrgRef | null = target;
  while (ref) {
    const key = keyOf(ref);
    if (visited.has(key)) return false;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) return false;
    if (ref.kind === 'org' && roots.has(ref.id)) return true;
    ref = node.parent;
  }
  return false;
}
