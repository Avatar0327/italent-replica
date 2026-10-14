/**
 * 命令类型（F-120）：写命令请求的“方法 路径模板”，路径里的 UUID 段统一换成 :id。
 * 命令台账与失败命令审计用同一函数生成，本人回查时两类记录口径一致，且不把业务对象 ID 带进结果摘要。
 */
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

export function commandTypeOf(method: string | null | undefined, path: string | null | undefined): string | null {
  if (!method || !path) return null;
  return `${method.toUpperCase()} ${path.replace(UUID_SEGMENT, '/:id')}`;
}
