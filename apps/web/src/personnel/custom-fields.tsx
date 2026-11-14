// F-474-6c：人员自定义字段的读取与控件。只消费租户定义与 custom:<id> 字段权限，不内置任何字段。
import { Input, InputNumber, Select, Switch } from 'antd';
import type { ReactNode } from 'react';
import { CUSTOM_FIELD_VALUE_TYPES, PERSONNEL_OBJECT } from '@italent/domain';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { customKey, isCustomKey, selectOptions, type CustomDefinition } from './custom-model.js';
import { useRead } from './useRead.js';

// 业务侧只读目录（普通人员 HR 没有配置管理能力，读配置接口会 403）：已按 custom:<id> 查看权裁剪，最小字段。
const definitionsPath = '/api/tenant/personnel/custom-field-definitions';

/** 无任何 custom:* 查看权时不请求定义目录；有权限的定义才进入返回值，列表与档案共用。 */
export function usePersonnelCustomFields() {
  const permission = usePermissions(PERSONNEL_OBJECT).snapshot.objects[PERSONNEL_OBJECT];
  const visible = permission?.viewableFields.filter(isCustomKey) ?? [];
  const result = useRead<{ items: CustomDefinition[] }>(visible.length ? definitionsPath : null);
  const definitions = (result.data?.items ?? []).filter(
    (field) =>
      visible.includes(customKey(field.id)) && field.name && CUSTOM_FIELD_VALUE_TYPES.includes(field.valueType),
  );
  return {
    definitions,
    keys: definitions.map((field) => customKey(field.id)),
    labels: Object.fromEntries(definitions.map((field) => [customKey(field.id), field.name])),
    byKey: Object.fromEntries(definitions.map((field) => [customKey(field.id), field])),
    loading: visible.length > 0 && result.loading,
    error: result.error,
  };
}

/** 编辑控件：文本 ≤2000、整数 / 小数输入框、布尔开关、日期选择、单选下拉。 */
export function customControl(definition: CustomDefinition, selected: unknown): ReactNode {
  const aria = definition.name;
  switch (definition.valueType) {
    case 'select':
      return <Select aria-label={aria} allowClear options={selectOptions(definition, selected)} />;
    case 'boolean':
      return <Switch aria-label={aria} />;
    case 'integer':
      return <InputNumber aria-label={aria} precision={0} />;
    case 'decimal':
      return <InputNumber aria-label={aria} />;
    case 'date':
      return <TenantDatePicker />;
    default:
      return <Input aria-label={aria} maxLength={2000} />;
  }
}
