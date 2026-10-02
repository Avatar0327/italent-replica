/**
 * 有效功能权限：同一用户多个身份的对象权限取并集（DEC-042：任一身份允许即允许，不做“拒绝优先”）。
 * 可执行动作 = 按钮已勾选 ∧ 对应数据操作开启（REQ-PRM-001 R6）；先并集再组合，与原站 AC-PRM-20 实测一致：
 * 另一身份开启了“编辑”，测试身份关闭也会被放行。记录是否在数据范围内由 R1-T02 另行判定。
 */
import {
  buttonKey,
  type DataOperation,
  type DataOperations,
  isWithinProfileApps,
  type ObjectCatalog,
  type ObjectDefinition,
  type ObjectPermission,
} from './object-permission.js';

/** 用户某个有效授权带来的对象权限，连同该身份登记的应用（判定应用边界用）。 */
export interface GrantedObjectPermission extends ObjectPermission {
  readonly profileApps: readonly string[];
}

export interface EffectiveObjectPermission {
  readonly objectCode: string;
  readonly dataOperations: DataOperations;
  /** 可查看的字段：列表列与表单字段同时按它裁剪（AC-PRM-22）。 */
  readonly viewableFields: ReadonlySet<string>;
  /** 可编辑的字段：编辑须以可查看为前提（看不到的字段不能写）。 */
  readonly editableFields: ReadonlySet<string>;
  /** 已勾选的按钮（buttonKey 形式）。 */
  readonly grantedButtons: ReadonlySet<string>;
}

const NONE: DataOperations = { create: false, update: false, delete: false };

/** 合并同一对象在多个身份中的配置；对象不在任何身份的对象清单中时返回 undefined（无功能权限）。 */
export function mergeObjectPermissions(
  objectCode: string,
  permissions: readonly ObjectPermission[],
): EffectiveObjectPermission | undefined {
  const relevant = permissions.filter((p) => p.objectCode === objectCode);
  if (relevant.length === 0) return undefined;

  const ops = { ...NONE };
  const viewable = new Set<string>();
  const editable = new Set<string>();
  const buttons = new Set<string>();
  for (const permission of relevant) {
    for (const op of Object.keys(ops) as DataOperation[]) ops[op] ||= permission.dataOperations[op];
    for (const field of permission.fields) {
      if (field.view) viewable.add(field.fieldCode);
      if (field.edit) editable.add(field.fieldCode);
    }
    for (const button of permission.buttons) buttons.add(buttonKey(button.buttonCode, button.level));
  }
  for (const field of editable) if (!viewable.has(field)) editable.delete(field);
  return {
    objectCode,
    dataOperations: ops,
    viewableFields: viewable,
    editableFields: editable,
    grantedButtons: buttons,
  };
}

export interface ResolvedObjectPermission {
  readonly definition: ObjectDefinition;
  readonly effective: EffectiveObjectPermission;
}

/**
 * 判定入口：对象须已登记；只取“身份登记了对象所属应用”的那些权限（应用边界）再并集；
 * 可编辑字段再收窄到已登记的非系统字段（库里即便有脏数据，系统字段也不可写，AC-PRM-23）。
 */
export function resolveObjectPermission(
  objectCode: string,
  permissions: readonly GrantedObjectPermission[],
  catalog: ObjectCatalog,
): ResolvedObjectPermission | undefined {
  const definition = catalog.get(objectCode);
  if (!definition) return undefined;
  const inBoundary = permissions.filter((p) => isWithinProfileApps(definition, p.profileApps));
  const merged = mergeObjectPermissions(objectCode, inBoundary);
  if (!merged) return undefined;
  const writable = new Set(definition.fields.filter((f) => !f.system).map((f) => f.code));
  const editableFields = new Set([...merged.editableFields].filter((f) => writable.has(f)));
  return { definition, effective: { ...merged, editableFields } };
}

export type FieldWriteViolation =
  | { readonly reason: 'UNKNOWN_FIELD'; readonly fieldCode: string }
  | { readonly reason: 'SYSTEM_FIELD_NOT_EDITABLE'; readonly fieldCode: string }
  | { readonly reason: 'FIELD_NOT_EDITABLE'; readonly fieldCode: string };

/**
 * 服务端载荷字段校验（REQ-PRM-001 字段权限）：要写的每个字段都必须是对象的已登记字段、非系统字段，
 * 且至少一个有效身份授了「编辑」（DEC-042 并集）。返回全部违规项（空数组即可写）。
 */
export function fieldWriteViolations(
  resolved: ResolvedObjectPermission,
  fields: readonly string[],
): FieldWriteViolation[] {
  const known = new Map(resolved.definition.fields.map((f) => [f.code, f]));
  const violations: FieldWriteViolation[] = [];
  for (const fieldCode of new Set(fields)) {
    const field = known.get(fieldCode);
    if (!field) violations.push({ reason: 'UNKNOWN_FIELD', fieldCode });
    else if (field.system) violations.push({ reason: 'SYSTEM_FIELD_NOT_EDITABLE', fieldCode });
    else if (!resolved.effective.editableFields.has(fieldCode))
      violations.push({ reason: 'FIELD_NOT_EDITABLE', fieldCode });
  }
  return violations;
}

export interface ExecutableButton {
  readonly buttonCode: string;
  readonly level: string;
}

/** 可见且可执行的按钮（按对象元数据中的定义判断其依赖的数据操作）。 */
export function executableButtons(
  definition: ObjectDefinition,
  effective: EffectiveObjectPermission,
): ExecutableButton[] {
  return definition.buttons
    .filter((b) => effective.grantedButtons.has(buttonKey(b.code, b.level)))
    .filter((b) => b.requires === undefined || effective.dataOperations[b.requires])
    .map((b) => ({ buttonCode: b.code, level: b.level }));
}

/** 按可查看字段裁剪一条记录（列表行与表单共用，AC-PRM-22）。 */
export function trimToViewableFields<T extends Record<string, unknown>>(
  record: T,
  effective: EffectiveObjectPermission | undefined,
): Partial<T> {
  if (!effective) return {};
  return Object.fromEntries(Object.entries(record).filter(([key]) => effective.viewableFields.has(key))) as Partial<T>;
}
