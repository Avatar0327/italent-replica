import { Alert, Input, InputNumber, Select } from 'antd';
import { useState } from 'react';
import { FormOverlay, TenantDatePicker, type FormField } from '../foundation/index.js';
import { usePageWrite, useRemote, type PageAccess } from '../org/page-support.js';
import { jobBody, type JobKind, type JobRow } from './page-model.js';
import { pageText as m } from './messages.js';

const numbers = new Set(['layerLevel', 'grade', 'level', 'scoreLow', 'scoreHigh', 'displayOrder', 'evaluationScore']);
const references: Record<string, string> = {
  layerId: 'layers',
  levelTypeId: 'level-types',
  minGradeId: 'grades',
  maxGradeId: 'grades',
  minLevelId: 'levels',
  maxLevelId: 'levels',
  sequenceId: 'sequences',
  professionalLineId: 'professional-lines',
  orgId: 'org',
  postId: 'posts',
};
export const jobFields: Record<JobKind, string[]> = {
  layers: ['layerLevel'],
  grades: ['grade', 'scoreLow', 'scoreHigh', 'layerId'],
  'level-types': [],
  levels: ['level', 'levelTypeId', 'minGradeId', 'maxGradeId'],
  sequences: ['parentId', 'levelTypeId', 'source', 'externalId'],
  'professional-lines': ['parentId'],
  posts: [
    'sequenceId',
    'professionalLineId',
    'levelTypeId',
    'minLevelId',
    'maxLevelId',
    'minGradeId',
    'maxGradeId',
    'responsibilities',
    'requirements',
    'evaluationScore',
  ],
  positions: [
    'orgId',
    'postId',
    'sequenceId',
    'professionalLineId',
    'levelTypeId',
    'minLevelId',
    'maxLevelId',
    'minGradeId',
    'maxGradeId',
    'workLocation',
  ],
};
export const label = (field: string) => m[field as keyof typeof m] ?? field;

export function ReferenceSelect({
  kind,
  date,
  value,
  onChange,
  exclude,
}: {
  kind: string;
  date: string;
  value?: string | null;
  onChange?: (value: string | null) => void;
  exclude?: string;
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
      style={{ width: '100%' }}
      value={value}
      onChange={(value) => onChange?.(value ?? null)}
      onSearch={setQuery}
      options={choices}
      loading={remote.loading}
      placeholder={m.candidateHint}
      notFoundContent={remote.error ? m.missing : undefined}
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
  access: PageAccess;
  onClose(): void;
  onSaved(): void;
}) {
  const { kind, original, access, date } = props;
  const write = usePageWrite();
  const fields = ['name', 'code', ...jobFields[kind], 'displayOrder', 'establishedOn', 'stopDate', 'enabled'];
  const groups = [
    {
      title: m.basic,
      fields: fields.map((name): FormField => {
        const target = name === 'parentId' ? kind : references[name];
        const control = target ? (
          <ReferenceSelect kind={target} date={date} exclude={original?.id} />
        ) : numbers.has(name) ? (
          <InputNumber style={{ width: '100%' }} />
        ) : name.endsWith('Date') || name === 'establishedOn' ? (
          <TenantDatePicker />
        ) : name === 'enabled' ? (
          <Select
            options={[
              { value: true, label: m.active },
              { value: false, label: m.inactive },
            ]}
          />
        ) : ['responsibilities', 'requirements'].includes(name) ? (
          <Input.TextArea maxLength={4000} rows={3} />
        ) : (
          <Input maxLength={name === 'code' ? 64 : 200} />
        );
        return {
          name,
          label: label(name),
          control,
          access: access.field(name),
          rules:
            name === 'name' || (!original && ['orgId', 'postId'].includes(name))
              ? [{ required: true, message: m.required }]
              : undefined,
        };
      }),
    },
  ];
  return (
    <FormOverlay
      open
      title={`${original ? m.edit : m.create}${m[kind]}`}
      groups={groups}
      initialValues={original ?? { enabled: true, stopDate: '9999-12-31' }}
      onClose={props.onClose}
      onRefresh={props.onClose}
      onSubmit={async (values) => {
        await write(
          `/api/tenant/job/${kind}${original ? `/${original.id}` : ''}`,
          jobBody(kind, values, original, date),
          original?.revision ?? 0,
          original ? 'PATCH' : 'POST',
        );
        props.onSaved();
      }}
    />
  );
}
export function JobHints({ kind }: { kind: JobKind }) {
  return <Alert type="info" showIcon message={kind === 'posts' || kind === 'positions' ? m.syncHint : m.versionHint} />;
}
