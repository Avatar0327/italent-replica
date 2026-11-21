import { Alert, Button, Descriptions, Form, Modal, Space } from 'antd';
import { useCallback, useState } from 'react';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, sameValue, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { fieldAccess } from '../foundation/permission-model.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { employeePath, useEmployeeRead } from '../intern/commands.js';
import { WithOpening } from '../intern/RegularizeForm.js';
import { useRetireCommand } from './commands.js';
import { m } from './messages.js';
import { apiRoot, object } from './model.js';
import { useRetirementPreview } from './preview.js';
import {
  acceptRehire,
  applicantFields,
  businessValues,
  rehireApplicationAccess,
  rehireApplicationBody,
  rehireFields,
} from './rehire-model.js';
import { RehireFields } from './RehirePlan.js';
import type { Latest } from '../foundation/forms/store.js';

const businesses = `${apiRoot}/businesses`;
const blank = () => ({ effectiveDate: null });
export type RehireApplicationTarget = { employeeId: string; id?: string };
type Props = RehireApplicationTarget & { onClose(): void; onCreated(id: string): void };

export function RehireApplication(props: Props) {
  const { id, employeeId, onClose } = props;
  const api = useApiClient();
  const employee = useEmployeeRead(employeeId, blank, false);
  const read = useCallback(async (): Promise<Latest> => {
    if (!id) return employee();
    const row = acceptRehire(await api.request<Values>(slotKey(businesses, id)), employeeId, id);
    // 从地址打开时，只有读回完整类型证明是返聘申请才可进入编辑。
    if (row.kind !== 'retire_rehire' || row.mode !== 'application') throw new Error(m.invalidReceipt);
    return { id, revision: row.revision, values: businessValues(row) };
  }, [api, employee, employeeId, id]);
  return (
    <WithOpening read={read} title={m.rehire.application} onClose={onClose}>
      {(opening) => <RehireEditor {...props} opening={opening} read={read} />}
    </WithOpening>
  );
}

type EditorProps = Props & { opening: Latest; read(): Promise<Latest> };
function useRehireEditor({ id, employeeId, opening, read, onCreated }: EditorProps) {
  const [form] = Form.useForm();
  const [saved, setSaved] = useState(false);
  const [snapshot, setSnapshot] = useState(opening);
  const employee = employeePath(employeeId);
  const collection = `${employee}/businesses`;
  const path = id ? slotKey(businesses, id) : collection;
  const permission = usePermissions(object).snapshot.objects[object];
  const access = rehireApplicationAccess(permission);
  const writable = id ? access.edit : access.create;
  const availableFields = id
    ? ['effectiveDate']
    : applicantFields.filter(
        (key) => fieldAccess(permission, rehireFields[key as keyof typeof rehireFields] ?? key).editable,
      );
  const editable = writable ? availableFields : [];
  const target = { ...snapshot, baseline: snapshot.values, read, collection: !id };
  const cmd = useRetireCommand(id ? businesses : collection, target, 'retire_rehire', async () => {});
  useDraftRefill(cmd.form, editable, form);

  const watched = Form.useWatch([], { form, preserve: true }) as Values | undefined;
  const bodyOf = (values: Values) => rehireApplicationBody(id ? { ...cmd.full, ...values } : values);
  const draft = projectFields(watched, editable);
  const preview = useRetirementPreview(`${employee}/forward-update-preview`, bodyOf(draft));
  const locked = cmd.disabled || editable.length === 0 || !access.preview;
  const changed = !id || !sameValue(draft.effectiveDate, cmd.full.effectiveDate);
  const formValues = async () => {
    const values = await form.validateFields().catch(() => undefined);
    return values && projectFields(values as Values, editable);
  };
  const runPreview = async () => {
    const values = await formValues();
    if (values) await preview.run(bodyOf(values));
  };
  const submit = async () => {
    const values = await formValues();
    if (locked || !values || !preview.matches(bodyOf(values))) return;
    let confirmed: Latest | undefined;
    try {
      const done = await cmd.submit(values, editable, {
        path,
        method: id ? 'PATCH' : 'POST',
        body: (input, extra) => ({
          ...(id ? { effectiveDate: input.effectiveDate } : rehireApplicationBody(input)),
          ...(extra.confirmed ? { confirmed: true } : {}),
        }),
        accept: (raw, sent) => {
          const result = acceptRehire(raw, employeeId, id, sent);
          return {
            path: slotKey(businesses, result.id),
            id: result.id,
            revision: result.revision,
            verify: (current) => {
              const row = acceptRehire(current, employeeId, result.id);
              confirmed = { id: row.id, revision: row.revision, values: businessValues(row) };
            },
          };
        },
      });
      if (!done || !confirmed) return;
      if (id) {
        setSnapshot(confirmed);
        form.setFieldsValue(confirmed.values);
        setSaved(true);
      } else onCreated(confirmed.id);
    } catch {
      // CommandStatus 显示服务端拒绝，保留表单值。
    }
  };

  const current = cmd.form.state?.latest?.values ?? snapshot.values;
  return { form, cmd, access, editable, locked, changed, preview, runPreview, submit, saved, setSaved, current };
}

function RehireEditor(props: EditorProps) {
  const { id, onClose, opening } = props;
  const { form, cmd, access, editable, locked, changed, preview, runPreview, submit, saved, setSaved, current } =
    useRehireEditor(props);
  return (
    <Modal
      open
      title={m.rehire.application}
      width={680}
      maskClosable={false}
      closable={!cmd.form.busy}
      keyboard={!cmd.form.busy}
      onCancel={onClose}
      footer={
        <Space>
          <Button disabled={cmd.form.busy} onClick={onClose}>
            {m.cancel}
          </Button>
          {access.preview && (
            <Button disabled={locked} loading={preview.loading} onClick={() => void runPreview()}>
              {m.preview}
            </Button>
          )}
          <Button
            type="primary"
            loading={cmd.form.busy}
            disabled={locked || !preview.data || !changed}
            onClick={() => void submit()}
          >
            {m.save}
          </Button>
        </Space>
      }
    >
      <CommandStatus submission={cmd.form} labels={{ effectiveDate: m.rehire.date }} />
      {id && <Alert type="success" message={saved ? m.rehire.dateSaved : m.rehire.saved} />}
      {!!preview.error && <Alert type="error" showIcon message={rejectionMessage(preview.error)} />}
      {!!preview.data && <Alert type="success" message={m.rehire.allowed} />}
      {!editable.length && <Alert type="info" message={m.rehire.readonly} />}
      <FormLock locked={locked}>
        <Form
          form={form}
          layout="vertical"
          disabled={locked}
          initialValues={opening.values}
          onValuesChange={() => setSaved(false)}
        >
          {editable.includes('effectiveDate') ? (
            <Form.Item
              name="effectiveDate"
              label={m.rehire.date}
              rules={[{ required: true, message: m.required(m.rehire.date) }]}
            >
              <TenantDatePicker />
            </Form.Item>
          ) : (
            typeof current.effectiveDate === 'string' && (
              <Descriptions size="small" items={[{ label: m.rehire.date, children: current.effectiveDate }]} />
            )
          )}
          {!id && <RehireFields editable={editable} />}
        </Form>
      </FormLock>
    </Modal>
  );
}
