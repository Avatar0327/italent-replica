import { text as transferText } from '../transfer/messages.js';

/**
 * 引用字典 ID 的字段：后端 namedForm 在 ID 旁并列下发名称（F-323a 人员类别）。审批详情与审批中编辑的只读展示都经这里
 * 取名：名称键不单独成行；有 ID 但查不到名称时显示占位，不回落为 ID。
 */
const NAMED_FIELDS: Readonly<Record<string, string>> = { employmentType: 'employmentTypeName' };
export const NAME_KEYS: ReadonlySet<string> = new Set(Object.values(NAMED_FIELDS));

export function namedValue(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const nameKey = NAMED_FIELDS[key];
  const value = record[key];
  if (!nameKey || value === null || value === undefined || value === '') return value;
  return record[nameKey] ?? transferText.savedValue;
}
