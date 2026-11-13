/** F-474-6a §3 / DEC-893：单选及 options 随 6b-0b，组织人员写入口等待 U1。 */
export const CUSTOM_FIELD_OBJECT_TYPES = ['employment', 'contract', 'organization', 'personnel'] as const;
export type CustomFieldObjectType = (typeof CUSTOM_FIELD_OBJECT_TYPES)[number];
export const CUSTOM_FIELD_WRITABLE_OBJECT_TYPES = ['employment', 'contract'] as const;
export const CUSTOM_FIELD_VALUE_TYPES = ['text', 'integer', 'decimal', 'boolean', 'date'] as const;
export type CustomFieldValueType = (typeof CUSTOM_FIELD_VALUE_TYPES)[number];
export const CUSTOM_FIELD_NAME_MAX = 200;
export const CUSTOM_FIELD_LIMIT = 200;
