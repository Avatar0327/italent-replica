import { Alert, Input, InputNumber, Select } from 'antd';
import { useState } from 'react';
import { FormOverlay, TenantDatePicker, type FormField } from '../foundation/index.js';
import { usePagePermissions, useRemote, type PageAccess } from '../org/page-support.js';
import { useRecordCommand } from '../org/record-command.js';
import {
  jobBody,
  jobFormGroups,
  jobInitialValues,
  jobLabel,
  jobPermissionField,
  jobTiming,
  referenceKind,
  referenceObject,
  referenceQuery,
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
/** 候选搜索按目标对象的名称查看权裁剪：看不到名称就不能按名称搜（否则可借命中与否推断名称），权限未就绪时也不开搜索。 */
function useNameSearchable(kind: string) {
  const code = referenceObject(kind);
  const permissions = usePagePermissions([code]);
  return !permissions.loading && permissions.access(code).field('name').visible;
}
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
  const searchable = useNameSearchable(kind);
  const base = kind === 'org' ? '/api/tenant/org/organizations' : `/api/tenant/job/${kind}`;
  const remote = useRemote<{ items: JobRow[] }>(`${base}?${referenceQuery(date, query, searchable)}`);
  const choices = (remote.data?.items ?? [])
    .filter((item) => item.id !== exclude)
    .map((item) => ({ value: item.id, label: item.name ?? m.missing }));
  if (value && !choices.some((item) => item.value === value)) choices.push({ value, label: value });
  return (
    <Select
      showSearch={searchable}
      allowClear
      filterOption={false}
      className="r1-wide-control"
      value={value}
      onChange={(value) => onChange?.(value ?? null)}
      onSearch={searchable ? setQuery : undefined}
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

interface EditorProps {
  kind: JobKind;
  original?: JobRow;
  date: string;
  today: string;
  access: PageAccess;
  onClose(): void;
  onSaved(): void;
}
function useJobCommand({ kind, original, date, today, access }: EditorProps) {
  const base = `/api/tenant/job/${kind}`;
  return useRecordCommand({
    // 编辑用原单路径、新建用集合路径作键，不带列表日期（F-123 页面片接入 2）；
    // 槽里存实际采用的业务时点：无生效日期编辑权的新建按租户当天，不是列表日期。
    resource: original ? `${base}/${original.id}` : base,
    context: { date: jobTiming(original, date, today, access.field('startDate')).asOf },
    original,
    readPath: original ? (id, context) => `${base}/${id}?asOf=${context.date}` : undefined,
    project: jobInitialValues,
  });
}
/** 首组顶部提示：槽里有未确认的命令，表单按它保存的业务日期打开。 */
function withResumed<G extends { fields: FormField[] }>([first, ...rest]: G[], date: string): G[] {
  const access = { visible: true, editable: false };
  const notice: FormField = {
    name: '__resumed',
    label: m.resumedLabel,
    display: `${m.resumed}${date}`,
    control: null,
    access,
  };
  return first ? [{ ...first, fields: [notice, ...first.fields] }, ...rest] : rest;
}
export function JobEditor(props: EditorProps) {
  const { kind, original, access } = props;
  const record = useJobCommand(props);
  // 业务时点只从槽里取：提示、候选、重读与请求体都用它，换列表日期不另起命令。
  const { date } = record.context;
  const timing = jobTiming(original, date, date, access.field('startDate'));
  const sections = jobFormGroups(kind).map((group) => ({
    title: m[group.key as 'basic'],
    fields: group.fields.map((name): FormField => {
      const control = jobControl(name, kind, timing.asOf, original?.id);
      return {
        name,
        label: jobLabel(kind, name, 'form'),
        control,
        access: access.field(jobPermissionField(name)),
        rules:
          name === 'name' || (!original && ['orgId', 'postId'].includes(name))
            ? [{ required: true, message: m.required }]
            : undefined,
      };
    }),
  }));
  const groups = record.resumed ? withResumed(sections, date) : sections;
  const build = (body: Record<string, unknown>, current?: JobRow) =>
    jobBody(kind, { ...body, ...timing.createFields }, current, timing.asOf);
  return (
    <FormOverlay
      mode="modal"
      recordKey={original?.id ?? 'new'}
      submission={record.command}
      open
      title={original ? m.edit : m.create}
      groups={groups}
      initialValues={jobInitialValues(original)}
      onClose={() => {
        record.command.clear();
        props.onClose();
      }}
      onSubmit={async (values) => {
        // 必填等本地校验在发命令前抛出，不让内核把它记成结果未知。
        build(values, record.current);
        await record.save(values, {
          path: `/api/tenant/job/${kind}${original ? `/${original.id}` : ''}`,
          method: original ? 'PATCH' : 'POST',
          build,
        });
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
