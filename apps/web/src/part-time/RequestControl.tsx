import { Input, Select } from 'antd';
import { RefSelect } from '../contracts/references.js';
import type { RequestKind } from './request-model.js';
import { refPaths } from './references.js';
import { m } from './messages.js';
import { r } from './request-messages.js';

export function requestFieldLabel(field: string, kind: RequestKind) {
  if (field === 'endDate' && kind === 'extend') return r.fields.newEnd;
  if (field === 'requestRemark' && kind !== 'add')
    return kind === 'extend' ? r.fields.extendRemark : r.fields.endRemark;
  return (r.fields as Record<string, string>)[field] ?? m.fields[field] ?? field;
}

export function RequestControl({
  field,
  label,
  ...props
}: {
  field: string;
  label: string;
  id?: string;
  value?: string | null;
  onChange?(value: string | null): void;
  disabled?: boolean;
}) {
  if (field === 'serviceType')
    return (
      <Select
        {...props}
        aria-label={label}
        options={Object.entries(m.serviceTypes).map(([value, label]) => ({ value, label }))}
      />
    );
  const path = field === 'employeeId' ? '/api/tenant/personnel/employees' : refPaths[field];
  if (path)
    return (
      <RefSelect
        path={path}
        {...props}
        onChange={(value) => props.onChange?.(typeof value === 'string' ? value : null)}
        ariaLabel={label}
      />
    );
  if (['effectiveDate', 'endDate'].includes(field))
    return (
      <Input
        {...props}
        type="date"
        aria-label={label}
        value={props.value ?? ''}
        onChange={(e) => props.onChange?.(e.target.value || null)}
      />
    );
  return (
    <Input.TextArea
      {...props}
      aria-label={label}
      rows={field === 'requestRemark' ? 3 : 1}
      maxLength={field === 'requestRemark' ? 32766 : 2000}
      value={props.value ?? ''}
      onChange={(e) => props.onChange?.(e.target.value || null)}
    />
  );
}
