import { Alert, Input, InputNumber, Select } from 'antd';
import { useState } from 'react';
import { FormOverlay, TenantDatePicker, type FormField } from '../foundation/index.js';
import { usePageWrite, useRemote, type PageAccess } from '../org/page-support.js';
import {
  jobBody,
  jobFormGroups,
  jobInitialValues,
  jobLabel,
  jobPermissionField,
  jobTiming,
  referenceKind,
  type JobKind,
  type JobRow,
} from './page-model.js';
import { pageText as m } from './messages.js';

const numbers = new Set([
  'layerLevel',
  'grade',
  'level',
  'scoreLow',
  'scoreHigh',
  'displayOrder',
  'evaluationScore',
  'adminSequence',
  'dottedSequence',
]);
export function ReferenceSelect({
  kind,
  date,
  value,
  onChange,
  exclude,
  placeholder = m.candidateHint,
}: {
  kind: string;
  date: string;
  value?: string | null;
  onChange?: (value: string | null) => void;
  exclude?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const parameters = new URLSearchParams({
    asOf: date,
    pageSize: '50',
    enabled: 'true',
    ...(query ? { name: query } : {}),
  });
  const base = kind === 'org' ? '/api/tenant/org/organizations' : `/api/tenant/job/${kind}`;
  const remote = useRemote<{ items: JobRow[] }>(`${base}?${parameters}`);
  const choices = (remote.data?.items ?? [])
    .filter((item) => item.id !== exclude)
    .map((item) => ({ value: item.id, label: item.name ?? m.missing }));
  if (value && !choices.some((item) => item.value === value)) choices.push({ value, label: value });
  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      className="r1-wide-control"
      value={value}
      onChange={(value) => onChange?.(value ?? null)}
      onSearch={setQuery}
      options={choices}
      loading={remote.loading}
      aria-label={placeholder}
      placeholder={placeholder}
      notFoundContent={remote.error ? m.candidateFailed : undefined}
      popupRender={(menu) => (
        <>
          {menu}
          {remote.data?.items.length === 50 && <small>{m.candidateMore}</small>}
        </>
      )}
    />
  );
}

export function JobEditor(props: {
  kind: JobKind;
  original?: JobRow;
  date: string;
  today: string;
  access: PageAccess;
  onClose(): void;
  onSaved(): void;
}) {
  const { kind, original, access, date } = props;
  const timing = jobTiming(original, date, props.today, access.field('startDate'));
  const write = usePageWrite();
  const [openKey] = useState(() => crypto.randomUUID());
  const groups = jobFormGroups(kind).map((group) => ({
    title: m[group.key as 'basic'],
    fields: group.fields.map((name): FormField => {
      const control = jobControl(name, kind, timing.asOf, original?.id);
      return {
        name,
        label: jobLabel(kind, name),
        control,
        access: access.field(jobPermissionField(name)),
        rules:
          name === 'name' || (!original && ['orgId', 'postId'].includes(name))
            ? [{ required: true, message: m.required }]
            : undefined,
      };
    }),
  }));
  return (
    <FormOverlay
      mode="modal"
      recordKey={original ? `${original.id}:${original.revision}` : openKey}
      open
      title={original ? m.edit : m.create}
      groups={groups}
      initialValues={jobInitialValues(original)}
      onClose={props.onClose}
      onRefresh={props.onClose}
      onSubmit={async (values) => {
        await write(
          `/api/tenant/job/${kind}${original ? `/${original.id}` : ''}`,
          jobBody(kind, { ...values, ...timing.createFields }, original, timing.asOf),
          original?.revision ?? 0,
          original ? 'PATCH' : 'POST',
        );
        props.onSaved();
      }}
    />
  );
}
export function JobHints({ kind }: { kind: JobKind }) {
  const message = kind === 'posts' || kind === 'positions' ? m.syncHint : m.versionHint;
  return <Alert type="info" showIcon closable message={message} />;
}

function jobControl(name: string, kind: JobKind, date: string, exclude?: string) {
  const target = referenceKind(kind, name);
  if (target) return <ReferenceSelect kind={target} date={date} exclude={exclude} />;
  if (numbers.has(name)) return <InputNumber className="r1-wide-control" />;
  if (name.endsWith('Date') || name === 'establishedOn') return <TenantDatePicker />;
  if (name === 'isKey' || name === 'isConfidential')
    return (
      <Select
        allowClear
        options={[
          { value: true, label: m.yes },
          { value: false, label: m.no },
        ]}
      />
    );
  if (name === 'enabled')
    return (
      <Select
        options={[
          { value: true, label: m.active },
          { value: false, label: m.inactive },
        ]}
      />
    );
  if (['responsibilities', 'requirements'].includes(name)) return <Input.TextArea maxLength={4000} rows={3} />;
  return <Input maxLength={name === 'code' ? 64 : 200} />;
}
