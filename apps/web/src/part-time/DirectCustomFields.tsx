import { Form, Input, InputNumber, Select } from 'antd';
import { TenantDatePicker } from '../foundation/selectors.js';
import { LockedField } from '../foundation/forms/FormLock.js';
import { PageState } from '../foundation/PageState.js';
import type { Values } from '../foundation/forms/values.js';
import type { useDirectAccess } from './direct-commands.js';
import { apiRoot, object, value } from './model.js';
import { useRead } from './useRead.js';
import { d } from './direct-messages.js';
interface Definition {
  id: string;
  name: string;
  valueType: 'text' | 'integer' | 'decimal' | 'boolean' | 'date';
}
/** §1.6：只消费租户定义与 custom:id 权限，不内置“占人头”的字段或默认值。 */
export function useDirectCustomFields(access: ReturnType<typeof useDirectAccess>) {
  const visible = access.p.snapshot.objects[object]?.viewableFields.filter((key) => key.startsWith('custom:')) ?? [];
  // 服务端任职自定义字段上限 200；无字段查看权时不请求配置目录。
  const result = useRead<{ items: Definition[] }>(
    visible.length ? `${apiRoot}/custom-fields?objectType=employment&page=1&pageSize=200` : null,
  );
  const definitions = (result.data?.items ?? []).filter(
    (field) =>
      visible.includes(`custom:${field.id}`) &&
      field.name &&
      ['text', 'integer', 'decimal', 'boolean', 'date'].includes(field.valueType),
  );
  return {
    definitions,
    keys: definitions.map((field) => `custom:${field.id}`),
    labels: Object.fromEntries(definitions.map((field) => [`custom:${field.id}`, field.name])),
    blocked: visible.length > 0 && (result.loading || !!result.error),
    node: result.error ? <PageState kind="error" error={result.error} retry={result.refresh} /> : null,
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
        <span>{value(baseline[name])}</span>
      </Form.Item>
    );
  let control;
  switch (field.valueType) {
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
