import { text as transferText } from '../transfer/messages.js';

/**
 * 引用字典 ID / 编码的字段：后端在值旁并列下发名称（F-323a 人员类别；F-474-3b 部门、经理、调动原因 / 类型）。
 * 审批详情与审批中编辑的只读展示都经这里取名：名称键不单独成行。
 */
// ID 字段：界面上不应出现裸 ID，查不到名称时显示占位。
const ID_NAMED_FIELDS: Readonly<Record<string, string>> = {
  employmentType: 'employmentTypeName',
  departmentId: 'departmentIdName',
  directManagerId: 'directManagerIdName',
  dottedManagerId: 'dottedManagerIdName',
};
// 编码字段：同名键在别的业务里是另一种编码（如离职原因 reasonCode，后端不取名）。后端没下发名称键时按原值显示。
const CODE_NAMED_FIELDS: Readonly<Record<string, string>> = {
  reasonCode: 'reasonCodeName',
  transferTypeCode: 'transferTypeCodeName',
};
export const NAME_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(ID_NAMED_FIELDS),
  ...Object.values(CODE_NAMED_FIELDS),
]);

export function namedValue(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const value = record[key];
  if (value === null || value === undefined || value === '') return value;
  const idName = ID_NAMED_FIELDS[key];
  if (idName) return record[idName] ?? transferText.savedValue;
  const codeName = CODE_NAMED_FIELDS[key];
  if (codeName && codeName in record) return record[codeName] ?? transferText.savedValue;
  return value;
}

const blank = (value: unknown) => value === null || value === undefined || value === '';
/** 比较的是原始值（ID / 编码），不是名称；空值（null / 未填 / 空串）视为同一种“没有”。 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  return typeof a === 'object' || typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b;
}
