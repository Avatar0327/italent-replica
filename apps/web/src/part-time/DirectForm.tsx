import { Alert, Button, Drawer, Form, Modal, Space, message } from 'antd';
import { useRef, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import { ApiError, rejectionMessage } from '../foundation/client.js';
import { FormLock } from '../foundation/forms/FormLock.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { apiRoot, type Row } from './model.js';
import { useRead } from './useRead.js';
import { PageState } from '../foundation/PageState.js';
import { collection, useDirectAccess, useDirectCommand, useRecordRead } from './direct-commands.js';
import { DirectError, useDirectApi } from './direct-api.js';
import { directBody, directValues, formFields, recordReceipt, validateDirect, errorLines } from './direct-model.js';
import { DirectField, ReadonlyPerson, useDirectPreview } from './DirectFields.js';
import { DirectCustomField, useDirectCustomFields } from './DirectCustomFields.js';
import { d } from './direct-messages.js';
export interface DirectProps {
  onClose(): void;
  refresh(): Promise<void>;
}
export function DirectEdit({ id, ...props }: DirectProps & { id: string }) {
  const result = useRead<Row>(`${collection}/${encodeURIComponent(id)}`);
  if (!result.data)
    return (
      <Drawer open title={d.edit} onClose={props.onClose}>
        <PageState kind={result.error ? 'error' : 'loading'} error={result.error} retry={result.refresh} />
      </Drawer>
    );
  return <DirectForm {...props} row={result.data} />;
}
function useDirectForm({ row, onClose, refresh }: DirectProps & { row?: Row }) {
  const create = !row;
  const access = useDirectAccess();
  const custom = useDirectCustomFields(access);
  const fields = [...formFields, ...custom.keys];
  const api = useApiClient();
  const send = useDirectApi();
  const read = useRecordRead();
  const [form] = Form.useForm();
  const [baseline] = useState(() => (row ? directValues(row) : projectFields({}, formFields)));
  const values: Values = Form.useWatch([], form) ?? baseline;
  const employeeId = String(values.employeeId ?? row?.employeeId ?? '');
  const manual = useRef(new Set<string>());
  const [error, setError] = useState<unknown>();
  const editable = fields.filter((key) => access.field(key, create).editable);
  const cmd = useDirectCommand(
    { id: create ? employeeId : row.id, revision: create ? 0 : Number(row.revision), values: baseline },
    create ? 'create' : 'edit',
    async () =>
      create
        ? { ...(await api.request<Values>(`${apiRoot}/employees/${encodeURIComponent(employeeId)}`)), revision: 0 }
        : read(row.id),
  );
  useDraftRefill(cmd.form, editable, form);
  const locked = cmd.form.locked || !access.operation(create) || custom.blocked;
  const preview = useDirectPreview(form, values, create && !locked, editable, manual);
  const submitting = useRef(false);
  const submit = async () => {
    if (locked || submitting.current || preview.busy || preview.error) return;
    setError(undefined);
    try {
      const inputs = await form.validateFields();
      const projected = projectFields(inputs, editable);
      validateDirect(projected, create, cmd.full);
      if (
        create &&
        !['employeeId', 'serviceType', 'effectiveDate', 'departmentId'].every((key) => editable.includes(key))
      )
        throw new ApiError(403, 'FORBIDDEN', 'forbidden', '无必填字段写权限');
      submitting.current = true;
      await cmd.run({
        values: projected,
        editableFields: editable,
        send: async ({ edited, command }) => {
          const path = create
            ? `${apiRoot}/employees/${encodeURIComponent(employeeId)}/part-times`
            : `${collection}/${row.id}`;
          const result = await send(path, create ? 'POST' : 'PATCH', {
            ...command,
            ...(create ? { revision: undefined } : {}),
            body: directBody(edited, create),
          });
          const receipt = recordReceipt(result, row?.id, create ? { ...command, revision: undefined } : command);
          await cmd.finish(receipt, refresh);
          return { id: create ? employeeId : row.id };
        },
      });
      void message.success(d.saved);
      onClose();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    } finally {
      submitting.current = false;
    }
  };
  return { form, create, access, custom, baseline, employeeId, manual, error, cmd, locked, preview, submit };
}
export function DirectForm(props: DirectProps & { row?: Row }) {
  const state = useDirectForm(props);
  const { create, cmd, locked, preview, submit } = state;
  const { onClose } = props;
  const footer = (
    <Space>
      <Button onClick={onClose} disabled={cmd.form.busy}>
        {d.cancel}
      </Button>
      <Button
        type="primary"
        loading={cmd.form.busy}
        disabled={locked || preview.busy || !!preview.error}
        onClick={() => void submit()}
      >
        {d.save}
      </Button>
    </Space>
  );
  const content = <DirectContent state={state} />;
  return create ? (
    <Modal
      open
      title={d.add}
      width={800}
      footer={footer}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={!cmd.form.busy}
      keyboard={!cmd.form.busy}
    >
      {content}
    </Modal>
  ) : (
    <Drawer
      open
      title={d.edit}
      width={560}
      footer={footer}
      onClose={onClose}
      closable={!cmd.form.busy}
      maskClosable={!cmd.form.busy}
      keyboard={!cmd.form.busy}
    >
      {content}
    </Drawer>
  );
}

function DirectContent({ state }: { state: ReturnType<typeof useDirectForm> }) {
  const { form, create, access, custom, baseline, employeeId, manual, error, cmd, locked, preview } = state;
  return (
    <>
      <CommandStatus submission={cmd.form} labels={{ ...d.labels, ...custom.labels }} />
      {!!error && !cmd.form.state?.error && <Alert type="error" message={rejectionMessage(error)} />}
      {cmd.form.state?.error instanceof DirectError &&
        errorLines(cmd.form.state.error.details).map((line) => <Alert key={line} type="error" message={line} />)}
      {preview.node}
      {custom.node}
      <FormLock locked={locked}>
        <Form
          form={form}
          layout="vertical"
          initialValues={baseline}
          disabled={locked}
          onValuesChange={(changed) => {
            for (const key of Object.keys(changed)) manual.current.add(key);
          }}
        >
          <div className={create ? 'part-time-direct-fields' : undefined}>
            {formFields.map((key) => (
              <DirectField
                key={key}
                name={key}
                create={create}
                access={access}
                baseline={cmd.full}
                required={create && ['employeeId', 'serviceType', 'effectiveDate', 'departmentId'].includes(key)}
              />
            ))}
          </div>
          {custom.definitions.map((field) => (
            <DirectCustomField key={field.id} field={field} access={access} create={create} baseline={cmd.full} />
          ))}
          <p>{d.linkage}</p>
          {create && employeeId && <ReadonlyPerson id={employeeId} />}
        </Form>
      </FormLock>
    </>
  );
}
