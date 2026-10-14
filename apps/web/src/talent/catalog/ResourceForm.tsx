import { Alert, Input, InputNumber, Select } from 'antd';
import { useRef } from 'react';
import { ApiError, type ApiClient } from '../../foundation/client.js';
import { FormOverlay, type FormField } from '../../foundation/FormOverlay.js';
import { PageState } from '../../foundation/PageState.js';
import { fieldAccess, type ObjectPermission } from '../../foundation/permission-model.js';
import { useApiClient } from '../../foundation/Session.js';
import { candidates, saveResource, validateValues, writablePatch } from './api.js';
import { useRemote } from './hooks.js';
import { ReferencedDimensions } from './ReferencedDimensions.js';
import { StandardTargets } from './StandardTargets.js';
import { m } from './messages.js';
import type { Field, Resource, Row } from './types.js';

interface Contract {
  editableFields: string[];
  requiredFields: string[];
  blockedReason?: string;
}
async function loadForm(
  api: ApiClient,
  resource: Resource,
  original: Row | null,
  permission: ObjectPermission,
  signal: AbortSignal,
) {
  const fields = resource.fields.filter(
    (field) => !original || (!field.createOnly && !['targets', 'references'].includes(field.kind ?? '')),
  );
  const contract = resource.form
    ? await api.request<Contract>(
        `/api/tenant/talent/forms/${resource.form}?operation=${original ? `update&id=${original.id}` : 'create'}`,
        { signal },
      )
    : undefined;
  const options: Record<string, Row[]> = {};
  await Promise.all(
    fields
      .filter((field) => field.source && fieldAccess(permission, field.key).visible)
      .map(async (field) => {
        options[field.key] = await candidates(api, field.source!, signal);
      }),
  );
  const owners =
    !original && resource.owner
      ? await candidates(api, `/api/tenant/${resource.module}/candidates/owner-orgs?object=${resource.owner}`, signal)
      : [];
  return { contract, options, owners };
}
function control(field: Field, rows: Row[] = []) {
  if (field.kind === 'references') return <ReferencedDimensions rows={rows} />;
  if (field.kind === 'targets') return <StandardTargets rows={rows} />;
  if (field.kind === 'number') return <InputNumber min={0} max={1_000_000} precision={0} style={{ width: '100%' }} />;
  if (field.kind === 'text') return <Input.TextArea rows={3} maxLength={4000} />;
  if (field.kind === 'boolean') return <Select options={m.enabledOptions} />;
  if (field.kind === 'select')
    return (
      <Select
        showSearch
        optionFilterProp="label"
        mode={field.multiple ? 'multiple' : undefined}
        allowClear={field.nullable === true && !field.required}
        placeholder={m.choose}
        options={field.options ?? rows.map((row) => ({ value: row.id, label: row.name ?? row.id }))}
      />
    );
  return <Input maxLength={field.max ?? 100} />;
}
export function ResourceForm({
  resource,
  original,
  permission,
  onClose,
  onSaved,
}: {
  resource: Resource;
  original: Row | null;
  permission: ObjectPermission;
  onClose(): void;
  onSaved(): void;
}) {
  const data = useRemote(
    `form:${resource.object}:${original?.id ?? 'new'}:${original?.revision ?? 0}`,
    (client, signal) => loadForm(client, resource, original, permission, signal),
  );
  const fields = formFields(resource, original, permission, data.data);
  const owners = data.data?.owners ?? [];
  const missingRequired =
    !original &&
    resource.fields.some(
      (field) =>
        (field.required || field.kind === 'targets') &&
        !fields.find((item) => item.name === field.key)?.access.editable,
    );
  const blocked =
    missingRequired ||
    data.loading ||
    !!data.error ||
    !!data.data?.contract?.blockedReason ||
    (!original && !!resource.owner && !owners.length) ||
    !fields.some((field) => field.access.editable);
  const initialValues = original ? { ...original } : {};
  const submit = useSaveResource(resource, original, fields, blocked, onSaved);
  const notice = data.error ? (
    <PageState kind="error" error={data.error} />
  ) : (
    <Alert
      type="info"
      message={
        data.loading
          ? m.choose
          : (data.data?.contract?.blockedReason ??
            (!original && resource.owner && !owners.length ? m.ownerMissing : m.unavailable))
      }
    />
  );
  const shown = blocked
    ? [{ name: '_notice', label: '', control: null, display: notice, access: { visible: true, editable: false } }]
    : fields;
  return (
    <FormOverlay
      mode={resource.module === 'qualification' && resource.key === 'categories' ? 'modal' : 'drawer'}
      recordKey={original ? `${original.id}:${original.revision}` : `new:${resource.key}`}
      title={`${original ? m.edit : m.create} · ${resource.title}`}
      open
      onClose={onClose}
      initialValues={initialValues}
      groups={[{ title: m.basic, fields: shown }]}
      onSubmit={submit}
      onRefresh={() => {
        onSaved();
        onClose();
      }}
    />
  );
}

