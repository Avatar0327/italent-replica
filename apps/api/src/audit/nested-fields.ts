/**
 * 父对象快照里嵌套的子对象集合（发展目标的 tasks / reviews，K-34 / DEC-216）：存储保留完整内容，输出时父集合字段可见
 * 之外，再按子对象的查看权与子字段联合裁剪——没有子对象查看权时整组去掉，隐藏的子字段去掉（PR #115 第 3 轮 R2-2）。
 * 与业务详情的嵌套裁剪一致（idp/plan-view.ts presentPlan）。
 */
import type { AuditFieldChange } from '@italent/domain';

/** 子集合 → 子对象可见字段：undefined = 全部可见，null = 没有查看权。 */
export type NestedChildren = Readonly<Record<string, ReadonlySet<string> | undefined | null>>;

export class NestedAuditFields extends Set<string> {
  constructor(
    fields: Iterable<string>,
    readonly children: NestedChildren,
  ) {
    super(fields);
  }
}

/** 子记录的标识不是业务内容，随记录保留（与业务详情的列表一致）。 */
const IDENTITY = 'id';

function visibleItems(value: unknown, child: ReadonlySet<string> | undefined): unknown {
  if (child === undefined || !Array.isArray(value)) return value;
  return value.map((item: unknown) =>
    item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).filter(([key]) => key === IDENTITY || child.has(key)))
      : item,
  );
}

/** 父值里一个子集合键的裁剪结果；返回 undefined 表示整组不出现。 */
export function visibleNested(fields: NestedAuditFields, key: string, value: unknown): unknown {
  const child = fields.children[key];
  return child === null ? undefined : visibleItems(value, child);
}

/** 差异里的子集合：前后值同样裁剪，文本按裁剪后的值重新生成；没有子对象查看权的整条去掉。 */
export function visibleNestedChanges(changes: AuditFieldChange[], fields: NestedAuditFields): AuditFieldChange[] {
  return changes.flatMap((change) => {
    if (!(change.field in fields.children)) return [change];
    const child = fields.children[change.field];
    if (child === null) return [];
    const { fromText: _from, toText: _to, ...rest } = change;
    return [{ ...rest, from: visibleItems(change.from, child), to: visibleItems(change.to, child) }];
  });
}
