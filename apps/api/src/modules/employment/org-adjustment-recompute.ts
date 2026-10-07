/** 重建消费业务输入与引用依赖；历史传播/重建快照不是字段计算输入（DEC-108 / 186 / 195）。 */
import type { Tx } from '@italent/db';
import { getCustomFieldsForInheritance } from './configuration.js';
import {
  derivePresetFields,
  derivationFields,
  presetFieldOrigin,
  resolveDerivation,
  type FieldDerivation,
} from './field-derivations.js';
import {
  applyForwardChanges,
  matchingForwardChanges,
  type ForwardFieldChange,
  type ForwardValues,
} from './forward-rules.js';
import { availableForwardChanges } from './forward-references.js';
import { predecessorInheritance } from './inheritance.js';
import { effectiveInput, type AdjustmentHistory } from './org-adjustment-history.js';
import { PRESET_FIELD_NAMES, type EmploymentContext, type EmploymentRecord, type PresetField } from './types.js';

export interface RecalculatedSource {
  readonly before: ForwardValues;
  readonly after: ForwardValues;
}
type SourceResolver = (sourceId: string, versionNo: number | null) => Promise<RecalculatedSource | null>;

export async function calculateOrgAdjustment(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  history: readonly AdjustmentHistory[],
  previous: ForwardValues,
  resolveSource: SourceResolver,
): Promise<ForwardValues> {
  const { initial, commands } = effectiveInput(history);
  const origins = await initialDerivations(tx, ctx, initial);
  const explicit = new Set(initial.explicitFieldCodes);
  const fields = Object.fromEntries(
    PRESET_FIELD_NAMES.filter((field) => presetFieldOrigin(field, explicit, origins) === 'explicit').map((field) => [
      field,
      initial.fields[field],
    ]),
  );
  const custom = Object.fromEntries(
    Object.entries(initial.customFields).filter(([id]) => explicit.has(`custom:${id}`)),
  );
  // 本业务派生值以创建当时算出的结果为准；只有引用改变才按同一规则重算（R6-P2-02，DEC-208 清空序列不回写）。
  const rules = new Map<PresetField, FieldDerivation>();
  for (const origin of origins) rules.set(derivationFields(origin).field, origin);
  // 前驱继承只覆盖矩阵允许继承的字段：不继承的预置 / 自定义字段保留创建时的空值（R6-P2-03）。
  const inherited = predecessorInheritance(initial, previous);
  let values: ForwardValues = {
    fields: { ...inherited.fields, ...derivedValues(initial.fields, rules), ...fields },
    customFields: { ...inherited.customFields, ...custom },
  };
  const finalReferences = await calculateReferences(tx, ctx, record, values, history, resolveSource);
  values = await refreshDerivations(tx, ctx, record, values, previous, rules);
  const customIds = (await getCustomFieldsForInheritance(tx, ctx.tenantId))
    .filter((field) => field.inherit)
    .map((field) => field.id);
  const availability = new Map<string, boolean>();
  for (const { command, payload } of commands) {
    if (command.type === 'manual') {
      values = {
        fields: { ...values.fields, ...command.patch.fields },
        customFields: { ...values.customFields, ...command.patch.customFields },
      };
      for (const field of Object.keys(command.patch.fields ?? {})) rules.delete(field as PresetField);
      // 更正的派生规则与创建相同；显式同值也会覆盖字段来源，而非仅保留有差异的字段。
      const added = new Map<PresetField, FieldDerivation>();
      for (const origin of command.derivations) added.set(derivationFields(origin).field, origin);
      for (const [field, origin] of added) rules.set(field, origin);
      values = { ...values, fields: { ...values.fields, ...derivedValues(payload.fields, added) } };
      values = await refreshDerivations(tx, ctx, record, values, values, rules);
    } else if (command.type === 'sequence-sync') {
      const reference = command.sourceKind === 'posts' ? 'postId' : 'positionId';
      if (values.fields[reference] === command.sourceId && finalReferences.fields[reference] === command.sourceId) {
        values = { ...values, fields: { ...values.fields, sequenceId: command.sequenceId } };
        rules.delete('sequenceId');
      }
    } else if (command.type === 'forward') {
      const source = await resolveSource(command.sourceId, command.sourceVersionNo);
      if (!source) continue;
      const matched = matchingForwardChanges(source.before, source.after, values, customIds);
      const { accepted: changes } = await availableForwardChanges(
        tx,
        ctx,
        matched,
        record.effectiveDate,
        availability,
        { employeeId: record.employeeId, businessId: record.id, effectiveDate: record.effectiveDate, effective: true },
      );
      values = applyForwardChanges(values, changes);
      for (const { field } of changes) rules.delete(field as PresetField);
      values = await refreshDerivations(tx, ctx, record, values, previous, rules);
    }
  }
  return values;
}

