// F-474-6c：人员自定义字段（设计 docs/08_设计/F-474-6a §3、§5）。值存在人员版本行的 custom_fields，键为定义 ID；
// 校验、合并、权限键映射都集中在这里，appendEmployee 是唯一写入口。
import { sql, type Tx } from '@italent/db';
import type { CustomFieldOption } from '@italent/domain';
import { AppError } from '../../errors.js';
import { customFields as customFieldsSchema, validateCustomValue } from '../employment/fields.js';
import type { CustomValue } from '../employment/types.js';
import { rows, type Row } from './store.js';

export type PersonnelCustomFields = Record<string, CustomValue>;
type Definition = { id: string; value_type: string; options: CustomFieldOption[] };

/** 请求体的 customFields：键统一小写，免得同一字段因大小写写出两个权限键。 */
export function parseCustomFields(raw: unknown, fail: () => never): PersonnelCustomFields {
  const parsed = customFieldsSchema.safeParse(raw);
  if (!parsed.success) return fail();
  return Object.fromEntries(Object.entries(parsed.data).map(([id, value]) => [id.toLowerCase(), value]));
}

/** 授权用的载荷：customFields 展开为 custom:<id> 键，与任职对象同一写法（employment/context.ts）。 */
export function writePayload(input: Row): Row {
  const { customFields, ...rest } = input;
  const custom = (customFields ?? {}) as PersonnelCustomFields;
  return { ...rest, ...Object.fromEntries(Object.entries(custom).map(([id, value]) => [`custom:${id}`, value])) };
}

/**
 * 授权第一道（对象编辑权 + 人员范围）用的载荷：只含预置字段，不含 custom:<id>。
 * 自定义字段的两步检查放在 write() 里：先 requireLocalDefinitions（合法定义，否则 400），再按 custom:<id> 逐字段查编辑权
 * （403）。若第一道就带上 custom:<id>，不在人员字段目录里的键会先被判 403，400 永远走不到（第 2 轮 P2-4）。
 */
export function presetPayload(input: Row): Row {
  const { customFields: _custom, ...rest } = input;
  return rest;
}

/** 提交的字段 ID 必须全是本租户的人员定义（他租户、其他对象、不存在的都按同一句话 400，不泄露存在性）。 */
export async function requireLocalDefinitions(tx: Tx, tenantId: string, custom: PersonnelCustomFields | undefined) {
  const ids = Object.keys(custom ?? {});
  if (!ids.length) return;
  const found = await personnelDefinitions(tx, tenantId, ids);
  if (ids.some((id) => !found.has(id))) throw new AppError('VALIDATION_FAILED', '自定义字段不属于本租户人员对象');
}

/**
 * 把本次提交的值并入上一版：字段必须是本租户的人员定义（他租户、其他对象的 ID 在 RLS 与 object_type 下都查不到 → 400），
 * 值按定义类型校验，停用选项只可沿用上一版的值。返回整版 map 与审计用的“只含变化项”前后值。
 */
export async function mergeCustomFields(
  tx: Tx,
  tenantId: string,
  previous: PersonnelCustomFields,
  patch: PersonnelCustomFields,
) {
  const ids = Object.keys(patch);
  const definitions = ids.length ? await personnelDefinitions(tx, tenantId, ids) : new Map<string, Definition>();
  const merged: PersonnelCustomFields = { ...previous };
  const before: PersonnelCustomFields = {};
  const after: PersonnelCustomFields = {};
  for (const id of ids) {
    const definition = definitions.get(id);
    if (!definition) throw new AppError('VALIDATION_FAILED', '自定义字段不属于本租户人员对象');
    const value = validateCustomValue(patch[id], definition.value_type, definition.options, previous[id]);
    merged[id] = value;
    if (JSON.stringify(previous[id] ?? null) === JSON.stringify(value)) continue;
    before[id] = previous[id] ?? null;
    after[id] = value;
  }
  return { merged, before, after };
}

async function personnelDefinitions(tx: Tx, tenantId: string, ids: string[]) {
  const found = rows<Definition>(
    await tx.execute(sql`SELECT id::text AS id, value_type, options FROM employment_custom_field_objects
      WHERE tenant_id=${tenantId}::uuid AND object_type='personnel' AND id=ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  return new Map(found.map((row) => [row.id, row]));
}

/** 读出口：只留查看者有 custom:<id> 权限的值；一个都没有时连键一起去掉（无权者看不到字段存在）。 */
export function trimCustomFields(value: unknown, fields: ReadonlySet<string>): PersonnelCustomFields | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const kept = Object.entries(value as PersonnelCustomFields).filter(([id]) => fields.has(`custom:${id}`));
  return kept.length ? Object.fromEntries(kept) : undefined;
}
