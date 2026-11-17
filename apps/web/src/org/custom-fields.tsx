import { Input, InputNumber, Select } from 'antd';
import { CUSTOM_FIELD_VALUE_TYPES, type CustomFieldOption, type CustomFieldValueType } from '@italent/domain';
import { TenantDatePicker, type FormField, type FormGroup } from '../foundation/index.js';
import { customFieldsNoticeField, useCustomFieldsNotice } from '../shared/CustomFieldsNotice.js';
import { customKey, orgCustomValue, type OrgRow } from './page-model.js';
import { useRemote, type PageAccess } from './page-support.js';
import { customText } from './messages.js';

export interface OrgCustomDefinition {
  id: string;
  name: string;
  valueType: CustomFieldValueType;
  options?: readonly CustomFieldOption[];
}
/**
 * 业务侧只读目录（普通组织用户没有配置管理能力，读配置接口会 403）：服务端已按 custom:<id> 查看权裁剪，最小字段。
 * 没有任何自定义字段查看权时不请求。
 */
const DEFINITIONS = '/api/tenant/org/custom-field-definitions';

/**
 * 租户定义 × 查看人的 custom:<id> 查看权：只返回有查看权的字段；定义读取失败时按无字段处理，不影响组织页本身
 * （fail-closed，docs/08_设计/F-474-6a §5）；新建 / 变更弹窗的“其他信息”分组另给提示行与重试（F-527）。
 */
export function useOrgCustomFields(access: PageAccess) {
  const keys = access.customKeys;
  const result = useRemote<{ items: OrgCustomDefinition[] }>(keys.length ? DEFINITIONS : null);
  const notice = useCustomFieldsNotice(keys.length > 0, result);
  const definitions = (result.data?.items ?? []).filter(
    (field) => keys.includes(customKey(field.id)) && field.name && CUSTOM_FIELD_VALUE_TYPES.includes(field.valueType),
  );
  return {
    definitions,
    keys: definitions.map((field) => customKey(field.id)),
    labels: Object.fromEntries(definitions.map((field) => [customKey(field.id), field.name])),
    notice,
  };
}
export type OrgCustomFields = ReturnType<typeof useOrgCustomFields>;

/** 按值类型的控件：停用的下拉选项只在已选时出现并带灰色标记（设计 §5）。 */
function control(field: OrgCustomDefinition, selected: unknown) {
  switch (field.valueType) {
    case 'select':
      return (
        <Select
          aria-label={field.name}
          allowClear
          options={(field.options ?? [])
            .filter((option) => option.enabled || option.value === selected)
            .map((option) => ({
              value: option.value,
              disabled: !option.enabled,
              label: option.enabled ? option.label : `${option.label}${customText.disabledOption}`,
            }))}
        />
      );
    case 'boolean':
      return (
        <Select
          aria-label={field.name}
          allowClear
          options={[
            { value: true, label: customText.yes },
            { value: false, label: customText.no },
          ]}
        />
      );
    case 'integer':
    case 'decimal':
      return <InputNumber aria-label={field.name} precision={field.valueType === 'integer' ? 0 : undefined} />;
    case 'date':
      return <TenantDatePicker />;
    default:
      return <Input aria-label={field.name} maxLength={2000} />;
  }
}
/** 表单分组「其他信息」的字段：权限、只读展示都走 FormOverlay 的 access（无查看权的字段不在 definitions 里，不会渲染）。 */
export function customFormFields(custom: OrgCustomFields, access: PageAccess, original?: OrgRow): FormField[] {
  return custom.definitions.map((field) => {
    const name = customKey(field.id);
    return {
      name,
      label: field.name,
      control: control(field, original ? orgCustomValue(original, field.id) : undefined),
      access: access.field(name),
      display: customDisplay(field, original ? orgCustomValue(original, field.id) : undefined),
    };
  });
}
/** 弹窗「其他信息」分组：放字段，定义读取失败 / 重试中再放一行提示（F-527）；两者都没有时不建分组。 */
export function customFormGroups(custom: OrgCustomFields, fields: FormField[]): FormGroup[] {
  const all = [...fields, ...customFieldsNoticeField(custom.notice)];
  return all.length ? [{ title: customText.group, fields: all }] : [];
}
/** 详情 / 列表 / 只读行的取值显示：下拉显示选项名称，布尔显示是 / 否，空值 `--`。 */
export function customDisplay(field: Pick<OrgCustomDefinition, 'valueType' | 'options'>, value: unknown) {
  if (value === undefined || value === null || value === '') return customText.missing;
  if (field.valueType === 'select')
    return field.options?.find((option) => option.value === value)?.label ?? String(value);
  if (field.valueType === 'boolean') return value ? customText.yes : customText.no;
  return String(value);
}
