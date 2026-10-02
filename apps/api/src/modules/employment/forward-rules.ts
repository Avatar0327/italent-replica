import { INHERITED_FIELDS } from './fields.js';
import type { CustomFields, CustomValue, PresetFields } from './types.js';

export type ForwardEditEntry = 'page' | 'employee' | 'intern' | 'import' | 'api' | 'handover' | 'batch_edit';
export interface ForwardValues {
  readonly fields: PresetFields;
  readonly customFields: CustomFields;
}
export interface ForwardFieldChange {
  readonly field: string;
  readonly before: CustomValue;
  readonly after: CustomValue;
}

/** REQ-EMP-003 / 07 A7：历史、兼职、批量编辑仍可保存自身，但不传播。 */
export function isForwardEditSupported(input: {
  entry: ForwardEditEntry;
  serviceType: string;
  isCurrent: boolean;
  effectiveDate: string;
  today: string;
}): boolean {
  const supported = ['page', 'employee', 'intern', 'import', 'api', 'handover'];
  return (
    supported.includes(input.entry) &&
    input.serviceType === 'primary' &&
    (input.isCurrent || input.effectiveDate > input.today)
  );
}

/** C-005 已处置的四个废弃字段沿用 R1-T05 排除；JobNumber 属于本清单。 */
export const FORWARD_PRESET_FIELDS = INHERITED_FIELDS.filter((field) => field !== 'remarks');

export function matchingForwardChanges(
  before: ForwardValues,
  after: ForwardValues,
  target: ForwardValues,
  customFieldIds: readonly string[],
): ForwardFieldChange[] {
  const coupled =
    before.fields.departmentId !== after.fields.departmentId && before.fields.positionId !== after.fields.positionId;
  const pairMatches =
    target.fields.departmentId === before.fields.departmentId && target.fields.positionId === before.fields.positionId;
  const changes: ForwardFieldChange[] = [];
  for (const field of FORWARD_PRESET_FIELDS) {
    if (coupled && !pairMatches && (field === 'departmentId' || field === 'positionId')) continue;
    if (before.fields[field] !== after.fields[field] && target.fields[field] === before.fields[field]) {
      changes.push({ field, before: target.fields[field], after: after.fields[field] });
    }
  }
  // TODO(需取证 #14, Q-M0-25)：未填写的新序列不推导；显式序列仍按旧值匹配，不覆盖独立序列。
  for (const id of customFieldIds) {
    const oldValue = before.customFields[id] ?? null;
    const newValue = after.customFields[id] ?? null;
    if (oldValue !== newValue && (target.customFields[id] ?? null) === oldValue) {
      changes.push({ field: `custom:${id}`, before: oldValue, after: newValue });
    }
  }
  return changes;
}

export function applyForwardChanges(value: ForwardValues, changes: readonly ForwardFieldChange[]): ForwardValues {
  const fields = { ...value.fields };
  const customFields = { ...value.customFields };
  for (const change of changes) {
    if (change.field.startsWith('custom:')) customFields[change.field.slice(7)] = change.after;
    else Object.assign(fields, { [change.field]: change.after });
  }
  return { fields, customFields };
}
