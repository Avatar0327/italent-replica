import { Alert, Button, Descriptions, Drawer, Form, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { rejectionMessage } from '../foundation/client.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { changedFields, refillDraft, sameValue, type Values } from '../foundation/forms/values.js';
import { requestFields } from './request-model.js';
import { useRequestCommand, type RequestSelection } from './request-commands.js';
import { Cell } from './references.js';
import { m } from './messages.js';
import { r } from './request-messages.js';
import { RequestControl, requestFieldLabel } from './RequestControl.js';
import { RequestInformation } from './RequestInformation.js';
import { useRequestPreview } from './request-preview.js';

interface RequestFormProps {
  selection: RequestSelection;
  close(): void;
  refresh(): Promise<unknown>;
  saved?(id: string): void;
}
function useRequestForm(props: RequestFormProps) {
  const cmd = useRequestCommand(props.selection, props.refresh);
  const { kind, action, full, permissions } = cmd;
  const create = action === 'create';
  const editing = create || action === 'edit';
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const fields = editing ? requestFields(kind, create) : [];
  const editable = fields.filter((key) => cmd.allowed && (key === 'employeeId' || permissions.field(key).editable));
  const required = kind === 'add' ? ['employeeId', 'serviceType', 'effectiveDate', 'departmentId'] : ['endDate'];
  const incomplete = create && required.some((key) => !editable.includes(key));
  const locked = cmd.command.locked || cmd.command.blocked || busy || !cmd.allowed || incomplete;
  useDraftRefill(cmd.command, editable, form);
  const previousBaseline = useRef(cmd.baseline);
  useEffect(() => {
    const previous = previousBaseline.current;
    previousBaseline.current = cmd.baseline;
    if (cmd.command.state || sameValue(previous, cmd.baseline)) return;
    const values = form.getFieldsValue();
    form.setFieldsValue(
      refillDraft({
        values,
        latest: cmd.baseline,
        edited: changedFields(values, previous, editable),
        submittable: editable,
      }),
    );
  }, [cmd.baseline, cmd.command.state, editable, form]);
  const selectedEmployee = Form.useWatch('employeeId', form);
  const preview = useRequestPreview(form, create && kind === 'add' && !locked, editable);
  const label = (field: string) => requestFieldLabel(field, kind);
  async function send(submit: boolean) {
    if (locked) return;
    setError(undefined);
    // 本地校验在进入内核前执行，不能把缺字段归入结果未知。
    let values: Values;
    try {
      values = editing ? await form.validateFields() : {};
    } catch {
      return;
    }
    setBusy(true);
    try {
      const id = await cmd.run(values, editable, submit);
      if (id && create) props.saved?.(id);
      props.close();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  const title = create ? r.titles[kind] : r.actionTitle(r.actions[action]);
  return {
    cmd,
    kind,
    action,
    full,
    permissions,
    create,
    form,
    busy,
    error,
    fields,
    editable,
    required,
    locked,
    selectedEmployee,
    preview,
    label,
    send,
    title,
    setError,
  };
}
type FormState = ReturnType<typeof useRequestForm>;
export function RequestForm(props: RequestFormProps) {
  const state = useRequestForm(props);
  const {
    cmd,
    action,
    full,
    permissions,
    busy,
    error,
    fields,
    locked,
    selectedEmployee,
    preview,
    label,
    send,
    title,
    setError,
  } = state;
  return (
    <Drawer
      open
      width={640}
      title={title}
      onClose={props.close}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      footer={
        <Space>
          <Button disabled={busy} onClick={props.close}>
            {r.cancel}
          </Button>
          {action === 'create' ? (
            <>
              <Button disabled={locked} onClick={() => void send(false)}>
                {r.draft}
              </Button>
              {permissions.can('Employment.Submit') && (
                <Button type="primary" disabled={locked} onClick={() => void send(true)}>
                  {r.submit}
                </Button>
              )}
            </>
          ) : (
            <Button type="primary" disabled={locked} onClick={() => void send(false)}>
              {action === 'edit' ? r.save : r.actions[action]}
            </Button>
          )}
        </Space>
      }
    >
      <CommandStatus
        submission={cmd.command}
        labels={Object.fromEntries([...fields, 'originalEndDate'].map((key) => [key, label(key)]))}
      />
      {!!error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      {!!preview && <Alert type="warning" message={rejectionMessage(preview)} />}
      {cmd.row && (
        <Button disabled={busy || cmd.command.locked} onClick={() => void cmd.rereadRejected().catch(setError)}>
          {r.reload}
        </Button>
      )}
      <OriginalDate state={state} />
      <RequestFields state={state} />
      <RequestSummary state={state} />
      <RequestInformation employeeId={selectedEmployee ?? full.employeeId} request={cmd.row} />
    </Drawer>
  );
}
function OriginalDate({ state }: { state: FormState }) {
  const { kind, full } = state;
  if (kind === 'add') return null;
  return (
    <Descriptions
      size="small"
      column={1}
      items={[
        {
          key: 'originalEndDate',
          label: kind === 'extend' ? r.fields.oldEnd : r.fields.originalEndDate,
          children: String(full.originalEndDate ?? m.missing),
        },
      ]}
    />
  );
}
function RequestFields({ state }: { state: FormState }) {
  const { cmd, form, locked, fields, permissions, editable, label, required, full } = state;
  return (
    <FormLock locked={!!locked}>
      <Form form={form} layout="vertical" initialValues={cmd.baseline} disabled={!!locked}>
        {fields
          .filter((field) => field === 'employeeId' || permissions.field(field).visible)
          .map((field) => (
            <Form.Item
              key={field}
              name={editable.includes(field) ? field : undefined}
              label={label(field)}
              rules={
                editable.includes(field) && required.includes(field) ? [{ required: true, message: r.required }] : []
              }
            >
              {editable.includes(field) ? (
                <LockedField>
                  <RequestControl field={field} label={label(field)} />
                </LockedField>
              ) : (
                <span>{String(full[field] ?? m.missing)}</span>
              )}
            </Form.Item>
          ))}
      </Form>
    </FormLock>
  );
}
function RequestSummary({ state }: { state: FormState }) {
  const { kind, full } = state;
  if (kind === 'add') return null;
  return (
    <>
      <h3>{r.detail}</h3>
      <Descriptions
        column={2}
        size="small"
        items={[
          ...[
            'name',
            'code',
            'serviceType',
            'effectiveDate',
            'departmentId',
            'directManagerId',
            'postId',
            'levelId',
          ].map((key) => ({
            key,
            label: m.fields[key],
            children: (
              <Cell row={{ ...full, id: String(full.id), fields: full as Values }} field={key} view="in_approval" />
            ),
          })),
        ]}
      />
    </>
  );
}
