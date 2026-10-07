/** 业务字段与协议结构分开；顶层与嵌套字段采用同一份当前查看权。 */
export function visibleFields(fields: object, visible: ReadonlySet<string>, prefix = '') {
  return Object.fromEntries(Object.entries(fields).filter(([code]) => visible.has(`${prefix}${code}`)));
}
