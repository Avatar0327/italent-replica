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

/**
 * 特殊规则②（DEC-078；DEC-120 用户 2026-10-03 确认保持记录级）：部门、职位同时变化时，后续记录的部门、职位
 * 不全等于变动前值，该条整条不向后更新（直线经理等其他字段也不改）。原站为字段级（W-413），复刻有意不照搬，
 * 改由预览单独提醒（wholeRecordSkipReminder）。
 */
export function skipsWholeRecord(before: ForwardValues, after: ForwardValues, target: ForwardValues): boolean {
  const coupled =
    before.fields.departmentId !== after.fields.departmentId && before.fields.positionId !== after.fields.positionId;
  const pairMatches =
    target.fields.departmentId === before.fields.departmentId && target.fields.positionId === before.fields.positionId;
  return coupled && !pairMatches;
}

/**
 * 07 A5 值匹配：插入记录相对前一条变了的字段，后续记录等于变动前值才替换。
 * 特殊规则③：职务、职位与职务序列都在清单中，未传序列时由服务端按新职务带出（DEC-107），因此一并向后更新。
 */
function valueMatches(
  before: ForwardValues,
  after: ForwardValues,
  target: ForwardValues,
  presetFields: readonly (typeof FORWARD_PRESET_FIELDS)[number][],
  customFieldIds: readonly string[],
): ForwardFieldChange[] {
  const changes: ForwardFieldChange[] = [];
  for (const field of presetFields) {
    if (before.fields[field] !== after.fields[field] && target.fields[field] === before.fields[field]) {
      changes.push({ field, before: target.fields[field], after: after.fields[field] });
    }
  }
  for (const id of customFieldIds) {
    const oldValue = before.customFields[id] ?? null;
    const newValue = after.customFields[id] ?? null;
    if (oldValue !== newValue && (target.customFields[id] ?? null) === oldValue) {
      changes.push({ field: `custom:${id}`, before: oldValue, after: newValue });
    }
  }
  return changes;
}

export function matchingForwardChanges(
  before: ForwardValues,
  after: ForwardValues,
  target: ForwardValues,
  customFieldIds: readonly string[],
): ForwardFieldChange[] {
  if (skipsWholeRecord(before, after, target)) return [];
  return valueMatches(before, after, target, FORWARD_PRESET_FIELDS, customFieldIds);
}

const PAIR_FIELDS: readonly string[] = ['departmentId', 'positionId'];

/** DEC-120：规则②整条跳过的记录里，若按原站字段级（W-413）本可按值匹配同步的字段；部门、职位这一对不在其内。 */
export function wholeRecordSkipReminder(
  before: ForwardValues,
  after: ForwardValues,
  target: ForwardValues,
  customFieldIds: readonly string[],
): ForwardFieldChange[] {
  const presetFields = FORWARD_PRESET_FIELDS.filter((field) => !PAIR_FIELDS.includes(field));
  return valueMatches(before, after, target, presetFields, customFieldIds);
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
