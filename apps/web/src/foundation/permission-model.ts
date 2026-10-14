export interface ObjectPermission {
  objectCode: string;
  /** 快照仅含入口摘要；字段和按钮须懒加载明细后使用。 */
  summary?: true;
  dataOperations: Readonly<Record<string, boolean>>;
  viewableFields: readonly string[];
  editableFields: readonly string[];
  buttons: readonly { buttonCode: string; level: string }[];
}
export interface FieldAccess {
  visible: boolean;
  editable: boolean;
}
export function canButton(permission: ObjectPermission | undefined, code: string, level: string) {
  return permission?.buttons.some((button) => button.buttonCode === code && button.level === level) ?? false;
}
export function fieldAccess(permission: ObjectPermission | undefined, field: string): FieldAccess {
  const visible = permission?.viewableFields.includes(field) ?? false;
  return { visible, editable: visible && (permission?.editableFields.includes(field) ?? false) };
}
