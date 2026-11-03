// F-323b（DEC-431①）：人员类别取名的唯一入口。任职 / 兼职 / 审批返回经后端 employmentTypeNames 在
// employmentType（字典 ID）旁并列 employmentTypeName；查不到名称时显示占位，不把 ID 当名称显示。
// 纯函数：part-time/model.ts 等非 React 模块也引用。
import { m } from './messages.js';

export const EMPLOYMENT_TYPE_FIELD = 'employmentType';
export function employmentTypeLabel(values: Readonly<Record<string, unknown>> | undefined): string {
  const name = values?.employmentTypeName;
  if (typeof name === 'string' && name !== '') return name;
  const id = values?.employmentType;
  return typeof id === 'string' && id !== '' ? m.savedValue : m.missing;
}
