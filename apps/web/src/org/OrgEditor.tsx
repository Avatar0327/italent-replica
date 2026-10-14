import { App, Input, Select } from 'antd';
import { useState } from 'react';
import {
  ApiError,
  FormOverlay,
  TenantDatePicker,
  newCommand,
  useApiClient,
  type FormField,
} from '../foundation/index.js';
import { ReferenceSelect } from '../job/JobEditor.js';
import { orgChangeBody, type Dimension, type OrgAction, type OrgRow } from './page-model.js';
import { type PageAccess } from './page-support.js';
import { useRecordCommand } from './record-command.js';
import { pageText as m } from './messages.js';
interface Props {
  original: OrgRow;
  action: OrgAction;
  date: string;
  access: PageAccess;
  onClose(): void;
  onSaved(): void;
}
/** 是否联动任职按当前原单（冲突核对后为最新版本）判断；重开被锁定的表单时从内核草稿恢复。 */
function useFields({ original, action, date, access }: Props, current: OrgRow, draft?: Record<string, unknown>) {
  const [name, setName] = useState(String(draft?.name ?? current.name ?? ''));
  const [parent, setParent] = useState(String(draft?.adminParent ?? current.parents?.admin?.parentId ?? ''));
  const needsChoice =
    (access.field('name').editable && name.trim() !== current.name) ||
    (access.field('parents').editable && parent !== (current.parents?.admin?.parentId ?? ''));
  const field = (
    name: string,
    control: FormField['control'],
    label: string = m[name as keyof typeof m],
    required = false,
  ): FormField => ({
    name,
    label,
    control,
    access: access.field(name),
    rules: required ? [{ required: true, message: m.required }] : undefined,
  });
  if (action === 'edit') return [field('establishedOn', <TenantDatePicker />, m.establishedOn, true)];
  if (action !== 'change') return [];
  return [
    field('name', <Input maxLength={200} onChange={(event) => setName(event.target.value)} />, m.name, true),
    field('shortName', <Input maxLength={100} />, m.shortName),
    field('location', <Input maxLength={500} />),
    ...parentFields(original, date, access, setParent),
    field('remarks', <Input.TextArea maxLength={4000} rows={3} />),
    ...(needsChoice
      ? [
          {
            name: 'addEmployment',
            label: m.choice,
            access: { visible: true, editable: true },
            control: (
              <Select
                options={[
                  { value: 'yes', label: m.yes },
                  { value: 'no', label: m.no },
                ]}
              />
            ),
            rules: [{ required: true, message: m.choiceRequired }],
          },
        ]
      : []),
  ];
}
function parentFields(
  original: OrgRow,
  date: string,
  access: PageAccess,
  setParent: (value: string) => void,
): FormField[] {
  return (['admin', 'business', 'product'] as Dimension[])
    .filter((dimension) => original.parents?.[dimension])
    .map((dimension) => ({
      name: `${dimension}Parent`,
      label: `${m[dimension]} · ${m.parent}`,
      access: access.field('parents'),
      control: (
        <ReferenceSelect
          kind="org"
          date={date}
          exclude={original.id}
          onChange={(value) => {
            if (dimension === 'admin') setParent(value ?? '');
          }}
        />
      ),
      rules: [{ required: !!original.parents?.[dimension]?.parentId, message: m.required }],
    }));
}
function project(row: OrgRow) {
  const values: Record<string, unknown> = { ...row };
  for (const dimension of ['admin', 'business', 'product'] as const)
    values[`${dimension}Parent`] = row.parents?.[dimension]?.parentId;
  return values;
}
function toInput(values: Record<string, unknown>) {
  if (values.addEmployment === undefined) return values;
  return { ...values, addEmployment: values.addEmployment === 'yes' };
}
/** 写入的请求体以当前原单（冲突核对后为最新版本）为基准；内核已按基线去掉未改字段。 */
function buildBody(action: OrgAction, date: string) {
  return (body: Record<string, unknown>, current?: OrgRow) => {
    if (action === 'disable') return { effectiveDate: date, enabled: false };
    if (action === 'change' && current) return orgChangeBody(current, toInput(body), date);
    return body;
  };
}
function useConfirmPending(id: string) {
  const api = useApiClient();
  const { modal } = App.useApp();
  return async (body: Record<string, unknown>) => {
    const preview = await api.request<{ hasPendingEmployment: boolean }>(
      `/api/tenant/org/organizations/${id}/employment-preview`,
      { method: 'POST', command: newCommand(body) },
    );
    if (!preview.hasPendingEmployment) return;
    const confirmed = await new Promise<boolean>((resolve) =>
      modal.confirm({
        title: m.pending,
        content: m.pendingHint,
        okText: m.confirm,
        cancelText: m.cancel,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }),
    );
    if (!confirmed) throw new ApiError(422, 'CONFIRMATION_CANCELLED', 'fields', m.pendingHint);
  };
}
function noChange() {
  return new ApiError(422, 'VALIDATION_FAILED', 'fields', m.noChange);
}
function useSubmit(props: Props, record: ReturnType<typeof useOrgCommand>) {
  const { original, action, date } = props;
  const confirmPending = useConfirmPending(original.id);
  const current = record.current ?? original;
  return async (values: Record<string, unknown>) => {
    if (action === 'edit' && values.establishedOn === current.establishedOn) throw noChange();
    if (action === 'change') {
      const body = orgChangeBody(current, toInput(values), date);
      if (Object.keys(body).length === 1) throw noChange();
      if (body.addEmployment === true) await confirmPending(body);
    }
    await record.save(values, {
      path: `/api/tenant/org/organizations/${original.id}${action === 'edit' ? '/correction' : ''}`,
      method: 'PATCH',
      build: buildBody(action, date),
    });
    props.onSaved();
  };
}
function useOrgCommand({ original, action, date }: Props) {
  return useRecordCommand({
    // 原单路径作键：行内、详情、换日期或换动作重开都进同一个槽；动作与日期作为命令上下文存在槽里（F-123 页面片接入 2）。
    resource: `/api/tenant/org/organizations/${original.id}`,
    context: { action, date },
    original,
    readPath: (id, context) => `/api/tenant/org/organizations/${id}?asOf=${context.date}`,
    project,
  });
}
const readOnly = { visible: true, editable: false };
export function OrgEditor(opened: Props) {
  const record = useOrgCommand(opened);
  // 槽里有未确认的命令时按它的动作与日期打开，不按本次入口另起命令。
  const props: Props = { ...opened, ...record.context };
  const { original, action, date } = props;
  const current = record.current ?? original;
  const fields = useFields(props, current, record.command.state?.values);
  const onSubmit = useSubmit(props, record);
  const hint = { edit: m.editHint, disable: m.disableHint, change: m.changeHint }[action];
  const close = () => {
    record.command.clear();
    props.onClose();
  };
  return (
    <FormOverlay
      mode="modal"
      recordKey={original.id}
      submission={record.command}
      open
      title={`${m[action]} · ${original.name ?? m.detail}`}
      onClose={close}
      initialValues={project(original)}
      onSubmit={onSubmit}
      groups={[
        {
          title: m.basic,
          fields: [
            { name: '__hint', label: m.operation, display: hint, control: null, access: readOnly },
            ...(record.resumed
              ? [{ name: '__resumed', label: m.resumedLabel, display: m.resumed, control: null, access: readOnly }]
              : []),
            ...(action !== 'edit'
              ? [{ name: '__date', label: m.date, display: date, control: null, access: readOnly }]
              : []),
            ...fields,
          ],
        },
      ]}
    />
  );
}
