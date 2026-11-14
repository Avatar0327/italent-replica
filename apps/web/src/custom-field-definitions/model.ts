import {
  CUSTOM_FIELD_LIMIT,
  type CustomFieldObjectType,
  type CustomFieldValueType,
  type CustomFieldOption,
} from '@italent/domain';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { sameValue } from '../foundation/forms/values.js';
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
  options?: readonly CustomFieldOption[];
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
    options: loaded?.dataOperations.update === true && editable('options'),
    editable,
  };
}

const asOptions = (value: unknown) => (Array.isArray(value) ? (value as CustomFieldOption[]) : []);
const codes = (options: readonly CustomFieldOption[]) => options.map((option) => option.value);
/**
 * 409 重读后按稳定编码合并选项（docs/08_设计/F-474-6a §3.1：选项只增、改名、启停，不删）。
 * 内核对改过的字段整份保留草稿，选项草稿缺了他人新存的编码，后端会以“已有选项不可删除”拒绝。
 * - 本人相对 base（本次提交的基线）改过名称 / 启停的项、本人新增的项取本人；其余取最新（他人改名、他人新增照收）。
 * - 本人没调过顺序时按最新顺序，本人新增项接在后面；调过顺序时按本人顺序，他人新增项接在后面。
 * 例：base [东区]，本人把东区改名为“新区”，他人新增西区 → [新区, 西区]。
 */
export function mergeOptions(base: unknown, mine: unknown, latest: unknown): CustomFieldOption[] {
  const [before, draft, saved] = [asOptions(base), asOptions(mine), asOptions(latest)];
  const old = new Map(before.map((option) => [option.value, option]));
  const own = new Map(draft.map((option) => [option.value, option]));
  const pick = (option: CustomFieldOption) => {
    const edit = own.get(option.value);
    const kept = old.get(option.value);
    return edit && (!kept || !sameValue(edit, kept)) ? edit : option;
  };
  const added = draft.filter((option) => !old.has(option.value));
  const untouched = [...before.filter((option) => own.has(option.value)), ...added];
  const savedCodes = new Set(codes(saved));
  if (codes(draft).join('\n') !== codes(untouched).join('\n')) {
    return [
      ...draft.map((option) => pick(saved.find((item) => item.value === option.value) ?? option)),
      ...saved.filter((option) => !own.has(option.value)),
    ];
  }
  return [...saved.map(pick), ...draft.filter((option) => !savedCodes.has(option.value))];
}
