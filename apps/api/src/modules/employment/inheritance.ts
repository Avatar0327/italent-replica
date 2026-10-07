import { applyInitiatorFieldModes } from '../transfer/initiator-fields.js';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { loadJobObject } from '../job/read-model.js';
import { resolveTransferForm } from '../transfer/configuration.js';
import { managerForTransferDepartment } from '../transfer/preview-defaults.js';
import {
  EMPLOYEE_READONLY_FIELDS,
  employeeTransferPosition,
  isEmployeeTransferPayload,
} from '../transfer/employee-policy.js';
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

type CustomMode = 'editable' | 'readonly' | 'hidden' | 'absent';
interface TrustedFormSnapshot {
  readonly employeeTransfer?: boolean;
  readonly employeePositionByHr?: boolean;
  readonly id: FormId;
  readonly group: BusinessKind | null;
  readonly customMode: CustomMode;
  readonly startsNewCycle: boolean;
  readonly customInheritance: Readonly<Record<string, boolean>>;
  readonly fieldModes: Readonly<Record<string, CustomMode>>;
  readonly autoPopulate?: boolean;
  readonly excludedAutofillFields?: readonly string[];
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
  /** 仅审批中心校验节点编辑权后由任职服务设置，客户端输入不接受此字段。 */
  readonly allowEmployeePositionEdit?: boolean;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly kind: BusinessKind;
  readonly formId: FormId;
  readonly fields?: Partial<PresetFields>;
  readonly customFields?: CustomFields;
  readonly staffId?: string;
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

/**
 * DEC-107（照搬原站 W-240、W-425）：选了新职务而未传职务序列时，由服务端按该职务在生效日的序列带出；
 * 页面、接口、导入与编辑任职一致，随后按特殊规则③与职务一并向后更新。显式传入序列（含清空）时以传入为准。
 * 返回 null 表示不带出。
 * TODO(需取证 #42)：新职务未配置序列时原站是否清空序列未实测，暂保留原有序列。
 */
export async function sequenceForNewPost(
  tx: Tx,
  tenantId: string,
  fields: Partial<PresetFields>,
  effectiveDate: string,
): Promise<string | null> {
  if (!fields.postId || Object.hasOwn(fields, 'sequenceId')) return null;
  const post = await loadJobObject(tx, tenantId, 'posts', fields.postId, effectiveDate);
  return typeof post?.sequenceId === 'string' ? post.sequenceId : null;
}
const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function setField(target: PresetFields, key: PresetField, value: PresetFields[PresetField]): void {
  Object.assign(target, { [key]: value });
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

async function applyExplicitPresetFields(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  parsedFields: Partial<PresetFields>,
  metadata: TrustedFormSnapshot,
  fields: PresetFields,
  explicitFieldCodes: string[],
  derivedFieldCodes: string[],
  employeeCode: string,
): Promise<void> {
  const fieldMode = (code: string): CustomMode => metadata.fieldModes[code] ?? 'absent';
  for (const [field, value] of Object.entries(parsedFields)) {
    if (
      input.kind === 'transfer' &&
      fieldMode(`preset:${field}`) !== 'editable' &&
      !(field === 'positionId' && metadata.employeeTransfer && input.allowEmployeePositionEdit)
    )
      throw new AppError('VALIDATION_FAILED', '当前表单不允许编辑此任职字段');
    setField(fields, field as PresetField, value ?? null);
    explicitFieldCodes.push(`preset:${field}`);
  }
  // DEC-187：只读/隐藏限制人工输入，不限制系统派生。
  const derivedSequence =
    input.kind !== 'transfer' || fieldMode('preset:sequenceId') !== 'absent'
      ? await sequenceForNewPost(tx, ctx.tenantId, parsedFields, input.effectiveDate)
      : null;
  if (derivedSequence) {
    setField(fields, 'sequenceId', derivedSequence);
    derivedFieldCodes.push('preset:sequenceId');
  }
  if (
    input.kind === 'transfer' &&
    // 通用任职接口保留版本链继承；选部门带负责人只属于真实调动场景表单，不能改变既有申请的变化字段。
    input.formId !== 'standard' &&
    metadata.group !== null &&
    metadata.autoPopulate &&
    fieldMode('preset:directManagerId') === 'editable'
  ) {
    const manager = await managerForTransferDepartment(tx, ctx.tenantId, parsedFields, input.effectiveDate);
    if (manager !== undefined) {
      setField(fields, 'directManagerId', manager);
      derivedFieldCodes.push('preset:directManagerId');
    }
  }
  if (owns(parsedFields, 'jobNumber') && parsedFields.jobNumber !== null) {
    if (parsedFields.jobNumber!.toLowerCase() !== employeeCode.toLowerCase()) {
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
): void {
  const fieldMode = (code: string): CustomMode => metadata.fieldModes[code] ?? 'absent';
  const explicitCustom = input.customFields ?? {};
  if (Object.keys(explicitCustom).length > 200) throw new AppError('VALIDATION_FAILED', '单次自定义字段超过处理上限');
  for (const id of Object.keys(explicitCustom)) {
    if (!definitions.some((field) => field.id === id))
      throw new AppError('VALIDATION_FAILED', '自定义字段不属于本租户任职对象');
    if (fieldMode(`custom:${id}`) !== 'editable')
      throw new AppError('VALIDATION_FAILED', '当前表单不允许编辑此自定义字段');
  }
  for (const field of definitions) {
    if (owns(explicitCustom, field.id)) {
      customFields[field.id] = validateCustomValue(explicitCustom[field.id], field.valueType);
      explicitFieldCodes.push(`custom:${field.id}`);
    } else if (!metadata.startsNewCycle) {
      const mode = fieldMode(`custom:${field.id}`);
      const inherits = field.inherit || mode === 'readonly' || mode === 'hidden';
      if (!inherits) continue;
      if (metadata.group === null || mode === 'absent' || (!metadata.autoPopulate && mode === 'editable'))
        deferredFieldCodes.push(`custom:${field.id}`);
      else customFields[field.id] = eligible?.customFields[field.id] ?? null;
    }
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
    fieldModes['preset:positionId'] = 'hidden';
    configured = { ...configured, fieldModes };
  }
  return configured;
}

function employeeFormSnapshot(
  ctx: EmploymentContext,
  input: InheritanceInput,
  snapshot: TrustedFormSnapshot,
  frozen?: TrustedFormSnapshot,
): TrustedFormSnapshot {
  const employeeTransfer =
    input.kind === 'transfer' && (frozen?.employeeTransfer || ctx.selfServiceEmployeeId === input.employeeId);
  const employeePositionByHr =
    frozen?.employeePositionByHr ||
    (employeeTransfer && input.allowEmployeePositionEdit && Object.hasOwn(input.fields ?? {}, 'positionId'));
  return {
    ...snapshot,
    ...(employeeTransfer ? { employeeTransfer: true } : {}),
    ...(employeePositionByHr ? { employeePositionByHr: true } : {}),
  };
}

async function prepareEmployeePosition(
  tx: Tx,
  ctx: EmploymentContext,
  prepared: PreparedInheritance,
  sourcePositionId: string | null,
) {
  if (!prepared.formSnapshot.employeeTransfer) return prepared;
  // 部门留待生效时继承时尚不能判断跨部门；保留职位及其原有延迟继承标记。
  if (prepared.deferredFieldCodes.includes('preset:departmentId'))
    return {
      ...prepared,
      fields: prepared.explicitFieldCodes.includes('preset:positionId')
        ? prepared.fields
        : { ...prepared.fields, positionId: sourcePositionId },
    };
  // 部门已明确时，这里只按当前前驱算出预览与引用校验用的职位；职位单独延迟继承（未分组表单）仍保留标记，
  // 到期按落地时的前驱继承后再按 DEC-232 判断（resolveEffectiveInheritance），不在建单 / 改单时提前固定。
  return {
    ...prepared,
    fields: prepared.explicitFieldCodes.includes('preset:positionId')
      ? prepared.fields
      : await employeeTransferPosition(tx, ctx, prepared.effectiveDate, {
          ...prepared.fields,
          positionId: sourcePositionId,
        }),
  };
}

export async function prepareInheritance(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  frozenForm?: TrustedFormSnapshot,
): Promise<PreparedInheritance> {
  businessDate(input.effectiveDate);
  let configured =
    input.kind === 'transfer'
      ? await applyInitiatorFieldModes(tx, ctx, await resolveTransferForm(tx, ctx.tenantId, input.formId))
      : resolveForm(input.formId);
  configured = await selfServiceForm(tx, ctx, input, configured);
  const form = frozenForm
    ? {
        grouped: frozenForm.group !== null,
        customMode: frozenForm.customMode,
        fieldModes: frozenForm.fieldModes,
        autoPopulate: frozenForm.autoPopulate ?? true,
        excludedAutofillFields: frozenForm.excludedAutofillFields ?? [],
      }
    : configured;
  const [employee] = rowsOf<{ code: string }>(
    await tx.execute(sql`
      SELECT code FROM employment_employees WHERE tenant_id=${ctx.tenantId} AND id=${input.employeeId} LIMIT 1
    `),
  );
  if (!employee) throw new AppError('NOT_FOUND', '员工不存在');
  const parsedFields = presetFieldsSchema.safeParse(input.fields ?? {});
  if (!parsedFields.success) throw new AppError('VALIDATION_FAILED', '任职预置字段不合法');
  const fields = emptyFields();
  const definitions = (await getCustomFieldsForInheritance(tx, ctx.tenantId)).map((field) => ({
    ...field,
    inherit: frozenForm ? (frozenForm.customInheritance[field.id] ?? false) : field.inherit,
  }));
  const customFields: Record<string, CustomValue> = Object.fromEntries(definitions.map((field) => [field.id, null]));
  const explicitFieldCodes: string[] = [];
  const derivedFieldCodes: string[] = [];
  const deferredFieldCodes: string[] = [];
  const startsNewCycle = NEW_CYCLES.includes(input.kind);
  const previous = startsNewCycle
    ? null
    : await findPredecessor(tx, ctx.tenantId, input.employeeId, input.effectiveDate);
  const eligible = previous && (!input.staffId || previous.staffId === input.staffId) ? previous : null;
  const metadata = employeeFormSnapshot(ctx, input, snapshotForm(input, form, startsNewCycle, definitions), frozenForm);
  const fieldMode = (code: string): CustomMode => metadata.fieldModes[code] ?? 'absent';
  const excluded = new Set(metadata.excludedAutofillFields);
  for (const field of INHERITED_FIELDS) {
    if (startsNewCycle) continue;
    const mode = fieldMode(`preset:${field}`);
    // DEC-163：场景留空始终存空，关闭自动带出也不能让它进入生效时继承队列。
    if (excluded.has(field) && mode === 'editable') continue;
    if (form.grouped && mode !== 'absent' && (metadata.autoPopulate || mode === 'readonly' || mode === 'hidden'))
      setField(fields, field, eligible?.fields[field] ?? null);
    else deferredFieldCodes.push(`preset:${field}`);
  }
  await applyExplicitPresetFields(
    tx,
    ctx,
    input,
    parsedFields.data,
    metadata,
    fields,
    explicitFieldCodes,
    derivedFieldCodes,
    employee.code,
  );
  applyCustomInheritance(input, metadata, definitions, eligible, customFields, explicitFieldCodes, deferredFieldCodes);
  const explicit = new Set([...explicitFieldCodes, ...derivedFieldCodes]);
  const prepared = {
    effectiveDate: input.effectiveDate,
    fields,
    customFields,
    formSnapshot: metadata,
    deferredFieldCodes: deferredFieldCodes.filter((field) => !explicit.has(field)),
    explicitFieldCodes,
    sourceRecordId: eligible?.id ?? null,
    sourceStaffId: eligible?.staffId ?? null,
  };
  return prepareEmployeePosition(tx, ctx, prepared, eligible?.fields.positionId ?? null);
}

async function preparePatchedInheritance(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  previous: PreparedInheritance,
  snapshot: TrustedFormSnapshot,
  requestedFields: Partial<PresetFields>,
): Promise<PreparedInheritance> {
  const employeeTransfer = snapshot.employeeTransfer;
  // 保存的显式值也可能来自 HR / 向后传播；只校验本次请求的字段模式，不能把保存值当成人工输入。
  const carried = PRESET_FIELDS.filter(
    (field) =>
      employeeTransfer &&
      previous.explicitFieldCodes.includes(`preset:${field}`) &&
      owns(input.fields ?? {}, field) &&
      !owns(requestedFields, field) &&
      (snapshot.fieldModes[`preset:${field}`] !== 'editable' || EMPLOYEE_READONLY_FIELDS.has(field)),
  );
  const submitted = { ...input.fields };
  for (const field of carried) delete submitted[field];
  let prepared = await prepareInheritance(tx, ctx, { ...input, fields: submitted }, snapshot);
  if (carried.length) {
    const fields = { ...prepared.fields };
    for (const field of carried) setField(fields, field, previous.fields[field]);
    const codes = carried.map((field) => `preset:${field}`);
    prepared = {
      ...prepared,
      fields,
      explicitFieldCodes: [...new Set([...prepared.explicitFieldCodes, ...codes])],
      deferredFieldCodes: prepared.deferredFieldCodes.filter(
        (code) =>
          !codes.includes(code) ||
          (code === 'preset:positionId' && prepared.deferredFieldCodes.includes('preset:departmentId')),
      ),
    };
  }
  if (
    employeeTransfer &&
    !prepared.deferredFieldCodes.includes('preset:departmentId') &&
    !(input.allowEmployeePositionEdit && owns(requestedFields, 'positionId'))
  ) {
    const fields = await employeeTransferPosition(tx, ctx, prepared.effectiveDate, prepared.fields);
    const cleared = prepared.fields.positionId !== null && fields.positionId === null;
    prepared = {
      ...prepared,
      fields,
      ...(cleared
        ? {
            explicitFieldCodes: prepared.explicitFieldCodes.filter((code) => code !== 'preset:positionId'),
            formSnapshot: { ...prepared.formSnapshot, employeePositionByHr: false },
          }
        : {}),
    };
  }
  return prepared;
}

/** 日期不变时保留创建表单时捕获的默认值；日期改变按 DEC-041 重新查前驱。 */
export async function prepareEmploymentPatch(
  tx: Tx,
  ctx: EmploymentContext,
  input: InheritanceInput,
  previous: PreparedInheritance,
  requestedFields: Partial<PresetFields> = input.fields ?? {},
): Promise<PreparedInheritance> {
  // 已保存申请的字段策略随申请冻结；修改表单配置不能把原单只读字段变成可伪造写入。
  const employeeTransfer =
    previous.formSnapshot.employeeTransfer || (await isEmployeeTransferPayload(tx, ctx.tenantId, previous));
  const snapshot = { ...previous.formSnapshot, ...(employeeTransfer ? { employeeTransfer: true } : {}) };
  const prepared = await preparePatchedInheritance(tx, ctx, input, previous, snapshot, requestedFields);
  if (input.effectiveDate !== previous.effectiveDate) return prepared;
  const explicit = new Set(prepared.explicitFieldCodes);
  const oldDeferred = new Set(previous.deferredFieldCodes);
  const oldExplicit = new Set(previous.explicitFieldCodes);
  const fields = { ...prepared.fields };
  const customFields = { ...prepared.customFields };
  for (const field of INHERITED_FIELDS) {
    const code = `preset:${field}`;
    // 只恢复创建时冻结的默认值；上一版显式填写、本次被放弃的值（DEC-107 改选职务时的序列）改取当前默认值。
    const rederived =
      (field === 'positionId' && employeeTransfer) ||
      (field === 'directManagerId' &&
        owns(input.fields ?? {}, 'departmentId') &&
        input.fields?.departmentId !== previous.fields.departmentId) ||
      (field === 'sequenceId' && owns(input.fields ?? {}, 'postId') && input.fields?.postId !== previous.fields.postId);
    if (!rederived && !explicit.has(code) && !oldDeferred.has(code) && !oldExplicit.has(code))
      setField(fields, field, previous.fields[field]);
  }
  for (const id of Object.keys(customFields)) {
    const code = `custom:${id}`;
    if (!explicit.has(code) && !oldDeferred.has(code)) customFields[id] = previous.customFields[id] ?? null;
  }
  return {
    ...prepared,
    fields,
    customFields,
    formSnapshot: prepared.formSnapshot,
    sourceRecordId: previous.sourceRecordId,
    sourceStaffId: previous.sourceStaffId,
    deferredFieldCodes: prepared.deferredFieldCodes,
  };
}

export async function resolveEffectiveInheritance(
  tx: Tx,
  ctx: EmploymentContext,
  prepared: PreparedInheritance,
  effective: { staffId: string; predecessor: EmploymentRecord | null },
  options: { readonly explicitPositionEdit?: boolean } = {},
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
  const employeeTransfer =
    prepared.formSnapshot.employeeTransfer || (await isEmployeeTransferPayload(tx, ctx.tenantId, prepared));
  return {
    fields:
      // 部门与职位的延迟继承已完成；保存的显式值也必须遵守 DEC-232。
      // 本次 HR 审批编辑例外：保留其输入，让引用校验拒绝不属于目标部门的职位。
      employeeTransfer && !options.explicitPositionEdit
        ? await employeeTransferPosition(tx, ctx, prepared.effectiveDate, fields)
        : fields,
    customFields,
  };
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
