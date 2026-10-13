export interface ObjectPermission {
  objectCode: string;
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
