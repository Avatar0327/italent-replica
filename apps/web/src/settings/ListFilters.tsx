import { Button, Form, Input, Select, TreeSelect, type TreeSelectProps } from 'antd';
import { m } from './messages.js';
export interface ListFilterField {
  name: string;
  label: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
  treeData?: TreeSelectProps['treeData'];
  loading?: boolean;
  max?: number;
  pattern?: RegExp;
  pageCandidates?: boolean;
}
export function ListFilters({
  fields,
  apply,
}: {
  fields: ListFilterField[];
  apply(values: Record<string, string>): void;
}) {
  const [form] = Form.useForm();
  return (
    <Form
      form={form}
      layout="inline"
      className="settings-list-filters"
      onFinish={(values) => {
        const result: Record<string, string> = {};
        for (const field of fields) {
          const raw = values[field.name];
          const value = String((field.options ? raw?.value : raw) ?? field.defaultValue ?? '').trim();
          if (value) result[field.name] = value;
        }
        apply(result);
      }}
    >
      {fields.map((field) => (
        <Form.Item
          key={field.name}
          name={field.name}
          initialValue={field.defaultValue ? { value: field.defaultValue } : undefined}
          label={field.label}
          tooltip={field.pageCandidates ? m.pageCandidates : undefined}
          rules={field.pattern ? [{ pattern: field.pattern, message: m.invalid }] : []}
        >
          {field.treeData ? (
            <TreeSelect
              aria-label={field.label}
              treeData={field.treeData}
              loading={field.loading}
              allowClear
              showSearch
              treeNodeFilterProp="title"
              notFoundContent={m.noMatch}
            />
          ) : field.options ? (
            <Select
              aria-label={field.label}
              allowClear
              labelInValue
              options={field.options}
              showSearch
              optionFilterProp="label"
              notFoundContent={m.noMatch}
            />
          ) : (
            <Input aria-label={field.label} maxLength={field.max ?? 100} />
          )}
        </Form.Item>
      ))}
      <Button htmlType="submit" type="primary">
        {m.filter}
      </Button>
      <Button
        onClick={() => {
          form.resetFields();
          apply(
            Object.fromEntries(
              fields.filter((field) => field.defaultValue).map((field) => [field.name, field.defaultValue!]),
            ),
          );
        }}
      >
        {m.clear}
      </Button>
    </Form>
  );
}
