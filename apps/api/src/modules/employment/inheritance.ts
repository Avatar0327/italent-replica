import { applyInitiatorFieldModes } from '../transfer/initiator-fields.js';
import { validateSelectedEmploymentType } from './employment-types.js';
import { validateSelectedEmploymentForm } from './employment-forms.js';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { resolveTransferForm } from '../transfer/configuration.js';
import { EMPLOYEE_READONLY_FIELDS } from '../transfer/employee-policy.js';
import { getCustomFieldsForInheritance, type CustomFieldDefinition } from './configuration.js';
import {
  businessDate,
  emptyFields,
  INHERITED_FIELDS,
  PRESET_FIELDS,
  presetFieldsSchema,
  validateCustomValue,
} from './fields.js';
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

import { derivePresetFields, derivationFields, type FieldDerivation } from './field-derivations.js';
import type { FieldOriginDraft } from './field-origin-store.js';
export { sequenceForNewPost } from './field-derivations.js';

type CustomMode = 'editable' | 'readonly' | 'hidden' | 'absent';
interface TrustedFormSnapshot {
  readonly id: FormId;
  readonly group: BusinessKind | null;
  readonly customMode: CustomMode;
  readonly startsNewCycle: boolean;
  readonly customInheritance: Readonly<Record<string, boolean>>;
  readonly fieldModes: Readonly<Record<string, CustomMode>>;
  readonly autoPopulate?: boolean;
  readonly excludedAutofillFields?: readonly string[];
  readonly fieldDerivations?: readonly FieldDerivation[];
  /** F-007 复制插入点快照（DEC-137 / `10` §17）：不应用表单矩阵，整条复制自前驱；只作来源标记。 */
  readonly copiesPredecessor?: boolean;
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
export type PreparedFormInheritance = PreparedInheritance & {
  readonly originPolicies: readonly FieldOriginDraft[];
};

function inheritanceOrigin(
  fieldCode: string,
  policy: 'deferred' | 'inherit' | 'none',
  sourceRecordId: string | null,
  value: unknown,
): FieldOriginDraft {
  if (policy === 'inherit' && sourceRecordId) return { fieldCode, originKind: policy, value, sourceRecordId };
  return { fieldCode, originKind: policy === 'deferred' ? 'deferred' : 'none' };
}

export interface InheritanceInput {
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly kind: BusinessKind;
  readonly formId: FormId;
  readonly fields?: Partial<PresetFields>;
  readonly customFields?: CustomFields;
  readonly staffId?: string;
  /**
   * F-036 S4：本次请求里实际给出的字段编码（`preset:*` / `custom:*`），“本次输入”的唯一来源（DEC-431①）。
   * 候选里其余的键是沿用上一版的覆盖值，不受“当前表单是否允许编辑”约束，也不触发派生；缺省 = 候选里全是输入（创建）。
   */
  readonly requestFieldCodes?: ReadonlySet<string>;
  /** 修改已保存申请时上一版的派生记录：改期时依据未变的派生按新日期重取。 */
  readonly previousDerivations?: readonly FieldDerivation[];
  /** F-363：仅待入职重建服务传入锁内旧引用；不由 HTTP 请求体解析。 */
  readonly retainedEmploymentForm?: string | null;
}

// 非调动业务及历史 R1-T05 表单继续使用原有继承语义；调动真实表单从租户配置解析。
function resolveForm(formId: FormId): { grouped: boolean; customMode: CustomMode } {
  if (formId === 'readonly-custom') return { grouped: true, customMode: 'readonly' };
  if (formId === 'hidden-custom') return { grouped: true, customMode: 'hidden' };
  if (formId === 'omitted-custom') return { grouped: true, customMode: 'absent' };
  if (formId === 'ungrouped-custom') return { grouped: false, customMode: 'editable' };
  return { grouped: true, customMode: 'editable' };
}
const NEW_CYCLES: readonly BusinessKind[] = ['hire', 'rehire', 'retire_rehire'];

const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function setField(target: PresetFields, key: PresetField, value: PresetFields[PresetField]): void {
  Object.assign(target, { [key]: key === 'workYearCompanyBefore' ? (value ?? 0) : value });
}

function snapshotForm(
  input: InheritanceInput,
  form: {
    grouped: boolean;
    customMode: CustomMode;
    fieldModes?: Readonly<Record<string, CustomMode>>;
    autoPopulate?: boolean;
    excludedAutofillFields?: readonly string[];
  },
  startsNewCycle: boolean,
  definitions: readonly { id: string; inherit: boolean }[],
): TrustedFormSnapshot {
  return {
    id: input.formId,
    group: form.grouped ? input.kind : null,
    customMode: form.customMode,
    startsNewCycle,
    customInheritance: Object.fromEntries(definitions.map((field) => [field.id, field.inherit])),
    fieldModes:
      form.fieldModes ??
      Object.fromEntries([
        ...PRESET_FIELDS.map((field) => [`preset:${field}`, 'editable' as const]),
        ...definitions.map((field) => [`custom:${field.id}`, form.customMode]),
      ]),
    autoPopulate: form.autoPopulate ?? true,
    excludedAutofillFields: form.excludedAutofillFields ?? [],
  };
}

/** 这个字段是不是本次请求给出的；没有请求集合（创建 / 重建）时候选里的全部字段都算输入。 */
function isRequestInput(input: InheritanceInput, code: string): boolean {
  return input.requestFieldCodes === undefined || input.requestFieldCodes.has(code);
}

async function applyExplicitPresetFields(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  parsedFields: Partial<PresetFields>,
  metadata: TrustedFormSnapshot,
  fields: PresetFields,
  explicitFieldCodes: string[],
  derivedOrigins: FieldDerivation[],
  employeeCode: string | null,
): Promise<void> {
  const fieldMode = (code: string): CustomMode => metadata.fieldModes[code] ?? 'absent';
  for (const [field, value] of Object.entries(parsedFields)) {
    if (
      input.kind === 'transfer' &&
      isRequestInput(input, `preset:${field}`) &&
      fieldMode(`preset:${field}`) !== 'editable'
    )
      throw new AppError('VALIDATION_FAILED', '当前表单不允许编辑此任职字段');
    setField(fields, field as PresetField, value ?? null);
    explicitFieldCodes.push(`preset:${field}`);
  }
  // DEC-187：只读/隐藏限制人工输入，不限制系统派生。
  const derived = await derivePresetFields(tx, ctx.tenantId, input, parsedFields, metadata, {
    requestFieldCodes: input.requestFieldCodes,
    previous: input.previousDerivations,
  });
  Object.assign(fields, derived.values);
  derivedOrigins.push(...derived.origins);
  if (owns(parsedFields, 'jobNumber') && parsedFields.jobNumber !== null) {
    // F-493 S1：员工主档无工号时，任职工号只能为空（NULL 不做 toLowerCase）
    if (employeeCode === null || parsedFields.jobNumber!.toLowerCase() !== employeeCode.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', '任职工号必须等于员工主档工号');
    }
    setField(fields, 'jobNumber', employeeCode);
  }
}

function applyCustomInheritance(
  input: InheritanceInput,
  metadata: TrustedFormSnapshot,
  definitions: readonly CustomFieldDefinition[],
  eligible: EmploymentRecord | null,
  customFields: Record<string, CustomValue>,
  explicitFieldCodes: string[],
  deferredFieldCodes: string[],
  originPolicies: FieldOriginDraft[],
  previousCustomFields?: CustomFields,
): void {
  const fieldMode = (code: string): CustomMode => metadata.fieldModes[code] ?? 'absent';
  const explicitCustom = input.customFields ?? {};
  if (Object.keys(explicitCustom).length > 200) throw new AppError('VALIDATION_FAILED', '单次自定义字段超过处理上限');
  for (const id of Object.keys(explicitCustom)) {
    if (!definitions.some((field) => field.id === id))
      throw new AppError('VALIDATION_FAILED', '自定义字段不属于本租户任职对象');
    // 归属与取值校验对候选里的全部键做；“表单是否允许编辑”只问本次请求给出的键（沿用的覆盖值不是本次输入）。
    if (isRequestInput(input, `custom:${id}`) && fieldMode(`custom:${id}`) !== 'editable')
      throw new AppError('VALIDATION_FAILED', '当前表单不允许编辑此自定义字段');
  }
  for (const field of definitions) {
    const code = `custom:${field.id}`;
    const mode = fieldMode(code);
    const inherits = !metadata.startsNewCycle && (field.inherit || mode === 'readonly' || mode === 'hidden');
    const deferred =
      inherits && (metadata.group === null || mode === 'absent' || (!metadata.autoPopulate && mode === 'editable'));
    const inherited = eligible?.customFields[field.id] ?? null;
    originPolicies.push(
      inheritanceOrigin(code, deferred ? 'deferred' : inherits ? 'inherit' : 'none', eligible?.id ?? null, inherited),
    );
    if (owns(explicitCustom, field.id)) {
      const value = explicitCustom[field.id];
      // 设计 §4：select 停用项只可沿用；修改已保存申请时本单旧值与前驱版本的值都算沿用。
      const retained = [previousCustomFields?.[field.id], eligible?.customFields[field.id]].includes(
        value as CustomValue,
      );
      customFields[field.id] = validateCustomValue(value, field.valueType, field.options, retained ? value : undefined);
      explicitFieldCodes.push(`custom:${field.id}`);
    } else if (deferred) deferredFieldCodes.push(code);
    else if (inherits) customFields[field.id] = inherited;
  }
}

async function selfServiceForm(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  configured: Awaited<ReturnType<typeof resolveTransferForm>> | ReturnType<typeof resolveForm>,
) {
  // DEC-205：同一 HR 表单按本人身份编辑权裁剪。不可编辑字段按只读继承，不能因 HR 场景留空而丢失原值。
  if (ctx.selfServiceEmployeeId === input.employeeId && ctx.authorize && 'fieldModes' in configured) {
    const authorize = authorizeInTransaction(ctx.authorize, tx);
    const fieldModes = { ...configured.fieldModes };
    for (const [code, mode] of Object.entries(fieldModes)) {
      if (mode !== 'editable') continue;
      if (
        EMPLOYEE_READONLY_FIELDS.has(code.replace(/^preset:/, '')) ||
        !(await authorize({
          ...ctx,
          action: 'object.create',
          resource: 'TenantBase.EmploymentRecord',
          fields: [code.replace(/^preset:/, '')],
        }))
      )
        fieldModes[code] = 'readonly';
    }
    configured = { ...configured, fieldModes };
  }
  return configured;
}

/** 任职字典（F-323 / F-363）：新建以合格前驱为沿用基准，新周期无前驱；修改既有申请（带冻结表单）不在此判定，
 * 由 prepareEmploymentPatch 在字段合并后以本单旧值为基准判定。 */
async function validateInheritedDictionaries(
  tx: Tx,
  tenantId: string,
  fields: EmploymentRecord['fields'],
  eligible: EmploymentRecord | null,
  frozenForm: TrustedFormSnapshot | undefined,
  retainedEmploymentForm?: string | null,
) {
  if (!frozenForm) {
    await validateSelectedEmploymentType(tx, tenantId, fields.employmentType, eligible?.fields.employmentType);
    await validateSelectedEmploymentForm(
      tx,
      tenantId,
      fields.employmentForm,
      retainedEmploymentForm === undefined ? eligible?.fields.employmentForm : retainedEmploymentForm,
    );
  }
}

function frozenFormModes(frozenForm: TrustedFormSnapshot) {
  return {
    grouped: frozenForm.group !== null,
    customMode: frozenForm.customMode,
    fieldModes: frozenForm.fieldModes,
    autoPopulate: frozenForm.autoPopulate ?? true,
    excludedAutofillFields: frozenForm.excludedAutofillFields ?? [],
  };
}

async function employeeCode(tx: Tx, tenantId: string, employeeId: string) {
  const [employee] = rowsOf<{ code: string | null }>(
    await tx.execute(sql`
      SELECT code FROM employment_employees WHERE tenant_id=${tenantId} AND id=${employeeId} LIMIT 1
    `),
  );
  if (!employee) throw new AppError('NOT_FOUND', '员工不存在');
  return employee;
}

function applyPresetInheritance(
  metadata: TrustedFormSnapshot,
  eligible: EmploymentRecord | null,
  fields: PresetFields,
  deferredFieldCodes: string[],
): FieldOriginDraft[] {
  const originPolicies: FieldOriginDraft[] = [];
  const fieldMode = (code: string): CustomMode => metadata.fieldModes[code] ?? 'absent';
  const excluded = new Set(metadata.excludedAutofillFields);
  for (const field of INHERITED_FIELDS) {
    const code = `preset:${field}`;
    const mode = fieldMode(code);
    // DEC-163：场景留空始终存空，关闭自动带出也不能让它进入生效时继承队列。
    const inherits = !metadata.startsNewCycle && !(excluded.has(field) && mode === 'editable');
    const eager =
      metadata.group !== null &&
      mode !== 'absent' &&
      (metadata.autoPopulate || mode === 'readonly' || mode === 'hidden');
    if (inherits && eager) setField(fields, field, eligible?.fields[field] ?? null);
    if (inherits && !eager) deferredFieldCodes.push(code);
    originPolicies.push(
      inheritanceOrigin(
        code,
        inherits ? (eager ? 'inherit' : 'deferred') : 'none',
        eligible?.id ?? null,
        fields[field],
      ),
    );
  }
  return originPolicies;
}

export async function prepareInheritance(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  frozenForm?: TrustedFormSnapshot,
  previousCustomFields?: CustomFields,
): Promise<PreparedFormInheritance> {
  businessDate(input.effectiveDate);
  let configured =
    input.kind === 'transfer'
      ? await applyInitiatorFieldModes(tx, ctx, await resolveTransferForm(tx, ctx.tenantId, input.formId))
      : resolveForm(input.formId);
  configured = await selfServiceForm(tx, ctx, input, configured);
  const form = frozenForm ? frozenFormModes(frozenForm) : configured;
  const employee = await employeeCode(tx, ctx.tenantId, input.employeeId);
  const parsedFields = presetFieldsSchema.safeParse(input.fields ?? {});
  if (!parsedFields.success) throw new AppError('VALIDATION_FAILED', '任职预置字段不合法');
  const fields = emptyFields();
  const definitions = (await getCustomFieldsForInheritance(tx, ctx.tenantId)).map((field) => ({
    ...field,
    inherit: frozenForm ? (frozenForm.customInheritance[field.id] ?? false) : field.inherit,
  }));
  const customFields: Record<string, CustomValue> = Object.fromEntries(definitions.map((field) => [field.id, null]));
  const explicitFieldCodes: string[] = [];
  const derivedOrigins: FieldDerivation[] = [];
  const deferredFieldCodes: string[] = [];
  const startsNewCycle = NEW_CYCLES.includes(input.kind);
  const previous = startsNewCycle
    ? null
    : await findPredecessor(tx, ctx.tenantId, input.employeeId, input.effectiveDate);
  const eligible = previous && (!input.staffId || previous.staffId === input.staffId) ? previous : null;
  const metadata = snapshotForm(input, form, startsNewCycle, definitions);
  const originPolicies = applyPresetInheritance(metadata, eligible, fields, deferredFieldCodes);
  await applyExplicitPresetFields(
    tx,
    ctx,
    input,
    parsedFields.data,
    metadata,
    fields,
    explicitFieldCodes,
    derivedOrigins,
    employee.code,
  );
  await validateInheritedDictionaries(tx, ctx.tenantId, fields, eligible, frozenForm, input.retainedEmploymentForm);
  applyCustomInheritance(
    input,
    metadata,
    definitions,
    eligible,
    customFields,
    explicitFieldCodes,
    deferredFieldCodes,
    originPolicies,
    previousCustomFields,
  );
  const explicit = new Set(explicitFieldCodes);
  for (const origin of derivedOrigins) explicit.add(`preset:${derivationFields(origin).field}`);
  return {
    effectiveDate: input.effectiveDate,
    fields,
    customFields,
    formSnapshot: { ...metadata, fieldDerivations: derivedOrigins },
    deferredFieldCodes: deferredFieldCodes.filter((field) => !explicit.has(field)),
    explicitFieldCodes,
    originPolicies,
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
): Promise<PreparedFormInheritance> {
  // 已保存申请的字段策略随申请冻结；修改表单配置不能把原单只读字段变成可伪造写入。
  const prepared = await prepareInheritance(
    tx,
    ctx,
    { ...input, previousDerivations: previous.formSnapshot.fieldDerivations },
    previous.formSnapshot,
    previous.customFields,
  );
  const merged =
    input.effectiveDate === previous.effectiveDate ? restoreFrozenDefaults(input, previous, prepared) : prepared;
  // F-323 第 2 轮 P2-2：字段最终合并后，以锁内本单旧值为沿用基准判断是否改选，不以前驱类别为准；
  // 改期且未显式填写时类别按 DEC-041 从新前驱重新带出（人员类别无派生来源），带出值即沿用基准
  const reinherited =
    input.effectiveDate !== previous.effectiveDate && !merged.explicitFieldCodes.includes('preset:employmentType');
  const baseline = reinherited ? merged.fields.employmentType : previous.fields.employmentType;
  await validateSelectedEmploymentType(tx, ctx.tenantId, merged.fields.employmentType, baseline);
  const formReinherited =
    input.effectiveDate !== previous.effectiveDate && !merged.explicitFieldCodes.includes('preset:employmentForm');
  await validateSelectedEmploymentForm(
    tx,
    ctx.tenantId,
    merged.fields.employmentForm,
    formReinherited ? merged.fields.employmentForm : previous.fields.employmentForm,
  );
  return merged;
}

/** 日期不变：恢复创建时冻结的默认值，本次显式填写与上一版显式 / 延后字段除外。 */
function restoreFrozenDefaults(
  input: InheritanceInput,
  previous: PreparedInheritance,
  prepared: PreparedFormInheritance,
): PreparedFormInheritance {
  const explicit = new Set(prepared.explicitFieldCodes);
  const oldDeferred = new Set(previous.deferredFieldCodes);
  const oldExplicit = new Set(previous.explicitFieldCodes);
  const fields = { ...prepared.fields };
  const customFields = { ...prepared.customFields };
  const frozen = new Map<string, unknown>();
  for (const field of INHERITED_FIELDS) {
    const code = `preset:${field}`;
    // 只恢复创建时冻结的默认值；上一版显式填写、本次被放弃的值（DEC-107 改选职务时的序列）改取当前默认值。
    const rederived =
      (field === 'directManagerId' &&
        isRequestInput(input, 'preset:departmentId') &&
        owns(input.fields ?? {}, 'departmentId') &&
        input.fields?.departmentId !== previous.fields.departmentId) ||
      (field === 'sequenceId' &&
        isRequestInput(input, 'preset:postId') &&
        owns(input.fields ?? {}, 'postId') &&
        input.fields?.postId !== previous.fields.postId);
    if (!rederived && !explicit.has(code) && !oldDeferred.has(code) && !oldExplicit.has(code)) {
      setField(fields, field, previous.fields[field]);
      frozen.set(code, fields[field]);
    }
  }
  for (const id of Object.keys(customFields)) {
    const code = `custom:${id}`;
    if (!explicit.has(code) && !oldDeferred.has(code)) {
      customFields[id] = previous.customFields[id] ?? null;
      frozen.set(code, customFields[id]);
    }
  }
  return {
    ...prepared,
    fields,
    customFields,
    originPolicies: prepared.originPolicies.map((row) =>
      frozen.has(row.fieldCode) && row.originKind === 'inherit'
        ? inheritanceOrigin(row.fieldCode, 'inherit', previous.sourceRecordId, frozen.get(row.fieldCode))
        : row,
    ),
    formSnapshot: {
      ...previous.formSnapshot,
      fieldDerivations: frozenDerivations(previous, prepared, frozen),
    },
    sourceRecordId: previous.sourceRecordId,
    sourceStaffId: previous.sourceStaffId,
    deferredFieldCodes: prepared.deferredFieldCodes,
  };
}

/**
 * 冻结值与它的派生依据一起保留（第 3 轮 P2-2）：被恢复成上一版的字段，派生标记也取上一版的；本次重新派生出的标记只留给
 * 没被冻结的字段。否则同日保存后 fieldDerivations 丢了依据，下一次改期认不出“上一版按同一依据派生过”，不再重取。
 * 上一版的依据 referenceId 与当前依赖不一致时（传播覆盖、依赖换选）triggers() 本来就不匹配，不会误触发。
 */
function frozenDerivations(
  previous: PreparedInheritance,
  prepared: PreparedFormInheritance,
  frozen: ReadonlyMap<string, unknown>,
): readonly FieldDerivation[] {
  const isFrozen = (origin: FieldDerivation) => frozen.has(`preset:${derivationFields(origin).field}`);
  return [
    ...(prepared.formSnapshot.fieldDerivations ?? []).filter((origin) => !isFrozen(origin)),
    ...(previous.formSnapshot.fieldDerivations ?? []).filter(isFrozen),
  ];
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
  const visible = (code: string) => {
    const mode = prepared.formSnapshot.fieldModes[code];
    return mode === 'editable' || mode === 'readonly';
  };
  const fields = Object.fromEntries(Object.entries(prepared.fields).filter(([field]) => visible(`preset:${field}`)));
  const customFields = Object.fromEntries(
    Object.entries(prepared.customFields).filter(([id]) => visible(`custom:${id}`)),
  );
  return {
    fields,
    customFields,
    previousRecordId: prepared.sourceRecordId,
    staffId: prepared.sourceStaffId,
  };
}
