import { Button, Form, Input, Select } from 'antd';
import { FilterCandidates } from './FilterCandidates.js';
import { m } from './messages.js';
export type ListFilterValues = Record<string, string | string[]>;
export interface ListFilterField {
  name: string;
  label: string;
  options?: { value: string; label: string }[];
  max?: number;
  pattern?: RegExp;
  pageCandidates?: boolean;
  candidates?: string;
}
export function ListFilters({ fields, apply }: { fields: ListFilterField[]; apply(values: ListFilterValues): void }) {
  const [form] = Form.useForm();
  return (
    <Form
      form={form}
      layout="inline"
      className="settings-list-filters"
      onFinish={(values) => {
        const result: ListFilterValues = {};
        for (const field of fields) {
          const raw = values[field.name];
          if (field.candidates) {
            const ids = (raw ?? []).map((item: { value: string }) => item.value);
            if (ids.length) result[field.name] = ids;
            continue;
          }
          const value = String((field.options ? raw?.value : raw) ?? '').trim();
          if (value) result[field.name] = value;
        }
        apply(result);
      }}
    >
      {fields.map((field) => (
        <Form.Item
          key={field.name}
          name={field.name}
          label={field.label}
          tooltip={field.pageCandidates ? m.pageCandidates : undefined}
          rules={field.pattern ? [{ pattern: field.pattern, message: m.invalid }] : []}
        >
          {filterControl(field)}
        </Form.Item>
      ))}
      <Button htmlType="submit" type="primary">
        {m.filter}
      </Button>
      <Button
        onClick={() => {
          form.resetFields();
          apply({});
        }}
      >
        {m.clear}
      </Button>
    </Form>
  );
}

function filterControl(field: ListFilterField) {
  if (field.candidates) return <FilterCandidates resource={field.candidates} label={field.label} />;
  if (field.options)
    return (
      <Select
        aria-label={field.label}
        allowClear
        labelInValue
        options={field.options}
        showSearch
        optionFilterProp="label"
        notFoundContent={m.noMatch}
      />
    );
  return <Input aria-label={field.label} maxLength={field.max ?? 100} />;
}
