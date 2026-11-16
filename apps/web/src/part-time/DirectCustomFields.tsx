import { Form, Input, InputNumber, Select } from 'antd';
import { CUSTOM_FIELD_VALUE_TYPES, type CustomFieldValueType, type CustomFieldOption } from '@italent/domain';
import { TenantDatePicker } from '../foundation/selectors.js';
import { LockedField } from '../foundation/forms/FormLock.js';
import type { Values } from '../foundation/forms/values.js';
import type { useDirectAccess } from './direct-commands.js';
import { apiRoot, object, value } from './model.js';
import { useRead } from './useRead.js';
import { d } from './direct-messages.js';
import { useCustomFieldsNotice } from '../shared/CustomFieldsNotice.js';
interface Definition {
  id: string;
  name: string;
  valueType: CustomFieldValueType;
  options?: readonly CustomFieldOption[];
  /** 业务侧目录按当前身份的 custom:<id> 编辑权给出；控件是否可改仍以权限快照为准（同 6c 先例）。 */
  editable?: boolean;
}
// F-523：业务侧只读目录，准入为任职对象查看权（普通 HR 没有配置权，读配置接口会 403）；
// 服务端已按 custom:<id> 查看权裁剪，不分页。
const definitionsPath = `${apiRoot}/custom-field-definitions`;
/** §1.6：只消费租户定义与 custom:id 权限，不内置“占人头”的字段或默认值。 */
export function useDirectCustomFields(access: ReturnType<typeof useDirectAccess>) {
  const visible = access.p.snapshot.objects[object]?.viewableFields.filter((key) => key.startsWith('custom:')) ?? [];
  // 无字段查看权时不请求定义目录；返回后仍按快照的 custom:<id> 查看权再裁一遍（同 6b / 6c）。
  const result = useRead<{ items: Definition[] }>(visible.length ? definitionsPath : null);
  const notice = useCustomFieldsNotice(visible.length > 0, result);
  const definitions = (result.data?.items ?? []).filter(
    (field) =>
      visible.includes(`custom:${field.id}`) && field.name && CUSTOM_FIELD_VALUE_TYPES.includes(field.valueType),
  );
  return {
    definitions,
    keys: definitions.map((field) => `custom:${field.id}`),
    labels: Object.fromEntries(definitions.map((field) => [`custom:${field.id}`, field.name])),
    // 首次读取中短暂锁定，避免定义未到就提交；读取失败照 6b（org/custom-fields.tsx）按无字段处理、不挡表单
    // （docs/08_设计/F-474-6a §5），自定义字段区给提示行与重试；点重试后的重新读取同样不挡表单（F-527）。
    blocked: visible.length > 0 && result.loading && notice.status !== 'retrying',
    notice,
  };
}
export function DirectCustomField({
  field,
  access,
  create,
  baseline,
}: {
  field: Definition;
  access: ReturnType<typeof useDirectAccess>;
  create: boolean;
  baseline: Values;
}) {
  const name = `custom:${field.id}`;
  if (!access.field(name, create).editable)
    return (
      <Form.Item label={field.name}>
        <span>{field.options?.find((option) => option.value === baseline[name])?.label ?? value(baseline[name])}</span>
      </Form.Item>
    );
  let control;
  switch (field.valueType) {
    case 'select':
      control = (
        <Select
          aria-label={field.name}
          allowClear
          options={(field.options ?? [])
            .filter((option) => option.enabled || option.value === baseline[name])
            .map((option) => ({
              value: option.value,
              disabled: !option.enabled,
              label: option.enabled ? option.label : `${option.label}${d.disabledOption}`,
            }))}
        />
      );
      break;
    case 'boolean':
      control = (
        <Select
          aria-label={field.name}
          allowClear
          options={[
            { value: true, label: d.yes },
            { value: false, label: d.no },
          ]}
        />
      );
      break;
    case 'integer':
    case 'decimal':
      control = <InputNumber aria-label={field.name} precision={field.valueType === 'integer' ? 0 : undefined} />;
      break;
    case 'date':
      control = <TenantDatePicker />;
      break;
    default:
      control = <Input aria-label={field.name} />;
  }
  return (
    <Form.Item name={name} label={field.name}>
      <LockedField>{control}</LockedField>
    </Form.Item>
  );
}
