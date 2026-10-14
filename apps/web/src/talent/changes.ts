/**
 * 编辑时只提交改动过的字段：没有编辑权限的字段原样不动就不会被当作写入（字段级编辑权，REQ-PRM-001）；
 * 显式清空（改成空值）照常提交，由服务端按编辑权判定。
 */
export function changedFields<T extends Record<string, unknown>>(original: Partial<T>, draft: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) => JSON.stringify(original[key] ?? null) !== JSON.stringify(value ?? null),
    ),
  ) as Partial<T>;
}
