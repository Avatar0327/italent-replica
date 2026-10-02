import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { getCustomFieldsForInheritance } from './configuration.js';
import { businessDate, emptyFields, INHERITED_FIELDS, presetFieldsSchema, validateCustomValue } from './fields.js';
import { findPredecessor, rowsOf } from './read-model.js';
import type {
  BusinessKind,
  CustomFields,
  CustomValue,
  EmploymentContext,
  EmploymentRecord,
  FormId,
  PresetField,
  PresetFields,
} from './types.js';

type CustomMode = 'editable' | 'readonly' | 'hidden' | 'absent';
interface TrustedFormSnapshot {
  readonly id: FormId;
  readonly group: BusinessKind | null;
  readonly customMode: CustomMode;
  readonly startsNewCycle: boolean;
  readonly customInheritance: Readonly<Record<string, boolean>>;
}
export interface PreparedInheritance {
  readonly effectiveDate: string;
  readonly fields: PresetFields;
  readonly customFields: CustomFields;
  readonly formSnapshot: TrustedFormSnapshot;
  readonly deferredFieldCodes: readonly string[];
  readonly explicitFieldCodes: readonly string[];
  readonly sourceRecordId: string | null;
  readonly sourceStaffId: string | null;
}
export interface InheritanceInput {
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly kind: BusinessKind;
  readonly formId: FormId;
  readonly fields?: Partial<PresetFields>;
  readonly customFields?: CustomFields;
  readonly staffId?: string;
}

// REQ-EMP-002 R7：这是服务端固定目录，不接收客户端展示/编辑权限元数据。
const FORM_CATALOG: Readonly<Record<FormId, { grouped: boolean; customMode: CustomMode }>> = {
  standard: { grouped: true, customMode: 'editable' },
  'readonly-custom': { grouped: true, customMode: 'readonly' },
  'hidden-custom': { grouped: true, customMode: 'hidden' },
  'omitted-custom': { grouped: true, customMode: 'absent' },
  'ungrouped-custom': { grouped: false, customMode: 'editable' },
};
const NEW_CYCLES: readonly BusinessKind[] = ['hire', 'rehire', 'retire_rehire'];
const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function setField(target: PresetFields, key: PresetField, value: PresetFields[PresetField]): void {
  Object.assign(target, { [key]: value });
}

export async function prepareInheritance(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
): Promise<PreparedInheritance> {
  businessDate(input.effectiveDate);
  const form = FORM_CATALOG[input.formId];
  if (!form || !owns(FORM_CATALOG, input.formId)) throw new AppError('VALIDATION_FAILED', '表单不在服务端目录中');
  const [employee] = rowsOf<{ code: string }>(
    await tx.execute(sql`
      SELECT code FROM employment_employees WHERE tenant_id=${ctx.tenantId} AND id=${input.employeeId} LIMIT 1
    `),
  );
  if (!employee) throw new AppError('NOT_FOUND', '员工不存在');
  const parsedFields = presetFieldsSchema.safeParse(input.fields ?? {});
  if (!parsedFields.success) throw new AppError('VALIDATION_FAILED', '任职预置字段不合法');
  const fields = emptyFields();
  const definitions = await getCustomFieldsForInheritance(tx, ctx.tenantId);
  const customFields: Record<string, CustomValue> = Object.fromEntries(definitions.map((field) => [field.id, null]));
  const explicitFieldCodes: string[] = [];
  const deferredFieldCodes: string[] = [];
  const startsNewCycle = NEW_CYCLES.includes(input.kind);
  const previous = startsNewCycle
    ? null
    : await findPredecessor(tx, ctx.tenantId, input.employeeId, input.effectiveDate);
  const eligible = previous && (!input.staffId || previous.staffId === input.staffId) ? previous : null;
  const metadata: TrustedFormSnapshot = {
    id: input.formId,
    group: form.grouped ? input.kind : null,
    customMode: form.customMode,
    startsNewCycle,
    customInheritance: Object.fromEntries(definitions.map((field) => [field.id, field.inherit])),
  };
  for (const field of INHERITED_FIELDS) {
    if (startsNewCycle) continue;
    if (form.grouped) setField(fields, field, eligible?.fields[field] ?? null);
    else deferredFieldCodes.push(`preset:${field}`);
  }
  for (const [field, value] of Object.entries(parsedFields.data)) {
    setField(fields, field as PresetField, value ?? null);
    explicitFieldCodes.push(`preset:${field}`);
  }
  if (owns(parsedFields.data, 'jobNumber') && parsedFields.data.jobNumber !== null) {
    if (parsedFields.data.jobNumber!.toLowerCase() !== employee.code.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', '任职工号必须等于员工主档工号');
    }
    setField(fields, 'jobNumber', employee.code);
  }
  const explicitCustom = input.customFields ?? {};
  if (Object.keys(explicitCustom).length > 200) throw new AppError('VALIDATION_FAILED', '单次自定义字段超过处理上限');
  for (const id of Object.keys(explicitCustom)) {
    if (!definitions.some((field) => field.id === id))
      throw new AppError('VALIDATION_FAILED', '自定义字段不属于本租户任职对象');
    if (form.customMode !== 'editable') throw new AppError('VALIDATION_FAILED', '当前表单不允许编辑此自定义字段');
  }
  for (const field of definitions) {
    if (owns(explicitCustom, field.id)) {
      customFields[field.id] = validateCustomValue(explicitCustom[field.id], field.valueType);
      explicitFieldCodes.push(`custom:${field.id}`);
    } else if (!startsNewCycle) {
      const inherits = field.inherit || form.customMode === 'readonly' || form.customMode === 'hidden';
      if (!inherits) continue;
      if (!form.grouped || form.customMode === 'absent') deferredFieldCodes.push(`custom:${field.id}`);
      else customFields[field.id] = eligible?.customFields[field.id] ?? null;
    }
  }
  const explicit = new Set(explicitFieldCodes);
  return {
    effectiveDate: input.effectiveDate,
    fields,
    customFields,
    formSnapshot: metadata,
    deferredFieldCodes: deferredFieldCodes.filter((field) => !explicit.has(field)),
    explicitFieldCodes,
    sourceRecordId: eligible?.id ?? null,
    sourceStaffId: eligible?.staffId ?? null,
  };
}

