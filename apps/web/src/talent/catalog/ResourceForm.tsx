import { Alert, Input, InputNumber, Select } from 'antd';
import { ApiError, type ApiClient } from '../../foundation/client.js';
import { FormOverlay, type FormField } from '../../foundation/FormOverlay.js';
import { messages as commandMessages } from '../../foundation/forms/messages.js';
import { equal } from '../../foundation/forms/store.js';
import { useCommandForm } from '../../foundation/forms/useCommandForm.js';
import { PageState } from '../../foundation/PageState.js';
import { fieldAccess, type ObjectPermission } from '../../foundation/permission-model.js';
import { useApiClient } from '../../foundation/Session.js';
import { candidates, commandRequestBody, resourcePath, saveResource, validateValues } from './api.js';
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
  const { submit, submission } = useSaveResource(resource, original, fields, blocked, onSaved);
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
      submission={submission}
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

/**
 * 保存走页面级表单提交内核（F-123，DEC-464 / 473）：未知结果的命令保存在页面的 FormCommands 里，关闭重开、切换页签都不会
 * 换命令 ID 再发；服务器明确拒绝时保留输入、改正后新命令重提。内核拿到完整字段投影（打开时的记录、表单草稿、重读的最新记录），
 * 命令体由内核按“草稿 vs 基线”逐字段裁剪；409 重读确认后内核把基线与版本更新为最新记录、没改过的字段回填最新值。
 */
function useSaveResource(
  resource: Resource,
  original: Row | null,
  fields: FormField[],
  blocked: boolean,
  onSaved: () => void,
) {
  const api = useApiClient();
  const path = original ? `${resourcePath(resource)}/${original.id}` : resourcePath(resource);
  const command = useCommandForm(path);
  const submission = {
    ...command,
    reload: original
      ? () =>
          command.reread(async (id) => {
            const latest = await api.request<Row>(`${resourcePath(resource)}/${id}`);
            return { id: latest.id, revision: latest.revision, values: latest };
          })
      : undefined,
  };
  const submit = async (values: Record<string, unknown>) => {
    if (blocked) throw new Error(m.unavailable);
    try {
      validateValues(resource, values);
    } catch (error) {
      throw new ApiError(422, 'LOCAL_VALIDATION', 'fields', (error as Error).message);
    }
    const editable = fields.filter((field) => field.access.editable).map((field) => field.name);
    const nullable = resource.fields.filter((field) => field.nullable).map((field) => field.key);
    // “有没有修改”：与内核同一套比较（含空值等价），基线是内核的当前基线——冲突重读并确认后是最新记录，其余时候是打开时的记录。
    const state = command.state;
    const base = (original && state && state.status !== 'done' ? state.baseline : original) ?? {};
    if (!editable.some((field) => !equal(values[field], base[field])))
      throw new ApiError(422, 'LOCAL_VALIDATION', 'fields', m.noChanges);
    // 内核持有完整字段投影：基线（打开时的记录）、草稿（表单全部可编辑字段）、重读得到的最新记录三者字段集合一致。
    // 用户改过的字段只按“草稿 vs 基线”逐字段算；409 重读后没改过的字段回填最新值（不会把表单里残留的旧值当成新修改），
    // PATCH 只发改过的字段（内核 patchOnly）。发送前只做序列化（空值写成 null / 省略），不改变“哪些字段算改过”。
    const result = await command.submit({
      values,
      baseline: original ?? {},
      editableFields: editable,
      revision: original?.revision ?? 0,
      businessId: original?.id,
      patchOnly: !!original,
      send: (request) =>
        saveResource(api, resource, commandRequestBody(resource, original, nullable, request.body), original, request),
    });
    if (result.status !== 'done') throw result.error ?? new Error(commandMessages.unknown);
    command.clear();
    onSaved();
  };
  return { submit, submission };
}
