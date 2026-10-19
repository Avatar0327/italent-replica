import { Alert, Button, Form, Modal, Space, message } from 'antd';
import { useRef, useState } from 'react';
import { TenantDatePicker } from '../foundation/selectors.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { rejectionMessage } from '../foundation/client.js';
import type { Values } from '../foundation/forms/values.js';
import type { Row } from './model.js';
import { collection, useDirectAccess, useDirectCommand, useRecordRead } from './direct-commands.js';
import { batchReceipt, errorLines, validateBatch } from './direct-model.js';
import { DirectError, useDirectApi } from './direct-api.js';
import type { DirectProps } from './DirectForm.js';
import { d } from './direct-messages.js';
function useDirectBatch({ rows, onClose, refresh }: DirectProps & { rows: Row[] }) {
  const [form] = Form.useForm();
  // 仅同一结束日可带出；不同结束日的原站默认算法未取证，留空让用户明确填写。
  const [baseline] = useState(() => ({
    items: rows,
    endDate: rows.every((row) => row.endDate === rows[0]?.endDate) ? (rows[0]?.endDate ?? null) : null,
  }));
  const read = useRecordRead();
  const send = useDirectApi();
  const access = useDirectAccess();
  const allowed = access.field('endDate', false).editable;
  const cmd = useDirectCommand(
    {
      id: rows[0]?.id,
      revision: Number(rows[0]?.revision),
      values: baseline,
      objects: rows.map((row) => ({ id: row.id, revision: Number(row.revision) })),
    },
    'batch-end',
    async (original) => {
      const targets = (original?.items ?? rows) as Row[];
      const items = await Promise.all(targets.map((row) => read(row.id)));
      return {
        items,
        revision: items[0]?.revision,
        endDate: items.every((row) => row.endDate === items[0]?.endDate) ? (items[0]?.endDate ?? null) : null,
      };
    },
  );
  useDraftRefill(cmd.form, allowed ? ['endDate'] : [], form);
  const [error, setError] = useState<unknown>();
  const sending = useRef(false);
  const locked = cmd.form.locked || !allowed;
  const submit = async () => {
    if (locked || sending.current) return;
    setError(undefined);
    try {
      const values = await form.validateFields();
      const current = cmd.full.items as Values[];
      validateBatch(current, values.endDate);
      sending.current = true;
      await cmd.run({
        values,
        editableFields: ['endDate'],
        send: async ({ command }) => {
          const items = current.map((row) => ({ recordId: String(row.id), revision: Number(row.revision) }));
          // endDate 与基线相同时仍是合法命令选项；内核 edited 只承载变化，未改值取最新 full。
          const body = { items, endDate: command.body.endDate ?? cmd.full.endDate };
          const result = await send(`${collection}/batch-end`, 'POST', { ...command, revision: undefined, body });
          batchReceipt(result, items);
          await cmd.finish(undefined, refresh);
          return { id: rows[0]!.id };
        },
      });
      void message.success(d.saved);
      onClose();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    } finally {
      sending.current = false;
    }
  };
  return { form, baseline, cmd, error, locked, submit };
}
export function DirectBatch(props: DirectProps & { rows: Row[] }) {
  const { form, baseline, cmd, error, locked, submit } = useDirectBatch(props);
  const { onClose } = props;
  return (
    <Modal
      open
      title={d.batch}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={!cmd.form.busy}
      footer={
        <Space>
          <Button disabled={cmd.form.busy} onClick={onClose}>
            {d.cancel}
          </Button>
          <Button type="primary" disabled={locked} loading={cmd.form.busy} onClick={() => void submit()}>
            {d.save}
          </Button>
        </Space>
      }
    >
      <CommandStatus submission={cmd.form} labels={{ endDate: d.labels.endDate }} />
      {!!error && !cmd.form.state?.error && <Alert type="error" message={rejectionMessage(error)} />}
      {cmd.form.state?.error instanceof DirectError &&
        errorLines(cmd.form.state.error.details).map((line) => <Alert key={line} type="error" message={line} />)}
      <FormLock locked={locked}>
        <Form form={form} initialValues={baseline} layout="vertical" disabled={locked}>
          <Form.Item
            name="endDate"
            label={d.labels.endDate}
            rules={[{ required: true, message: d.required(d.labels.endDate!) }]}
          >
            <LockedField>
              <TenantDatePicker />
            </LockedField>
          </Form.Item>
        </Form>
      </FormLock>
    </Modal>
  );
}
