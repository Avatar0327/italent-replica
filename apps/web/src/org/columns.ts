import { listFields, orgLabel } from './page-model.js';

type FieldGate = { field(name: string): { visible: boolean } };
/**
 * 原站「设置显示字段」（B2_03）：默认即「启用的组织」列；另可加列表接口已返回的简称、状态、显示顺序、虚拟组织、备注。
 * 原站其余字段（职能体系、市场分类、机构级别等）接口未返回，列入后端缺口。负责人等人员 ID 不进候选。
 */
export const orgColumnChoices = [...listFields, 'shortName', 'enabled', 'displayOrder', 'isVirtual', 'remarks'];
/** 原站机构ID、机构名称锁定在最前：不可取消、不可拖动，其他字段不能越过它们。 */
export const lockedOrgColumns = ['code', 'name'];
const locked = (key: string) => lockedOrgColumns.includes(key);

/** 当前可见的候选：无查看权的字段不进候选，也不成列（字段裁剪）。 */
export function orgColumnOptions(access: FieldGate) {
  return orgColumnChoices.filter((key) => access.field(key).visible);
}
export function visibleOrgColumns(selected: readonly string[], allowed: readonly string[]) {
  return selected.filter((key) => allowed.includes(key));
}
/** 新勾选的字段排到已选末尾，顺序由右栏拖拽决定。 */
export function toggleOrgColumn(selected: readonly string[], key: string, checked: boolean): string[] {
  if (locked(key) || !orgColumnChoices.includes(key)) return [...selected];
  if (!checked) return selected.filter((item) => item !== key);
  return selected.includes(key) ? [...selected] : [...selected, key];
}
export function toggleOrgColumnGroup(selected: readonly string[], keys: readonly string[], checked: boolean) {
  if (!checked) return selected.filter((key) => locked(key) || !keys.includes(key));
  return [...selected, ...keys.filter((key) => !selected.includes(key) && orgColumnChoices.includes(key))];
}
export function orgColumnGroupState(selected: readonly string[], keys: readonly string[]) {
  const optional = keys.filter((key) => !locked(key));
  const count = optional.filter((key) => selected.includes(key)).length;
  return { checked: count > 0 && count === optional.length, indeterminate: count > 0 && count < optional.length };
}
/** 拖到目标项的位置；锁定字段不动，其他字段最多排到锁定字段之后。 */
export function moveOrgColumn(selected: readonly string[], key: string, target: string): string[] {
  const from = selected.indexOf(key);
  const to = selected.indexOf(target);
  if (locked(key) || from < 0 || to < 0 || from === to) return [...selected];
  const next = selected.filter((item) => item !== key);
  const floor = next.findIndex((item) => !locked(item));
  next.splice(Math.max(to, floor < 0 ? next.length : floor), 0, key);
  return next;
}
export function restoreOrgColumns() {
  return [...listFields];
}
export function matchOrgColumns(keys: readonly string[], keyword: string) {
  const text = keyword.trim();
  return text ? keys.filter((key) => orgLabel(key, 'list').includes(text)) : [...keys];
}
