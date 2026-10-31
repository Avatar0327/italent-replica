import { Alert, Button, Descriptions, Form, Input, Modal, Space, message } from 'antd';
import { useState } from 'react';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Latest } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { useEmployeeRead } from '../intern/commands.js';
import { WithOpening } from '../intern/RegularizeForm.js';
import { PageState } from '../foundation/PageState.js';
import { useRead } from '../part-time/useRead.js';
import { ConfirmAction, readObject, useRetireCommand } from './commands.js';
import { m } from './messages.js';
import {
  acceptIntention,
  cellValue,
  intentionBody,
  differs,
  intentionEntries,
  intentions,
  intentionSlot,
  object,
  type IntentionEntry,
  type Row,
} from './model.js';

const open = ['draft', 'rejected', 'in_review'];
const fields = ['intendedDate', 'reason'];
const opening = (): Values => ({ intendedDate: null, reason: null });

/**
 * 意向退休日期申请（B21）：同员工至多一条未办结申请（retirement-intention.ts），有就按状态出修改 / 提交 / 撤回，
 * 没有才出新建；恢复槽 = 意向集合 + 员工 id，新建 / 修改 / 提交 / 撤回共用。
 */
export function IntentionForm({ row, onClose, refresh }: { row: Row; onClose(): void; refresh(): Promise<unknown> }) {
  const employeeId = row.employeeId!;
  const list = useRead<{ items: Row[] }>(`${intentions}?employeeId=${encodeURIComponent(employeeId)}&pageSize=50`);
  const current = list.data?.items.find((item) => open.includes(String(item.status)));
  const permission = usePermissions(object).snapshot.objects[object];
  const entries = intentionEntries(current, permission);
  const [editing, setEditing] = useState<'create' | 'edit'>();
  const reload = async () => {
    await list.reload();
    await refresh();
  };
  return (
    <Modal open width={640} title={m.entries.intention} onCancel={onClose} footer={null} maskClosable={false}>
      {list.error ? (
        <PageState kind="error" error={list.error} retry={list.refresh} />
      ) : (
        <>
          {current ? <IntentionSummary current={current} /> : !list.loading && <Alert message={m.noIntention} />}
          <Space wrap className="retirement-actions">
            {entries.map((entry) =>
              entry === 'create' || entry === 'edit' ? (
                <Button key={entry} type="primary" onClick={() => setEditing(entry)}>
                  {m.intentionEntries[entry]}
                </Button>
              ) : (
                <IntentionAction key={entry} {...{ employeeId, current: current!, action: entry, refresh: reload }} />
              ),
            )}
          </Space>
          {editing && (
            <IntentionEditor
              key={editing}
              employeeId={employeeId}
              current={editing === 'edit' ? current : undefined}
              onClose={() => setEditing(undefined)}
              refresh={reload}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function IntentionSummary({ current }: { current: Row }) {
  const label = (key: string) => m.fields[key === 'expectedDateSnapshot' ? 'expectedRetirementDate' : key];
  const keys = ['intendedDate', 'reason', 'status', 'expectedDateSnapshot'];
  return (
    <Descriptions
      size="small"
      column={2}
      items={keys.map((key) => ({ key, label: label(key), children: cellValue(current, key) }))}
    />
  );
}

/** 读意向申请最新版本：内核重读、冲突差异对照用，id 换成员工（恢复槽对象）。 */
function useIntentionRead(id: string | undefined, employeeId: string) {
  const api = useApiClient();
  return async (): Promise<Latest> => {
    let values: Values = {};
    const revision = await readObject(api, slotKey(intentions, id!), id!, (latest) => {
      values = projectFields(latest, fields);
    });
    return { id: employeeId, revision, values };
  };
}

type EditorProps = { employeeId: string; current?: Row; onClose(): void; refresh(): Promise<unknown> };
/** 打开时读一次基线（新建读员工 revision 作 If-Match，修改读申请最新版本），读到前不渲染表单（同 intern WithOpening）。 */
function IntentionEditor(props: EditorProps) {
  const employeeRead = useEmployeeRead(props.employeeId, opening, false);
  const intentionRead = useIntentionRead(props.current?.id, props.employeeId);
  const read = props.current ? intentionRead : employeeRead;
  const title = props.current ? m.intentionEntries.edit : m.intentionEntries.create;
  return (
    <WithOpening read={read} title={title} onClose={props.onClose}>
      {(latest) => <IntentionFields {...props} opening={latest} read={read} title={title} />}
    </WithOpening>
  );
}

function IntentionFields(props: EditorProps & { opening: Latest; read(): Promise<Latest>; title: string }) {
  const { employeeId, current, onClose, refresh, opening } = props;
  const permission = usePermissions(object).snapshot.objects[object];
  const writable = fields.filter((field) => !!permission?.editableFields.includes(field));
  const [form] = Form.useForm();
  const [baseline] = useState(() => opening.values);
  const target = { id: employeeId, revision: opening.revision, baseline, read: props.read };
  const cmd = useRetireCommand(intentionSlot, target, current ? `edit/${current.id}` : 'create', refresh);
  useDraftRefill(cmd.form, writable, form);
  const [error, setError] = useState<unknown>();
  const save = async () => {
    setError(undefined);
    try {
      const values = projectFields(await form.validateFields(), writable);
      const done = await cmd.submit(values, writable, {
        path: current ? slotKey(intentions, current.id!) : slotKey(intentionSlot, employeeId),
        method: current ? 'PATCH' : 'POST',
        body: (input) => intentionBody(input, writable),
        accept: (raw, revision) => {
          const receipt = acceptIntention(raw, { employeeId, ...(current ? { id: current.id, sent: revision } : {}) });
          // 状态可按字段权裁剪：缺键不核，在场不符拒绝（第 2 轮 P2-1）
          if (differs(receipt, 'status', current ? current.status : 'draft')) throw new Error(m.invalidReceipt);
          const id = String(receipt.id);
          return { path: slotKey(intentions, id), id, revision: Number(receipt.revision) };
        },
      });
      if (!done) return;
      void message.success(m.success.intention);
      onClose();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  const locked = cmd.disabled;
  return (
    <Modal
      open
      title={props.title}
      okText={m.save}
      cancelText={m.cancel}
      okButtonProps={{ disabled: locked, loading: cmd.form.busy }}
      onOk={() => void save()}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
    >
      <CommandStatus submission={cmd.form} labels={m.fields} />
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      <FormLock locked={locked}>
        <Form form={form} layout="vertical" disabled={locked} initialValues={baseline}>
          <Form.Item
            name="intendedDate"
            label={m.fields.intendedDate}
            rules={[{ required: true, message: m.required(m.fields.intendedDate!) }]}
          >
            <LockedField disabled={!writable.includes('intendedDate')}>
              <TenantDatePicker />
            </LockedField>
          </Form.Item>
          <Form.Item name="reason" label={m.fields.reason}>
            <LockedField disabled={!writable.includes('reason')}>
              <Input.TextArea aria-label={m.fields.reason} maxLength={500} />
            </LockedField>
          </Form.Item>
        </Form>
      </FormLock>
    </Modal>
  );
}

/** 提交 / 撤回：空体，If-Match = 申请 revision；资格（状态、原发起人）由服务端判定。 */
type Action = Exclude<IntentionEntry, 'create' | 'edit'>;
type ActionProps = { employeeId: string; current: Row; action: Action; refresh(): Promise<unknown> };
function IntentionAction({ employeeId, current, action, refresh }: ActionProps) {
  const id = current.id!;
  const read = useIntentionRead(id, employeeId);
  const target = { id: employeeId, revision: current.revision, baseline: {}, read };
  const cmd = useRetireCommand(intentionSlot, target, `${action}/${id}`, refresh);
  const run = async () => {
    try {
      const done = await cmd.submit({}, [], {
        path: `${slotKey(intentions, id)}/${action}`,
        body: () => ({}),
        accept: (raw, sent) => {
          const receipt = acceptIntention(raw, { employeeId, id, sent });
          return { path: slotKey(intentions, id), id, revision: Number(receipt.revision) };
        },
      });
      if (done) void message.success(m.success[action === 'submit' ? 'intentionSubmit' : 'intentionWithdraw']);
    } catch {
      // 拒绝 / 冲突 / 结果未知由内核状态条显示
    }
  };
  const label = m.intentionEntries[action];
  return <ConfirmAction cmd={cmd} label={label} title={label} run={run} />;
}
