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
import { usePageWrite, type PageAccess } from './page-support.js';
import { pageText as m } from './messages.js';
interface Props {
  original: OrgRow;
  action: OrgAction;
  date: string;
  access: PageAccess;
  onClose(): void;
  onSaved(): void;
}
function useFields({ original, action, date, access }: Props) {
  const [name, setName] = useState(original.name ?? '');
  const [parent, setParent] = useState(original.parents?.admin?.parentId ?? '');
  const needsChoice =
    (access.field('name').editable && name.trim() !== original.name) ||
    (access.field('parents').editable && parent !== (original.parents?.admin?.parentId ?? ''));
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
function useSubmit(props: Props) {
  const { original, action, date } = props;
  const api = useApiClient();
  const write = usePageWrite();
  const { modal } = App.useApp();
  return async (values: Record<string, unknown>) => {
    const input = {
      ...values,
      ...(values.addEmployment !== undefined ? { addEmployment: values.addEmployment === 'yes' } : {}),
    };
    let body = values;
    if (action === 'disable') body = { effectiveDate: date, enabled: false };
    if (action === 'change') body = orgChangeBody(original, input, date);
    if (action === 'change' && Object.keys(body).length === 1)
      throw new ApiError(422, 'VALIDATION_FAILED', 'fields', m.noChange);
    if (body.addEmployment === true) {
      const preview = await api.request<{ hasPendingEmployment: boolean }>(
        `/api/tenant/org/organizations/${original.id}/employment-preview`,
        { method: 'POST', command: newCommand(body) },
      );
      if (preview.hasPendingEmployment) {
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
      }
    }
    await write(
      `/api/tenant/org/organizations/${original.id}${action === 'edit' ? '/correction' : ''}`,
      body,
      original.revision,
      'PATCH',
    );
    props.onSaved();
  };
}
export function OrgEditor(props: Props) {
  const { original, action, date } = props;
  const fields = useFields(props);
  const onSubmit = useSubmit(props);
  const hint = { edit: m.editHint, disable: m.disableHint, change: m.changeHint }[action];
  const initialValues: Record<string, unknown> = { ...original };
  for (const dimension of ['admin', 'business', 'product'] as const)
    initialValues[`${dimension}Parent`] = original.parents?.[dimension]?.parentId;
  return (
    <FormOverlay
      mode="modal"
      recordKey={`${original.id}:${original.revision}:${action}:${date}`}
      open
      title={`${m[action]} · ${original.name ?? m.detail}`}
      onClose={props.onClose}
      onRefresh={props.onClose}
      initialValues={initialValues}
      onSubmit={onSubmit}
      groups={[
        {
          title: m.basic,
          fields: [
            {
              name: '__hint',
              label: m.operation,
              display: hint,
              control: null,
              access: { visible: true, editable: false },
            },
            ...(action !== 'edit'
              ? [
                  {
                    name: '__date',
                    label: m.date,
                    display: date,
                    control: null,
                    access: { visible: true, editable: false },
                  },
                ]
              : []),
            ...fields,
          ],
        },
      ]}
    />
  );
}
