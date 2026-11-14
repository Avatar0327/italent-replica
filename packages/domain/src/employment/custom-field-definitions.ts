/** F-474-6a §3 / DEC-896：四对象共用定义管理权限，选项编码稳定保留。 */
export const CUSTOM_FIELD_OBJECT_TYPES = ['employment', 'contract', 'organization', 'personnel'] as const;
export type CustomFieldObjectType = (typeof CUSTOM_FIELD_OBJECT_TYPES)[number];
export const CUSTOM_FIELD_WRITABLE_OBJECT_TYPES = CUSTOM_FIELD_OBJECT_TYPES;
export const CUSTOM_FIELD_VALUE_TYPES = ['text', 'integer', 'decimal', 'boolean', 'date', 'select'] as const;
export type CustomFieldValueType = (typeof CUSTOM_FIELD_VALUE_TYPES)[number];
export const CUSTOM_FIELD_NAME_MAX = 200;
export const CUSTOM_FIELD_LIMIT = 200;
export const CUSTOM_FIELD_OPTION_LIMIT = 50;
export interface CustomFieldOption {
  readonly value: string;
  readonly label: string;
  readonly enabled: boolean;
}

export function isCustomFieldOptions(value: unknown): value is CustomFieldOption[] {
  if (!Array.isArray(value) || !value.length || value.length > CUSTOM_FIELD_OPTION_LIMIT) return false;
  const valid = value.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const option = item as Record<string, unknown>;
    return (
      Object.keys(option).length === 3 &&
      typeof option.value === 'string' &&
      !!option.value.trim() &&
      typeof option.label === 'string' &&
      !!option.label.trim() &&
      typeof option.enabled === 'boolean'
    );
  });
  return valid && new Set(value.map((item: CustomFieldOption) => item.value)).size === value.length;
}
