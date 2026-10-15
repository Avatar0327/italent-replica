// F-142（DEC-502②，claude_fe_rules e）：恢复槽键。未确认的命令按稳定原单路径存放（新建为集合路径），
// 键里不带日期、视图、动作或入口；日期等命令上下文存进槽里（store SubmitInput.context）。
const volatile = /[?#@:]|(^|\/)\d{4}-\d{2}-\d{2}(\/|$)/;

export function slotKey(collection: string, id?: string) {
  if (!collection.startsWith('/') || volatile.test(collection))
    throw new Error(`slotKey: ${collection} is not a stable collection path`);
  if (id === undefined) return collection;
  if (!id) throw new Error('slotKey: empty id');
  return `${collection}/${encodeURIComponent(id)}`;
}
