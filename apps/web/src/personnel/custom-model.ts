// F-474-6c：人员自定义字段的纯函数（不含界面）。键约定与任职侧一致：表单里平铺为 custom:<定义 ID>，
// 接口里是 customFields: { <定义 ID>: 值 }（设计 docs/08_设计/F-474-6a §3）。
import type { CustomFieldOption, CustomFieldValueType } from '@italent/domain';
import type { Values } from '../foundation/forms/values.js';
import { longDate } from './model.js';
import { m } from './messages.js';

export interface CustomDefinition {
  id: string;
  name: string;
  valueType: CustomFieldValueType;
  options?: readonly CustomFieldOption[];
}
const prefix = 'custom:';
export const customKey = (id: string) => `${prefix}${id}`;
export const isCustomKey = (key: string) => key.startsWith(prefix);

/** 接口行 → 表单 / 展示用平铺行：被权限裁掉的 customFields 键缺失时，不造出任何 custom:<id>。 */
export function flattenCustom<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const { customFields, ...rest } = row;
  const entries = Object.entries((customFields ?? {}) as Record<string, unknown>);
  return { ...rest, ...Object.fromEntries(entries.map(([id, value]) => [customKey(id), value])) };
}
/** 表单提交体 → 接口体：custom:<id> 收进 customFields，空值发 null（清空）。 */
export function customBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const rest: Values = {};
  const custom: Values = {};
  for (const [key, value] of Object.entries(body as Values))
    if (isCustomKey(key)) custom[key.slice(prefix.length)] = value ?? null;
    else rest[key] = value;
  return Object.keys(custom).length ? { ...rest, customFields: custom } : rest;
}
/** 只读展示：单选显示选项名（含已停用的历史值），日期写年月日，空值统一占位。 */
export function customText(definition: CustomDefinition, value: unknown): string {
  if (value === null || value === undefined || value === '') return m.empty;
  if (definition.valueType === 'select')
    return definition.options?.find((option) => option.value === value)?.label ?? String(value);
  if (definition.valueType === 'boolean') return value === true ? m.yes : m.no;
  if (definition.valueType === 'date' && typeof value === 'string') return longDate(value);
  return String(value);
}
/** 单选下拉的候选：启用项，加上当前已选的停用项（只作沿用，灰显并带后缀）。 */
export function selectOptions(definition: CustomDefinition, selected: unknown) {
  return (definition.options ?? [])
    .filter((option) => option.enabled || option.value === selected)
    .map((option) => ({
      value: option.value,
      disabled: !option.enabled,
      label: option.enabled ? option.label : `${option.label}${m.custom.disabledOption}`,
    }));
}
