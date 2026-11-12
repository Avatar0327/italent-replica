import { CUSTOM_FIELD_LIMIT, type CustomFieldObjectType, type CustomFieldValueType } from '@italent/domain';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { m } from './messages.js';

export const OBJECT = 'TenantBase.EmploymentCustomField';
export const PATH = '/api/tenant/employment/custom-fields';
export type Definition = {
  id: string;
  revision: number;
  name?: string;
  objectType?: CustomFieldObjectType;
  valueType?: CustomFieldValueType;
  inherit?: boolean;
};
export const listPath = (objectType: CustomFieldObjectType) =>
  `${PATH}?objectType=${objectType}&page=1&pageSize=${CUSTOM_FIELD_LIMIT}`;
export function parseRows(value: unknown): Definition[] {
  const items = (value as { items?: Definition[] } | null)?.items;
  if (
    !Array.isArray(items) ||
    !items.every((row) => row && typeof row.id === 'string' && Number.isSafeInteger(row.revision))
  ) {
    throw new Error(m.invalidList);
  }
  return items;
}
export function receipt(value: unknown, revision: number, id?: string) {
  const row = value as Partial<Definition> | null;
  if (!row || typeof row.id !== 'string' || !row.id || (id && row.id !== id) || row.revision !== revision + 1) {
    throw new Error(m.invalidReceipt);
  }
  return { id: row.id };
}
export function actions(permission: ObjectPermission | undefined) {
  const loaded = permission && !permission.summary ? permission : undefined;
  const editable = (field: string) => !!loaded?.viewableFields.includes(field) && loaded.editableFields.includes(field);
  return {
    create: loaded?.dataOperations.create === true && ['name', 'valueType', 'objectType'].every(editable),
    inherit: loaded?.dataOperations.update === true && editable('inherit'),
    editable,
  };
}
