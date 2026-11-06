import { Button, Input, Select, Space } from 'antd';
import { useState } from 'react';
import {
  MOVEMENT_CATEGORIES,
  reportCellLabel,
  EMPLOYEE_STATUS_LABELS,
  HR_STRUCTURE_REPORT_EMPLOY_TYPES,
} from '@italent/domain';
import { m } from './messages.js';
import { movement, type Column, type Filters } from './model.js';
interface Field {
  key: string;
  label: string;
  type?: string;
  options?: { value: string; label: string }[];
}
function fieldsOf(code: string, columns: Column[]): Field[] {
  const seen = (key: string) => columns.some((c) => c.key === key);
  const fields: Field[] = [];
  if (!['1.07', '1.1.01', '1.1.02'].includes(code)) fields.push({ key: 'asOf', label: m.asOf, type: 'date' });
  if (code === '1.07') {
    fields.push({ key: 'from', label: m.from, type: 'date' }, { key: 'to', label: m.to, type: 'date' });
    if (seen('category'))
      fields.push({
        key: 'category',
        label: m.category,
        options: MOVEMENT_CATEGORIES.map((value) => ({ value, label: reportCellLabel('category', value)! })),
      });
  }
  if (movement(code)) {
    fields.push({ key: 'year', label: m.year, type: 'number' });
    if (code === 'institution') fields.push({ key: 'month', label: m.month, type: 'number' });
  }
  if (code === 'quality')
    fields.push({
      key: 'employType',
      label: m.employType,
      options: HR_STRUCTURE_REPORT_EMPLOY_TYPES.map((value) => ({
        value,
        label: value === 'all' ? m.all : reportCellLabel('employType', value)!,
      })),
    });
  if (seen('employeeName')) fields.push({ key: 'name', label: m.name });
  if (code === '1.06' && seen('number')) fields.push({ key: 'number', label: m.number });
  if (seen('workDate'))
    fields.push(
      { key: 'workDateFrom', label: m.workDateFrom, type: 'date' },
      { key: 'workDateTo', label: m.workDateTo, type: 'date' },
    );
  if (seen('employeeStatus'))
    fields.push({
      key: 'employeeStatus',
      label: m.employeeStatus,
      options: (code === '1.1.01' ? ([2, 3, 6, 8] as const) : ([2, 3] as const)).map((value) => ({
        value: String(value),
        label: EMPLOYEE_STATUS_LABELS[value],
      })),
    });
  return fields;
}
function inputBounds(field: Field, draft: Filters) {
  if (field.type === 'date') return { min: '0001-01-01', max: '9999-12-31' };
  if (field.key === 'year') return { min: 1900, max: Number(draft.asOf?.slice(0, 4)) || 9999 };
  if (field.key === 'month') return { min: 1, max: 12 };
  return {};
}
export function ReportFilters({
  code,
  initial,
  columns,
  busy,
  apply,
}: {
  code: string;
  initial: Filters;
  columns: Column[];
  busy: boolean;
  apply(filters: Filters): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const fields = fieldsOf(code, columns);
  return (
    <form
      className="page-filters"
      onSubmit={(event) => {
        event.preventDefault();
        const values = Object.fromEntries(fields.map((f) => [f.key, draft[f.key] ?? '']));
        const bad =
          (values.from && values.to && values.from > values.to) ||
          (values.workDateFrom && values.workDateTo && values.workDateFrom > values.workDateTo);
        setInvalid(Boolean(bad));
        if (!bad) apply(values);
      }}
    >
      <Space wrap align="end">
        {fields.map((field) => (
          <label key={field.key} className="hr-report-filter">
            <span>{field.label}</span>
            {field.options ? (
              <Select
                aria-label={field.label}
                value={draft[field.key] || ''}
                disabled={busy}
                options={[...(field.key === 'employType' ? [] : [{ value: '', label: m.all }]), ...field.options]}
                onChange={(value) => setDraft({ ...draft, [field.key]: value })}
              />
            ) : (
              <Input
                aria-label={field.label}
                type={field.type ?? 'text'}
                value={draft[field.key] ?? ''}
                disabled={busy}
                maxLength={200}
                {...inputBounds(field, draft)}
                required={['asOf', 'from', 'to', 'year', 'month'].includes(field.key)}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              />
            )}
          </label>
        ))}
        <Button htmlType="submit" type="primary" disabled={busy}>
          {m.query}
        </Button>
      </Space>
      {invalid && <p role="alert">{m.invalid}</p>}
    </form>
  );
}
