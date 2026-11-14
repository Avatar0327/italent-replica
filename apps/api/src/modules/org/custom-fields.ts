import { and, employmentCustomFieldObjects, eq, inArray, type Tx, withTenant } from '@italent/db';
import { MODULE_OBJECTS, type CustomFieldOption } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { validateCustomValue } from '../employment/fields.js';
import { getModuleViewableFields, trimModuleResponse } from '../permission/module-access.js';
import { writeFields } from '../permission/module-route-access.js';
import { invalid } from './validation.js';

/** 提交值：键为字段定义 ID；null 表示清空（docs/08_设计/F-474-6a §3.2）。 */
export type OrgCustomInput = Readonly<Record<string, string | number | boolean | null>>;
export type OrgCustomValues = Record<string, string | number | boolean>;

type Deps = Parameters<typeof getModuleViewableFields>[0];
type Ctx = Parameters<typeof getModuleViewableFields>[1];

/**
 * 写权限判定用：把 customFields 拍平成 `custom:<id>` 键，与标准字段同走 requireObjectWrite（fail-closed）。
 * 提交了字段就要有该字段的编辑权，缺一项整单 403。
 */
export function withCustomFieldKeys<T extends { customFields?: OrgCustomInput }>(input: T): Record<string, unknown> {
  const { customFields, ...rest } = input;
  return {
    ...rest,
    ...Object.fromEntries(Object.entries(customFields ?? {}).map(([id, value]) => [`custom:${id}`, value])),
  };
}

/** 授权第一道（对象编辑权 + 标准字段编辑权）用的载荷：只含标准字段，自定义字段留到范围检查之后（见 authorizeCustomFields）。 */
export function presetFields<T extends { customFields?: OrgCustomInput }>(input: T): Omit<T, 'customFields'> {
  const { customFields: _customFields, ...rest } = input;
  return rest;
}

/**
 * 自定义字段的两步检查，放在对象权限与数据范围之后（与人员 6c 的 write precheck 同一顺序）：
 * 先确认每个字段 ID 都是本租户组织对象的定义（否则 400，不区分未知、他租户、非组织对象），
 * 再按 `custom:<id>` 逐字段查编辑权（合法定义但无权 → 403）。
 * 若第一道就带上 custom:<id>，不在字段目录里的 ID 会先被判 403，400 永远走不到。
 */
export async function authorizeCustomFields(
  deps: Pick<TenantRouteDeps, 'db' | 'authorize'>,
  ctx: Parameters<typeof writeFields>[1],
  operation: 'create' | 'update',
  customFields: OrgCustomInput | undefined,
): Promise<void> {
  const ids = Object.keys(customFields ?? {});
  if (!ids.length) return;
  await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const found = await tx
      .select({ id: employmentCustomFieldObjects.id })
      .from(employmentCustomFieldObjects)
      .where(
        and(
          eq(employmentCustomFieldObjects.tenantId, ctx.tenantId),
          eq(employmentCustomFieldObjects.objectType, 'organization'),
          inArray(employmentCustomFieldObjects.id, ids),
        ),
      );
    const known = new Set(found.map((definition) => definition.id));
    const unknown = ids.find((id) => !known.has(id));
    if (unknown) throw invalid(`customFields.${unknown}`, '自定义字段不存在或不属于组织');
  });
  await writeFields(deps, ctx, MODULE_OBJECTS.organization.code, operation, withCustomFieldKeys({ customFields }));
}

/**
 * 整单校验并合并：只认本租户“组织”对象的字段定义，未知或他租户 ID 一律 400；
 * 值按类型校验，下拉停用项只能沿用上一版本的原值；未提交的字段整体带上一版本，null 清空。
 */
export async function resolveCustomFields(
  tx: Tx,
  tenantId: string,
  previous: Readonly<Record<string, unknown>>,
  submitted: OrgCustomInput | undefined,
): Promise<OrgCustomValues> {
  const result = { ...previous } as OrgCustomValues;
  const ids = Object.keys(submitted ?? {});
  if (!submitted || !ids.length) return result;
  const definitions = await tx
    .select({
      id: employmentCustomFieldObjects.id,
      valueType: employmentCustomFieldObjects.valueType,
      options: employmentCustomFieldObjects.options,
    })
    .from(employmentCustomFieldObjects)
    .where(
      and(
        eq(employmentCustomFieldObjects.tenantId, tenantId),
        eq(employmentCustomFieldObjects.objectType, 'organization'),
        inArray(employmentCustomFieldObjects.id, ids),
      ),
    );
  const known = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const id of ids) {
    const definition = known.get(id);
    if (!definition) throw invalid(`customFields.${id}`, '自定义字段不存在或不属于组织');
    const value = validateCustomValue(
      submitted[id],
      definition.valueType,
      definition.options as CustomFieldOption[],
      previous[id],
    );
    if (value === null) delete result[id];
    else result[id] = value;
  }
  return result;
}

/**
 * 读取与写入响应的出口裁剪：标准字段走对象字段权限；customFields 按查看人的 `custom:<id>` 逐项保留，
 * 一个自定义字段都不可见时整个键不出现（历史版本同样按当前权限裁剪）。
 */
export async function trimOrganization<T extends object>(
  deps: Deps,
  ctx: Ctx,
  objectCode: string,
  value: T,
): Promise<Partial<T>>;
export async function trimOrganization<T extends object>(
  deps: Deps,
  ctx: Ctx,
  objectCode: string,
  value: T[],
): Promise<Partial<T>[]>;
export async function trimOrganization(deps: Deps, ctx: Ctx, objectCode: string, value: object | object[]) {
  const viewable = await getModuleViewableFields(deps, ctx, objectCode);
  const rows = Array.isArray(value) ? value : [value];
  const trimmed = await Promise.all(
    rows.map(async (row) => {
      const { customFields, ...rest } = row as { customFields?: Record<string, unknown> };
      const base = (await trimModuleResponse(deps, ctx, objectCode, rest)) as Record<string, unknown>;
      if (!customFields) return base;
      if (viewable === undefined) return { ...base, customFields };
      const visible = Object.entries(customFields).filter(([id]) => viewable.has(`custom:${id}`));
      const anyCustomViewable = [...viewable].some((code) => code.startsWith('custom:'));
      return anyCustomViewable ? { ...base, customFields: Object.fromEntries(visible) } : base;
    }),
  );
  return Array.isArray(value) ? trimmed : trimmed[0];
}