/** 日期不变时保留创建表单时捕获的默认值；日期改变按 DEC-041 重新查前驱。 */
export async function prepareEmploymentPatch(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  previous: PreparedInheritance,
): Promise<PreparedInheritance> {
  const prepared = await prepareInheritance(tx, ctx, input);
  if (input.effectiveDate !== previous.effectiveDate) return prepared;
  const explicit = new Set(prepared.explicitFieldCodes);
  const oldDeferred = new Set(previous.deferredFieldCodes);
  const fields = { ...prepared.fields };
  const customFields = { ...prepared.customFields };
  for (const field of INHERITED_FIELDS) {
    const code = `preset:${field}`;
    if (!explicit.has(code) && !oldDeferred.has(code)) setField(fields, field, previous.fields[field]);
  }
  for (const id of Object.keys(customFields)) {
    const code = `custom:${id}`;
    if (!explicit.has(code) && !oldDeferred.has(code)) customFields[id] = previous.customFields[id] ?? null;
  }
  return {
    ...prepared,
    fields,
    customFields,
    formSnapshot: previous.formSnapshot,
    sourceRecordId: previous.sourceRecordId,
    sourceStaffId: previous.sourceStaffId,
    deferredFieldCodes: previous.deferredFieldCodes.filter((field) => !explicit.has(field)),
  };
}

export async function resolveEffectiveInheritance(
  _tx: Tx,
  _ctx: EmploymentContext,
  prepared: PreparedInheritance,
  effective: { staffId: string; predecessor: EmploymentRecord | null },
): Promise<{ fields: PresetFields; customFields: CustomFields }> {
  const fields = { ...prepared.fields };
  const customFields = { ...prepared.customFields };
  const explicit = new Set(prepared.explicitFieldCodes);
  const previous = effective.predecessor?.staffId === effective.staffId ? effective.predecessor : null;
  // 冻结的表单默认值也不能越过新 StaffID 周期；显式填写的字段不受此清空影响。
  const crossedCycle =
    !prepared.formSnapshot.startsNewCycle &&
    ((prepared.sourceStaffId !== null && prepared.sourceStaffId !== effective.staffId) ||
      (effective.predecessor !== null && previous === null));
  if (crossedCycle) {
    for (const field of INHERITED_FIELDS) if (!explicit.has(`preset:${field}`)) setField(fields, field, null);
    for (const id of Object.keys(customFields)) if (!explicit.has(`custom:${id}`)) customFields[id] = null;
  }
  if (!prepared.formSnapshot.startsNewCycle) {
    for (const code of prepared.deferredFieldCodes) {
      if (explicit.has(code)) continue;
      if (code.startsWith('preset:')) {
        const field = code.slice('preset:'.length) as PresetField;
        setField(fields, field, previous?.fields[field] ?? null);
      } else if (code.startsWith('custom:')) {
        const id = code.slice('custom:'.length);
        customFields[id] = previous?.customFields[id] ?? null;
      }
    }
  }
  return { fields, customFields };
}

/** 仅裁剪预览；隐藏字段的可信快照仍保留供生效与审计使用。 */
export function inheritancePreview(prepared: PreparedInheritance) {
  const hidden = prepared.formSnapshot.customMode === 'hidden' || prepared.formSnapshot.customMode === 'absent';
  const customFields = hidden ? {} : prepared.customFields;
  return {
    fields: prepared.fields,
    customFields,
    previousRecordId: prepared.sourceRecordId,
    staffId: prepared.sourceStaffId,
  };
}
