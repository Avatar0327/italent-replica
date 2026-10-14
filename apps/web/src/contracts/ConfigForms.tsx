// F-127b A15～A17：合同类型、续签规则、合同设置的编辑与规则删除，统一走 F-123 内核。
import { Alert, Button, Input, InputNumber, Popconfirm, Select, Space, Switch } from 'antd';
import { useState } from 'react';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useFormLock } from '../foundation/forms/FormLock.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import type { Values } from '../foundation/forms/store.js';
import { parseSavedReceipt, parseSettingsReceipt } from './forms.js';
import { m } from './messages.js';
import { configObjects, value, type Config, type Row } from './model.js';
import { PeopleSelect, RefLabels, RefSelect, refPaths } from './references.js';

const base = '/api/tenant/contracts';
const paths = { types: `${base}/master-data/types`, rules: `${base}/rules`, settings: `${base}/settings` };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const configFields: Record<Config, string[]> = {
  types: ['code', 'name', 'enabled'],
  rules: ['name', 'priority', 'enabled', 'orgIds', 'personIds', 'details'],
  settings: [
    'autoRenew',
    'autoTerminate',
    'postExitTypeIds',
    'indefiniteTypeIds',
    'accumulateRehire',
    'renewalTypeIds',
    'autoNumber',
    'uniqueFields',
  ],
};
const defaults: Record<Config, Row> = {
  types: { code: null, name: null, enabled: true },
  rules: { name: null, priority: 0, enabled: true, orgIds: [], personIds: [], details: [] },
  settings: {},
};
const pick = (row: Row | undefined, keys: string[], fallback: Row) =>
  Object.fromEntries(keys.map((key) => [key, row?.[key] ?? fallback[key] ?? null]));

/** 新建 / 编辑：类型与规则 PUT 需完整请求体（configuration.ts），设置按差异提交。 */
export function ConfigForm({
  kind,
  row,
  tenantId,
  onClose,
  onSaved,
}: {
  kind: Config;
  row?: Row;
  tenantId?: string;
  onClose(): void;
  onSaved(): void;
}) {
  const api = useApiClient();
  const permission = usePermissions(configObjects[kind]);
  const id = kind === 'settings' ? tenantId : typeof row?.id === 'string' ? row.id : undefined;
  const resource = kind === 'settings' ? paths.settings : `${paths[kind]}/${id ?? 'new'}`;
  const submission = useCommandForm(resource);
  const keys = configFields[kind];
  const baseline = pick(row, keys, defaults[kind]);
  const revision = Number(row?.revision ?? 0);
  const fields = keys.map((name) => configField(kind, name, permission.field(name), baseline[name]));
  const editable = fields.filter((field) => field.access.visible && field.access.editable).map((field) => field.name);
  const read = async () => {
    const latest =
      kind === 'settings'
        ? await api.request<Row>(paths.settings)
        : (await api.request<{ items: Row[] }>(`${paths[kind]}?page=1&pageSize=200`)).items.find((r) => r.id === id);
    if (!latest) throw new Error(kernel.invalidReceipt);
    return {
      id: String(kind === 'settings' ? latest.tenantId : latest.id),
      revision: Number(latest.revision),
      values: pick(latest, keys, {}),
    };
  };
  return (
    <FormOverlay
      open
      recordKey={resource}
      submission={{ ...submission, reload: id ? () => submission.reread(read) : undefined }}
      title={`${row || kind === 'settings' ? m.edit : m.create}${kind === 'settings' ? m.settings : m[kind]}`}
      groups={[{ title: m[kind], fields }]}
      initialValues={baseline}
      onClose={onClose}
      onRefresh={onSaved}
      onSubmit={async (values) => {
        const result = await submission.submit({
          values,
          baseline,
          editableFields: editable,
          revision,
          businessId: id,
          patchOnly: kind === 'settings',
          send: async (command) => {
            const method = kind === 'settings' || id ? 'PUT' : 'POST';
            const path = kind === 'settings' || !id ? paths[kind] : `${paths[kind]}/${encodeURIComponent(id)}`;
            const raw = await api.request<unknown>(path, { method, command });
            return kind === 'settings'
              ? parseSettingsReceipt(raw, { tenantId: id ?? '', revision })
              : parseSavedReceipt(raw, { id, revision });
          },
        });
        if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
        submission.clear();
        onSaved();
      }}
    />
  );
}

