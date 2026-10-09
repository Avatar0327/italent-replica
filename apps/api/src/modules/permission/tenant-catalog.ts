import { eq, employmentCustomFieldObjects, type Tx } from '@italent/db';
import { MODULE_OBJECTS, ObjectCatalog } from '@italent/domain';

/**
 * 租户动态字段来源：返回该对象在当前租户追加的可配置字段编码（如任职自定义字段 `custom:<id>`、盘点字段
 * `field:<code>`），最多读 TENANT_FIELD_LIMIT + 1 条。按对象登记（R3-T04 C-06，设计 §6.1 扩展点），
 * 业务模块在加载时登记，权限模块不再按对象写死。
 */
export type TenantFieldSource = (tx: Tx, limit: number) => Promise<readonly string[]>;

/** 单个对象的租户动态字段上限；超出时一个都不追加（授权界面与判定都只认目录字段，宁缺不错）。 */
export const TENANT_FIELD_LIMIT = 1000;

const sources = new Map<string, TenantFieldSource>();

export function registerTenantFieldSource(objectCode: string, source: TenantFieldSource): void {
  const existing = sources.get(objectCode);
  if (existing && existing !== source) throw new Error(`对象 ${objectCode} 已登记了租户字段来源`);
  sources.set(objectCode, source);
}

const customFields =
  (objectType: 'employment' | 'contract'): TenantFieldSource =>
  async (tx, limit) =>
    (
      await tx
        .select({ id: employmentCustomFieldObjects.id })
        .from(employmentCustomFieldObjects)
        .where(eq(employmentCustomFieldObjects.objectType, objectType))
        .limit(limit)
    ).map((field) => `custom:${field.id}`);

registerTenantFieldSource(MODULE_OBJECTS.employmentRecord.code, customFields('employment'));
registerTenantFieldSource(MODULE_OBJECTS.contract.code, customFields('contract'));

/** Tenant-local custom field definitions are ordinary configurable fields, never a writable JSON umbrella. */
export async function tenantObjectCatalog(tx: Tx, catalog: ObjectCatalog, objectCode?: string): Promise<ObjectCatalog> {
  const source = objectCode ? sources.get(objectCode) : undefined;
  const definition = objectCode ? catalog.get(objectCode) : undefined;
  if (!source || !definition) return catalog;
  const fields = await source(tx, TENANT_FIELD_LIMIT + 1);
  if (fields.length > TENANT_FIELD_LIMIT) return new ObjectCatalog([{ ...definition, fields: definition.fields }]);
  return new ObjectCatalog([
    { ...definition, fields: [...definition.fields, ...fields.map((code) => ({ code, system: false }))] },
  ]);
}
