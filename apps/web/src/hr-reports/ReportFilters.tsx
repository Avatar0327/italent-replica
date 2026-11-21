import { Button, Input, Select, Space } from 'antd';
import { useState } from 'react';
import {
  MOVEMENT_CATEGORIES,
  reportCellLabel,
  EMPLOYEE_STATUS_LABELS,
  HR_STRUCTURE_REPORT_EMPLOY_TYPES,
} from '@italent/domain';
import { m } from './messages.js';
import {
  movement,
  rosterFilterColumns,
  rosterFilters,
  validRosterFilters,
  type Column,
  type Filters,
} from './model.js';
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
  if (seen(rosterFilterColumns.name)) fields.push({ key: 'name', label: m.name });
  if (code === '1.06' && seen('number')) fields.push({ key: 'number', label: m.number });
  if (seen(rosterFilterColumns.workDateFrom))
    fields.push(
      { key: 'workDateFrom', label: m.workDateFrom, type: 'date' },
      { key: 'workDateTo', label: m.workDateTo, type: 'date' },
    );
  if (seen(rosterFilterColumns.employeeStatus))
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
function FilterControl({
  field,
  draft,
  busy,
  roster,
  change,
}: {
  field: Field;
  draft: Filters;
  busy: boolean;
  roster: boolean;
  change(value: string): void;
}) {
  const value = draft[field.key] ?? '';
  if (field.options)
    return (
      <Select
        aria-label={field.label}
        value={value}
        disabled={busy}
        options={
          field.key === 'employType'
            ? field.options
            : [{ value: '', label: roster ? m.rosterStatuses : m.all }, ...field.options]
        }
        onChange={change}
      />
    );
  return (
    <Input
      aria-label={field.label}
      type={field.type ?? 'text'}
      value={value}
      disabled={busy}
      maxLength={200}
      {...inputBounds(field, draft)}
      required={['asOf', 'from', 'to', 'year', 'month'].includes(field.key)}
      onChange={(event) => change(event.target.value)}
    />
  );
}

export function ReportFilters({
  code,
  initial,
  columns,
  busy,
  blocked,
  applied,
  apply,
}: {
  code: string;
  initial: Filters;
  columns: Column[];
  busy: boolean;
  blocked?: boolean;
  applied?: Filters;
  apply(filters: Filters): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const [lastColumns, setLastColumns] = useState(columns);
  if (code === 'roster' && lastColumns !== columns) {
    setLastColumns(columns);
    setDraft(rosterFilters(draft, columns));
  }
  const fields = fieldsOf(code, columns);
  return (
    <form
      className="page-filters"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || blocked) return;
        const values = Object.fromEntries(fields.map((f) => [f.key, draft[f.key] ?? '']));
        const bad =
          code === 'roster'
            ? !validRosterFilters(values)
            : (values.from && values.to && values.from > values.to) ||
              (values.workDateFrom && values.workDateTo && values.workDateFrom > values.workDateTo);
        setInvalid(Boolean(bad));
        if (!bad) apply(values);
      }}
    >
      <Space wrap align="end">
        {fields.map((field) => (
          <label key={field.key} className="hr-report-filter">
            <span>{field.label}</span>
            <FilterControl
              field={field}
              draft={draft}
              busy={busy}
              roster={code === 'roster'}
              change={(value) => setDraft({ ...draft, [field.key]: value })}
            />
          </label>
        ))}
        <Button htmlType="submit" type="primary" disabled={busy || blocked}>
          {m.query}
        </Button>
      </Space>
      {invalid && <p role="alert">{m.invalid}</p>}
      {applied && (
        <p>
          {m.applied}{' '}
          {fields
            .filter(({ key }) => applied[key])
            .map(
              ({ key, label, options }) =>
                `${label} ${options?.find((option) => option.value === applied[key])?.label ?? applied[key]}`,
            )
            .join('，')}
        </p>
      )}
    </form>
  );
}
