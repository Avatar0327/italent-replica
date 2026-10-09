/** F-058 / DEC-325③ / DEC-327：上级只展示姓名与独立账号头像，不读取证件照或其他人员资料。 */
import { and, eq, inArray, isUuid, survey360People, type Tx } from '@italent/db';
import { personAvatars, type AvatarReference } from '../avatar/references.js';

export interface SuperiorReference {
  readonly name: string;
  readonly avatar: AvatarReference | null;
}

/** 同一批响应或审计前后快照只查一次姓名，避免逐行查询与前后值之间的虚假姓名差异。 */
export async function superiorNames(tx: Tx, tenantId: string, values: readonly (string | null | undefined)[]) {
  const ids = [...new Set(values.filter((id): id is string => !!id && isUuid(id)).map((id) => id.toLowerCase()))];
  if (!ids.length) return new Map<string, SuperiorReference>();
  const found = await tx
    .select({ id: survey360People.id, name: survey360People.name })
    .from(survey360People)
    .where(and(eq(survey360People.tenantId, tenantId), inArray(survey360People.id, ids)));
  const avatars = await personAvatars(tx, tenantId, ids);
  return new Map(found.map((person) => [person.id, { name: person.name, avatar: avatars.get(person.id) ?? null }]));
}

export function superiorSummary(
  id: string | null,
  names: ReadonlyMap<string, SuperiorReference>,
  fields?: ReadonlySet<string>,
) {
  if (id === null) return null;
  const reference = names.get(id.toLowerCase());
  const shown = reference !== undefined && (!fields || fields.has('name'));
  return { id, ...(shown ? { name: reference.name } : {}), avatar: shown ? reference.avatar : null };
}

function snapshotSuperior(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as { superiorPersonId?: unknown }).superiorPersonId;
  return id === null ? null : typeof id === 'string' && isUuid(id) ? id.toLowerCase() : undefined;
}

function snapshotPerson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && isUuid(id) ? id.toLowerCase() : undefined;
}

/** 审计沿用写入事务冻结引用显示值的约定；null 前后值原样保留，不改变新增 / 删除分类。 */
export async function superiorSnapshots(tx: Tx, tenantId: string, before: unknown, after: unknown) {
  const beforeId = snapshotSuperior(before);
  const afterId = snapshotSuperior(after);
  const beforePerson = snapshotPerson(before);
  const afterPerson = snapshotPerson(after);
  const names = await superiorNames(tx, tenantId, [beforeId, afterId, beforePerson, afterPerson]);
  const freeze = (value: unknown, id: string | null | undefined, personId: string | undefined) =>
    id === undefined && personId === undefined
      ? value
      : {
          ...(value as Record<string, unknown>),
          ...(personId === undefined ? {} : { avatar: names.get(personId)?.avatar ?? null }),
          ...(id === undefined ? {} : { superior: superiorSummary(id, names) }),
        };
  return { before: freeze(before, beforeId, beforePerson), after: freeze(after, afterId, afterPerson) };
}
