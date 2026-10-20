import { Alert, Button, Form, Modal, Space, Switch, message } from 'antd';
import { useState } from 'react';
import { ApiError, rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { isBlank, projectFields } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import type { Latest } from '../foundation/forms/store.js';
import { employeePath, useEmployeeRead, useInternCommand } from './commands.js';
import { m } from './messages.js';
import {
  acceptBusiness,
  editableFields,
  interns,
  object,
  terminateBody,
  terminateFields,
  terminateOpening,
} from './model.js';
import { InternField, WithOpening, type FormProps } from './RegularizeForm.js';

/**
 * 结束实习（补证 R2d / R2f1）：只有“实习结束日期*”，保存即生效。有在途转正申请时服务端先要求确认（DEC-593），
 * 有审批通过未生效的转正（待入职）时再显示“离职同步取消待入职”（31 IN-R8，默认关、未证）。
 */
export function TerminateForm(props: FormProps) {
  const read = useEmployeeRead(props.row.employeeId!, terminateOpening, false);
  return (
    <WithOpening read={read} title={m.entries.terminate} onClose={props.onClose}>
      {(opening) => <TerminateEditor {...props} opening={opening} read={read} />}
    </WithOpening>
  );
}

function TerminateEditor({
  row,
  onClose,
  onDone,
  refresh,
  opening,
  read,
}: FormProps & { opening: Latest; read(): Promise<Latest> }) {
  const employeeId = row.employeeId!;
  const permission = usePermissions(object).snapshot.objects[object];
  const [pendingEntry, setPendingEntry] = useState(false);
  const fields = pendingEntry ? terminateFields : ['endDate'];
  const editable = editableFields(fields, permission);
  const [form] = Form.useForm();
  const [baseline] = useState(() => opening.values);
  const target = { id: employeeId, revision: opening.revision, baseline, read };
  const cmd = useInternCommand(interns, target, 'terminate', refresh);
  useDraftRefill(cmd.form, editable, form);
  const [error, setError] = useState<unknown>();
  const locked = cmd.disabled || !permission?.dataOperations.create;
  const submit = async () => {
    if (locked) return;
    setError(undefined);
    try {
      const values = projectFields(await form.validateFields(), editable);
      if (isBlank(values.endDate))
        throw new ApiError(400, 'VALIDATION_FAILED', 'fields', m.required(m.labels.endDate!));
      const done = await cmd.submit(
        values,
        editable,
        {
          path: `${slotKey(interns, employeeId)}/terminate`,
          body: terminateBody,
          accept: (raw, sent) => {
            const receipt = acceptBusiness(raw, { employeeId, kind: 'leave', sent });
            return { path: employeePath(employeeId), id: employeeId, revision: Number(receipt.employeeRevision) };
          },
        },
        (confirmation) => {
          if (confirmation.pendingEntry) setPendingEntry(true);
        },
      );
      if (!done) return;
      void message.success(m.success.terminate);
      onDone();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  return (
    <Modal
      open
      title={m.entries.terminate}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose} disabled={cmd.form.busy}>
            {m.cancel}
          </Button>
          <Button type="primary" loading={cmd.form.busy} disabled={locked} onClick={() => void submit()}>
            {m.save}
          </Button>
        </Space>
      }
    >
      <CommandStatus submission={cmd.form} labels={m.labels} />
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      <FormLock locked={locked}>
        <Form form={form} layout="vertical" disabled={locked} initialValues={baseline}>
          <InternField name="endDate" editable={editable} permission={permission} required>
            <TenantDatePicker />
          </InternField>
          {pendingEntry && (
            <>
              <Alert type="warning" message={m.pendingEntryNote} />
              <InternField name="cancelPendingEntry" editable={editable} permission={permission} checked>
                <Switch aria-label={m.labels.cancelPendingEntry} />
              </InternField>
            </>
          )}
        </Form>
      </FormLock>
    </Modal>
  );
}
