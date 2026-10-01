/**
 * 有效功能权限：同一用户多个身份的对象权限取并集（DEC-042：任一身份允许即允许，不做“拒绝优先”）。
 * 可执行动作 = 按钮已勾选 ∧ 对应数据操作开启（REQ-PRM-001 R6）；先并集再组合，与原站 AC-PRM-20 实测一致：
 * 另一身份开启了“编辑”，测试身份关闭也会被放行。记录是否在数据范围内由 R1-T02 另行判定。
 */
import {
  buttonKey,
  type DataOperation,
  type DataOperations,
  type ObjectDefinition,
  type ObjectPermission,
} from './object-permission.js';

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