/** 派生命令当时写入的字段值（载荷里保存的结果），作为引用未变时的派生结果。 */
function derivedValues(
  fields: ForwardValues['fields'],
  rules: ReadonlyMap<PresetField, FieldDerivation>,
): Partial<ForwardValues['fields']> {
  return Object.fromEntries([...rules.keys()].map((field) => [field, fields[field]]));
}

async function initialDerivations(tx: Tx, ctx: EmploymentContext, initial: AdjustmentHistory['payload']) {
  if (initial.formSnapshot.fieldDerivations) return [...initial.formSnapshot.fieldDerivations];
  // 存量载荷从冻结表单和显式输入恢复规则，不能从载荷差值推断来源。
  const fields = Object.fromEntries(
    Object.entries(initial.fields).filter(([field]) => initial.explicitFieldCodes.includes(`preset:${field}`)),
  );
  const { origins } = await derivePresetFields(tx, ctx.tenantId, initial, fields, initial.formSnapshot);
  if (initial.changeType === 'position_adjustment')
    origins.push({ rule: 'position-manager', referenceId: initial.fields.positionId });
  return origins;
}

/** 只有规则引用的字段（职务 / 职位 / 部门）实际改变时才重新派生；引用未变时保留当时的派生结果。 */
async function refreshDerivations(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  values: ForwardValues,
  fallback: ForwardValues,
  rules: Map<PresetField, FieldDerivation>,
) {
  for (const [field, origin] of rules) {
    const referenceId = values.fields[derivationFields(origin).reference];
    if (referenceId === origin.referenceId) continue;
    const next = { ...origin, referenceId };
    const derived = await resolveDerivation(tx, ctx.tenantId, record.employeeId, record.effectiveDate, next);
    values = applyForwardChanges(values, [
      { field, before: values.fields[field], after: derived === undefined ? fallback.fields[field] : derived },
    ]);
    rules.set(field, next);
  }
  return values;
}

/** F-021 不改变引用字段；其依赖是否有效由该命令 prefix 的最终引用判定。 */
async function calculateReferences(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  initial: ForwardValues,
  history: readonly AdjustmentHistory[],
  resolveSource: SourceResolver,
) {
  let values = initial;
  const referenceFields = new Set(['departmentId', 'positionId', 'postId']);
  const availability = new Map<string, boolean>();
  // 序列/经理规则都不赋值引用字段，先求命令 prefix 的最终引用，避免中间匹配的自动同步变成永久输入。
  for (const { command } of effectiveInput(history).commands) {
    if (command.type === 'manual') values = { ...values, fields: { ...values.fields, ...command.patch.fields } };
    if (command.type !== 'forward') continue;
    const source = await resolveSource(command.sourceId, command.sourceVersionNo);
    if (!source) continue;
    const matched = matchingForwardChanges(source.before, source.after, values, []).filter((change) =>
      referenceFields.has(change.field),
    );
    const { accepted } = await availableForwardChanges(tx, ctx, matched, record.effectiveDate, availability, {
      employeeId: record.employeeId,
      businessId: record.id,
      effectiveDate: record.effectiveDate,
      effective: true,
    });
    values = applyForwardChanges(values, accepted);
  }
  return values;
}

/** 仅用于判断新的计算结果是否需要追加版本，不用于恢复历史语义。 */
export function calculatedChanges(before: ForwardValues, after: ForwardValues): ForwardFieldChange[] {
  const changes: ForwardFieldChange[] = [];
  const add = (field: string, oldValue: ForwardFieldChange['before'], newValue: ForwardFieldChange['after']) => {
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
      changes.push({ field, before: oldValue, after: newValue });
  };
  for (const field of PRESET_FIELD_NAMES) add(field, before.fields[field], after.fields[field]);
  for (const id of new Set([...Object.keys(before.customFields), ...Object.keys(after.customFields)]))
    add(`custom:${id}`, before.customFields[id] ?? null, after.customFields[id] ?? null);
  return changes;
}
