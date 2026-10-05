import { eq, employmentCustomFieldObjects, type Tx } from '@italent/db';
import { MODULE_OBJECTS, ObjectCatalog } from '@italent/domain';

/** Tenant-local custom field definitions are ordinary configurable fields, never a writable JSON umbrella. */
export async function tenantObjectCatalog(tx: Tx, catalog: ObjectCatalog, objectCode?: string): Promise<ObjectCatalog> {
  if (objectCode !== MODULE_OBJECTS.employmentRecord.code && objectCode !== MODULE_OBJECTS.contract.code)
    return catalog;
  const definition = catalog.get(objectCode);
  if (!definition) return catalog;
  const fields = await tx
    .select({ id: employmentCustomFieldObjects.id })
    .from(employmentCustomFieldObjects)
    .where(
      eq(
        employmentCustomFieldObjects.objectType,
        objectCode === MODULE_OBJECTS.contract.code ? 'contract' : 'employment',
      ),
    )
    .limit(1001);
  if (fields.length > 1000) return new ObjectCatalog([{ ...definition, fields: definition.fields }]);
  return new ObjectCatalog([
    {
      ...definition,
      fields: [...definition.fields, ...fields.map((field) => ({ code: `custom:${field.id}`, system: false }))],
    },
  ]);
}
