/** F-057 / DEC-325③ / DEC-327：上级引用只展示姓名，头像留空；不读取证件照或其他人员资料。 */
import { and, eq, inArray, isUuid, survey360People, type Tx } from '@italent/db';

/** 同一批响应或审计前后快照只查一次姓名，避免逐行查询与前后值之间的虚假姓名差异。 */
export async function superiorNames(tx: Tx, tenantId: string, values: readonly (string | null | undefined)[]) {
  const ids = [...new Set(values.filter((id): id is string => !!id && isUuid(id)).map((id) => id.toLowerCase()))];
  if (!ids.length) return new Map<string, string>();
  const found = await tx
    .select({ id: survey360People.id, name: survey360People.name })
    .from(survey360People)
    .where(and(eq(survey360People.tenantId, tenantId), inArray(survey360People.id, ids)));
  return new Map(found.map((person) => [person.id, person.name]));
}

export function superiorSummary(id: string | null, names: ReadonlyMap<string, string>, fields?: ReadonlySet<string>) {
  if (id === null) return null;
  const name = names.get(id.toLowerCase());
  return { id, ...(name !== undefined && (!fields || fields.has('name')) ? { name } : {}), avatar: null };
}

function snapshotSuperior(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as { superiorPersonId?: unknown }).superiorPersonId;
  return id === null ? null : typeof id === 'string' && isUuid(id) ? id.toLowerCase() : undefined;
}

/** 审计沿用写入事务冻结引用显示值的约定；null 前后值原样保留，不改变新增 / 删除分类。 */
export async function superiorSnapshots(tx: Tx, tenantId: string, before: unknown, after: unknown) {
  const beforeId = snapshotSuperior(before);
  const afterId = snapshotSuperior(after);
  const names = await superiorNames(tx, tenantId, [beforeId, afterId]);
  const freeze = (value: unknown, id: string | null | undefined) =>
    id === undefined ? value : { ...(value as Record<string, unknown>), superior: superiorSummary(id, names) };
  return { before: freeze(before, beforeId), after: freeze(after, afterId) };
}
