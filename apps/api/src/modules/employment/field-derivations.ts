/** 派生规则与来源由服务端保存；显式输入、业务派生、前驱继承不能靠值是否相等来区分。 */
import type { Tx } from '@italent/db';
import { loadJobObject } from '../job/read-model.js';
import { managerForTransferDepartment } from '../transfer/preview-defaults.js';
import { readPositionAssignments } from './personnel-reader.js';
import type { BusinessKind, PresetField, PresetFields } from './types.js';

export type DerivationRule = 'post-sequence' | 'department-manager' | 'position-manager';
export interface FieldDerivation {
  readonly rule: DerivationRule;
  readonly referenceId: string | null;
}
const rules = {
  'post-sequence': { field: 'sequenceId', reference: 'postId' },
  'department-manager': { field: 'directManagerId', reference: 'departmentId' },
  'position-manager': { field: 'directManagerId', reference: 'positionId' },
} as const;
export const derivationFields = (origin: FieldDerivation) => rules[origin.rule];

/**
 * DEC-107：显式序列包含 null 均优先。
 * TODO(需取证 #42)：职务未配置序列时是否清空尚未实测，沿用不带出、保留原值。
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

/** F-006 / DEC-131：唯一在岗人且非本人才能带出；创建与引用变化后的重算共用这一条件。 */
export function soleOtherPositionManager(employeeIds: readonly string[], employeeId: string): string | undefined {
  return employeeIds.length === 1 && employeeIds[0] !== employeeId ? employeeIds[0] : undefined;
}

export async function resolveDerivation(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  date: string,
  origin: FieldDerivation,
): Promise<string | null | undefined> {
  if (origin.rule === 'post-sequence')
    return (await sequenceForNewPost(tx, tenantId, { postId: origin.referenceId }, date)) ?? undefined;
  if (origin.rule === 'department-manager')
    return managerForTransferDepartment(tx, tenantId, { departmentId: origin.referenceId }, date);
  if (!origin.referenceId) return undefined;
  const position = await loadJobObject(tx, tenantId, 'positions', origin.referenceId, date);
  if (typeof position?.directParentId !== 'string') return undefined;
  const { items } = await readPositionAssignments(tx, {
    tenantId,
    positionId: position.directParentId,
    asOf: date,
    limit: 2,
  });
  return soleOtherPositionManager(
    items.map((item) => item.employeeId),
    employeeId,
  );
}

export interface DerivationForm {
  readonly group: BusinessKind | null;
  readonly fieldModes: Readonly<Record<string, string>>;
  readonly autoPopulate?: boolean;
}

/** 只发现本业务实际触发的派生；职级/职等的范围过滤并非赋值规则。 */
export async function derivePresetFields(
  tx: Tx,
  tenantId: string,
  input: { employeeId: string; effectiveDate: string; kind: BusinessKind; formId: string },
  parsed: Partial<PresetFields>,
  form: DerivationForm,
) {
  const candidates: FieldDerivation[] = [];
  if (
    parsed.postId &&
    !Object.hasOwn(parsed, 'sequenceId') &&
    (input.kind !== 'transfer' || (form.fieldModes['preset:sequenceId'] ?? 'absent') !== 'absent')
  )
    candidates.push({ rule: 'post-sequence', referenceId: parsed.postId });
  if (
    input.kind === 'transfer' &&
    input.formId !== 'standard' &&
    form.group !== null &&
    form.autoPopulate &&
    form.fieldModes['preset:directManagerId'] === 'editable' &&
    parsed.departmentId &&
    !Object.hasOwn(parsed, 'directManagerId')
  )
    candidates.push({ rule: 'department-manager', referenceId: parsed.departmentId });
  const origins: FieldDerivation[] = [];
  const values: Partial<PresetFields> = {};
  for (const origin of candidates) {
    const value = await resolveDerivation(tx, tenantId, input.employeeId, input.effectiveDate, origin);
    if (value === undefined) continue;
    Object.assign(values, { [rules[origin.rule].field]: value });
    origins.push(origin);
  }
  return { values, origins };
}

export type FieldOrigin = 'explicit' | 'business-derived' | 'predecessor';
export function presetFieldOrigin(
  field: PresetField,
  explicit: ReadonlySet<string>,
  origins: readonly FieldDerivation[],
): FieldOrigin {
  if (origins.some((origin) => rules[origin.rule].field === field)) return 'business-derived';
  return explicit.has(`preset:${field}`) ? 'explicit' : 'predecessor';
}