function formFields(
  resource: Resource,
  original: Row | null,
  permission: ObjectPermission,
  data?: Awaited<ReturnType<typeof loadForm>>,
) {
  const fields: FormField[] = resource.fields
    .filter((field) => !original || (!field.createOnly && !['targets', 'references'].includes(field.kind ?? '')))
    .map((field) => {
      const access = fieldAccess(permission, field.key);
      return {
        name: field.key,
        label: field.label,
        control: control(field, data?.options[field.key]),
        access: {
          visible: access.visible,
          editable:
            access.editable &&
            (!data?.contract || data.contract.editableFields.includes(field.key)) &&
            (!original || Object.hasOwn(original, field.key)),
        },
        rules: [
          {
            required: field.required || data?.contract?.requiredFields.includes(field.key),
            ...validationType(field),
            message: m.required,
          },
        ],
      };
    });
  const owners = data?.owners ?? [];
  if (!original && owners.length > 1)
    fields.push({
      name: 'ownerOrgId',
      label: m.owner,
      access: { visible: true, editable: true },
      control: <Select options={owners.map((row) => ({ value: row.id, label: row.name ?? row.id }))} />,
      rules: [{ required: true, message: m.required }],
    });
  return fields;
}

function validationType(field: Field) {
  if (field.kind === 'boolean') return { type: 'boolean' as const };
  if (field.kind === 'number') return { type: 'number' as const };
  if (field.multiple || field.kind === 'targets' || field.kind === 'references') return { type: 'array' as const };
  return { type: 'string' as const, whitespace: true };
}

function useSaveResource(
  resource: Resource,
  original: Row | null,
  fields: FormField[],
  blocked: boolean,
  onSaved: () => void,
) {
  const api = useApiClient();
  const uncertain = useRef(false);
  return async (values: Record<string, unknown>) => {
    if (blocked) throw new Error(m.unavailable);
    if (uncertain.current) throw new ApiError(0, 'RESULT_UNKNOWN', 'unknown', m.uncertain);
    try {
      validateValues(resource, values);
    } catch (error) {
      throw new ApiError(422, 'LOCAL_VALIDATION', 'fields', (error as Error).message);
    }
    const body = writablePatch(
      values,
      original,
      fields.filter((field) => field.access.editable).map((field) => field.name),
      resource.fields.filter((field) => field.nullable).map((field) => field.key),
    );
    if (!Object.keys(body).length) throw new ApiError(422, 'LOCAL_VALIDATION', 'fields', m.noChanges);
    // 标准的明细为整组替换；基础编辑绝不携带旧明细，创建空标准按已有契约提交空格集合。
    if (!original && resource.module === 'qualification' && resource.key === 'standards') body.details ??= [];
    try {
      await saveResource(api, resource, body, original);
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'unknown') uncertain.current = true;
      throw error;
    }
  };
}