function configField(
  kind: Config,
  name: string,
  access: { visible: boolean; editable: boolean },
  current: unknown,
): FormField {
  const label =
    ({ name: kind === 'types' ? m.typeName : m.ruleName, code: m.typeCode } as Record<string, string>)[name] ??
    m.fields[name] ??
    name;
  const typeList = ['postExitTypeIds', 'indefiniteTypeIds', 'renewalTypeIds'].includes(name);
  const required = (check: (input: unknown) => boolean, text = m.required) => [
    {
      validator: async (_: unknown, input: unknown) => {
        if (!check(input)) throw new Error(text);
      },
    },
  ];
  const filled = (input: unknown) => typeof input === 'string' && input.trim().length > 0;
  const field: FormField = {
    name,
    label,
    access,
    control: <Input maxLength={name === 'code' ? 100 : 200} />,
    display: value(current, name),
  };
  if (name === 'code' || name === 'name') return { ...field, rules: required(filled) };
  if (['enabled', 'autoRenew', 'autoTerminate', 'autoNumber', 'accumulateRehire'].includes(name))
    return { ...field, control: <Toggle label={label} /> };
  if (name === 'priority')
    return {
      ...field,
      control: <InputNumber min={0} precision={0} />,
      rules: required((input) => Number.isInteger(input) && Number(input) >= 0),
    };
  if (name === 'orgIds') return { ...field, control: <RefSelect path={refPaths.orgId} multiple ariaLabel={label} /> };
  if (name === 'personIds') return { ...field, control: <PeopleSelect /> };
  if (typeList)
    return {
      ...field,
      control: <RefSelect path={refPaths.typeId} multiple ariaLabel={label} />,
      display: <RefLabels path={refPaths.typeId} ids={current} />,
    };
  if (name === 'uniqueFields')
    return {
      ...field,
      control: (
        <Select
          mode="multiple"
          aria-label={label}
          options={['number', 'employeeId', 'typeId', 'effectiveDate'].map((key) => ({
            value: key,
            label: m.fields[key],
          }))}
        />
      ),
      rules: required((input) => Array.isArray(input) && input.length >= 1 && input.length <= 4),
    };
  return { ...field, control: <RuleDetails />, rules: required(validDetails, m.detailsInvalid) };
}
function Toggle({
  value,
  onChange,
  disabled,
  label,
}: {
  value?: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return <Switch aria-label={label} checked={!!value} disabled={disabled} onChange={(next) => onChange?.(next)} />;
}

type Detail = {
  typeId?: string | null;
  months?: number | null;
  initiatorId?: string | null;
  daysBefore?: number | null;
  skipTypeIds?: string[];
};
const between = (input: unknown, min: number, max: number) =>
  Number.isInteger(input) && Number(input) >= min && Number(input) <= max;
/** 与 ruleSchema 一致：1～100 条；发起人是用户账号 ID（与审批转交的目标人口径一致）。 */
export function validDetails(input: unknown) {
  return (
    Array.isArray(input) &&
    input.length >= 1 &&
    input.length <= 100 &&
    input.every(
      (detail: Detail) =>
        typeof detail.typeId === 'string' &&
        detail.typeId.length > 0 &&
        between(detail.months, 1, 1200) &&
        typeof detail.initiatorId === 'string' &&
        uuid.test(detail.initiatorId) &&
        between(detail.daysBefore, 0, 3660),
    )
  );
}
function RuleDetails({
  value = [],
  onChange,
  disabled,
}: {
  value?: Detail[];
  onChange?: (value: Detail[]) => void;
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  const change = lock.guard((index: number, patch: Detail) =>
    onChange?.(value.map((detail, i) => (i === index ? { ...detail, ...patch } : detail))),
  );
  return (
    <Space direction="vertical" className="rule-details">
      {value.map((detail, index) => (
        <section className="contract-card" key={index} aria-label={`${m.fields.details} ${index + 1}`}>
          <DetailInputs detail={detail} disabled={lock.disabled} change={(patch) => change(index, patch)} />
          <Button disabled={lock.disabled} onClick={lock.guard(() => onChange?.(value.filter((_, i) => i !== index)))}>
            {m.removeDetail}
          </Button>
        </section>
      ))}
      <Button
        disabled={lock.disabled || value.length >= 100}
        onClick={lock.guard(() => onChange?.([...value, { skipTypeIds: [], daysBefore: 30, months: 12 }]))}
      >
        {m.addDetail}
      </Button>
    </Space>
  );
}
function DetailInputs({
  detail,
  disabled,
  change,
}: {
  detail: Detail;
  disabled: boolean;
  change(patch: Detail): void;
}) {
  const number = (key: 'daysBefore' | 'months', min: number, max: number) => (
    <label>
      {m.fields[key]}
      <InputNumber
        aria-label={m.fields[key]}
        min={min}
        max={max}
        precision={0}
        value={detail[key]}
        disabled={disabled}
        onChange={(next) => change({ [key]: next })}
      />
    </label>
  );
  return (
    <>
      <label>
        {m.fields.typeId}
        <RefSelect
          path={refPaths.typeId}
          value={detail.typeId}
          disabled={disabled}
          ariaLabel={m.fields.typeId}
          onChange={(next) => change({ typeId: next as string | null })}
        />
      </label>
      {number('daysBefore', 0, 3660)}
      {number('months', 1, 1200)}
      <label>
        {m.fields.initiatorId}
        <Input
          aria-label={m.fields.initiatorId}
          placeholder={m.userIdHint}
          value={detail.initiatorId ?? ''}
          disabled={disabled}
          onChange={(event) => change({ initiatorId: event.target.value.trim() })}
        />
      </label>
      <label>
        {m.fields.skipTypeIds}
        <RefSelect
          path={refPaths.typeId}
          multiple
          value={detail.skipTypeIds ?? []}
          disabled={disabled}
          ariaLabel={m.fields.skipTypeIds}
          onChange={(next) => change({ skipTypeIds: next as string[] })}
        />
      </label>
    </>
  );
}

/** 规则删除也是写命令：带 revision 与命令 ID，回执须为 {id, deleted:true}；结果未知时保持锁定。 */
export function DeleteRule({ row, onDeleted }: { row: Row; onDeleted(): void }) {
  const api = useApiClient();
  const id = String(row.id);
  const submission = useCommandForm(`${paths.rules}/${id}/delete`);
  const [error, setError] = useState<unknown>();
  const remove = async () => {
    setError(undefined);
    const revision = Number(row.revision);
    const result = await submission.submit({
      values: {} as Values,
      baseline: {},
      editableFields: [],
      revision,
      businessId: id,
      send: async (command) =>
        parseSavedReceipt(
          await api.request<unknown>(`${paths.rules}/${encodeURIComponent(id)}`, { method: 'DELETE', command }),
          { id, revision, deleted: true },
        ),
    });
    if (result.status === 'done') {
      submission.clear();
      onDeleted();
    } else setError(result.error);
  };
  return (
    <Space direction="vertical">
      <Popconfirm title={m.deleteConfirm} okText={m.confirm} cancelText={m.cancel} onConfirm={() => void remove()}>
        <Button type="link" danger disabled={submission.locked} loading={submission.busy}>
          {m.delete}
        </Button>
      </Popconfirm>
      {submission.state && submission.state.status !== 'done' && <CommandStatus submission={submission} />}
      {!!error && submission.status === 'idle' && <Alert type="error" message={kernel.unknown} />}
    </Space>
  );
}
