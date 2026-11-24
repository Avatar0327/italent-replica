import { Button, Input, Select, Space } from 'antd';
import { useState, type ReactNode } from 'react';
import {
  MOVEMENT_CATEGORIES,
  reportCellLabel,
  EMPLOYEE_STATUS_LABELS,
  HR_STRUCTURE_REPORT_EMPLOY_TYPES,
} from '@italent/domain';
import { m } from './messages.js';
import { DepartmentFilter, useReportDepartment, type DepartmentContext } from './DepartmentFilter.js';
import {
  movement,
  movementMonthLimit,
  rosterFilterColumns,
  rosterFilters,
  structureReport,
  validMovementFilters,
  validRosterFilters,
  validStructureFilters,
  type Column,
  type Filters,
} from './model.js';
export interface QueryField {
  key: string;
  label: string;
  type?: string;
  bounds?: { min: string; max: string };
  options?: { value: string; label: string }[];
  control?(value: string, busy: boolean, change: (value: string) => void): ReactNode;
  appliedText?(value: string, filters: Filters): string | undefined;
}
function fieldsOf(code: string, columns: Column[]): QueryField[] {
  const seen = (key: string) => columns.some((c) => c.key === key);
  const fields: QueryField[] = [];
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
  if (structureReport(code))
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
function inputBounds(field: QueryField, draft: Filters) {
  if (field.bounds) return field.bounds;
  if (field.type === 'date') return { min: '0001-01-01', max: '9999-12-31' };
  if (field.key === 'year') return { min: 1900, max: Number(draft.asOf?.slice(0, 4)) || 9999 };
  if (field.key === 'month') return { min: 1, max: movementMonthLimit(draft) };
  return {};
}
function FilterControl({
  field,
  draft,
  busy,
  roster,
  change,
}: {
  field: QueryField;
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
      placeholder={field.key === 'month' ? String(movementMonthLimit(draft)) : undefined}
      required={['asOf', 'from', 'to'].includes(field.key)}
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
  departments,
  apply,
}: {
  code: string;
  initial: Filters;
  columns: Column[];
  busy: boolean;
  blocked?: boolean;
  applied?: Filters;
  departments?: DepartmentContext;
  apply(filters: Filters): void;
}) {
  const roster = code === 'roster';
  const validateDepartment = departments ? validStructureFilters : undefined;
  return (
    <QueryFilters
      fields={fieldsOf(code, columns)}
      initial={initial}
      busy={busy}
      submitDisabled={blocked}
      rosterColumns={roster ? columns : undefined}
      validate={movement(code) ? validMovementFilters : validateDepartment}
      applied={applied}
      departments={departments}
      apply={apply}
    />
  );
}

export function AppliedFilters({
  fields,
  applied,
  showDepartment,
}: {
  fields: readonly QueryField[];
  applied: Filters;
  showDepartment: boolean;
}) {
  const captions = fields.flatMap(({ key, label, options, appliedText }) => {
    const value = applied[key] ?? '';
    if (!value) return [];
    const text = appliedText
      ? appliedText(value, applied)
      : `${label} ${options?.find((option) => option.value === value)?.label ?? value}`;
    return text ? [text] : [];
  });
  if (showDepartment && applied.departmentId) {
    captions.push(
      `${m.department} ${applied.departmentLabel || applied.departmentId}`,
      `${m.includeChildren} ${applied.departmentIncludeChildren === 'false' ? m.no : m.yes}`,
    );
  }
  return (
    <p>
      {m.applied} {captions.join('，')}
    </p>
  );
}

function FilterField({ field, draft, busy, roster, change }: Parameters<typeof FilterControl>[0]) {
  if (field.control) {
    return (
      <div className="hr-report-filter">
        {field.label && <span>{field.label}</span>}
        {field.control(draft[field.key] ?? '', busy, change)}
      </div>
    );
  }
  return (
    <label className="hr-report-filter">
      <span>{field.label}</span>
      <FilterControl field={field} draft={draft} busy={busy} roster={roster} change={change} />
    </label>
  );
}

export function QueryFilters({
  fields,
  initial,
  busy,
  submitDisabled,
  validate,
  rosterColumns,
  applied,
  departments,
  apply,
}: {
  fields: readonly QueryField[];
  initial: Filters;
  busy: boolean;
  submitDisabled?: boolean;
  validate?(filters: Filters): boolean;
  rosterColumns?: readonly Column[];
  applied?: Filters;
  departments?: DepartmentContext;
  apply(filters: Filters): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const [lastColumns, setLastColumns] = useState(rosterColumns);
  const { candidates, filters: departmentFilters } = useReportDepartment(draft, departments);
  if (rosterColumns && lastColumns !== rosterColumns) {
    setLastColumns(rosterColumns);
    setDraft(rosterFilters(draft, rosterColumns));
  }
  return (
    <form
      className="page-filters"
      noValidate={Boolean(validate)}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || submitDisabled) return;
        const values: Filters = {
          ...Object.fromEntries(fields.map((f) => [f.key, draft[f.key] ?? ''])),
          ...(departments ? departmentFilters : {}),
        };
        const bad = rosterColumns
          ? !validRosterFilters(values)
          : (validate && !validate(values)) ||
            (values.from && values.to && values.from > values.to) ||
            (values.workDateFrom && values.workDateTo && values.workDateFrom > values.workDateTo);
        setInvalid(Boolean(bad));
        if (!bad) apply(values);
      }}
    >
      <Space wrap align="end">
        {fields.map((field) => (
          <FilterField
            key={field.key}
            field={field}
            draft={draft}
            busy={busy}
            roster={Boolean(rosterColumns)}
            change={(value) => setDraft({ ...draft, [field.key]: value })}
          />
        ))}
        {departments && (
          <DepartmentFilter
            candidates={candidates}
            filters={departments.allowed ? departmentFilters : {}}
            busy={busy}
            includeChildrenToggle={departments.object === 'HrStructureReport'}
            change={(changes) => setDraft((value) => ({ ...value, ...changes }))}
          />
        )}
        <Button htmlType="submit" type="primary" disabled={busy || submitDisabled}>
          {m.query}
        </Button>
      </Space>
      {invalid && <p role="alert">{m.invalid}</p>}
      {applied && <AppliedFilters fields={fields} applied={applied} showDepartment={Boolean(departments)} />}
    </form>
  );
}
