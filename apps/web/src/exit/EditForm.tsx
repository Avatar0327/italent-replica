import { Alert, Button, Form, Input, Modal, Space } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Latest } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { isBlank, projectFields, sameValue, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { WithOpening } from '../intern/RegularizeForm.js';
import { ask, useExitCommand, useExitRead, useFormSubmit, type ExitCommand } from './ExitCommands.js';
import { ExitFields } from './ExitFields.js';
import { x } from './messages.js';
import {
  acceptExit,
  blackGroupKept,
  blacklistFields,
  downstreamLines,
  editableFields,
  exits,
  object,
  patchBody,
  submitBody,
  validateExit,
} from './exit-model.js';

export interface DocumentProps {
  id: string;
  onClose(): void;
  /** 写后回读之后刷新详情与列表。 */
  refresh(): Promise<unknown>;
}

/** 撤销 / 改期回执里的下游清单（按查看人裁剪）：有内容才提示，字段缺席时不推算。 */
function showDownstream(raw: unknown) {
  const lines = downstreamLines(raw);
  if (!lines.length) return;
  Modal.info({
    title: x.downstreamTitle,
    okText: x.confirm,
    content: (
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    ),
  });
}

/** 加黑组（是否加黑 + 三项）：编辑时原样保留则不要求重填加黑原因。 */
function useBlackGroup(form: ReturnType<typeof Form.useForm>[0], baseline: Values) {
  const values: Values = { addToBlacklist: Form.useWatch('addToBlacklist', form) };
  for (const field of blacklistFields) values[field] = Form.useWatch(field, form);
  const black = values.addToBlacklist === true;
  return { black, blackRequired: black && !blackGroupKept(values, baseline) };
}

/** 编辑 / 改期（B14）：按离职单 revision 打开，只发人工修改的字段；后端拒绝时保留输入并展示原因。 */
export function EditForm(props: DocumentProps) {
  const read = useExitRead(props.id);
  return (
    <WithOpening read={read} title={x.entries.edit} onClose={props.onClose}>
      {(opening) => <EditEditor {...props} opening={opening} read={read} />}
    </WithOpening>
  );
}

function EditEditor({
  id,
  onClose,
  refresh,
  opening,
  read,
}: DocumentProps & { opening: Latest; read(): Promise<Latest> }) {
  const permission = usePermissions(object).snapshot.objects[object];
  const editable = editableFields(permission, 'update');
  const [form] = Form.useForm();
  const [baseline] = useState(() => opening.values);
  const cmd = useExitCommand(exits, { id, revision: opening.revision, baseline, read }, 'edit', refresh);
  const group = useBlackGroup(form, cmd.full);
  useDraftRefill(cmd.form, editable, form);
  const { error, submit } = useFormSubmit(
    cmd.disabled,
    async () => {
      const values = projectFields(await form.validateFields(), editable);
      validateExit(values, editable, cmd.full);
      const date = values.lastWorkDate;
      // 改期先二次确认：服务端可能按日期门禁拒绝（EXIT_DATE_IMMUTABLE 等），拒绝时表单保留输入
      if (!isBlank(date) && !sameValue(date, cmd.full.lastWorkDate))
        if (!(await ask(x.rescheduleTitle, x.reschedule(String(date))))) return false;
      let receipt: unknown;
      const done = await cmd.submit(values, editable, {
        path: slotKey(exits, id),
        method: 'PATCH',
        body: (merged, confirm, edited) => patchBody(edited, confirm, merged),
        accept: (raw, sent) => {
          receipt = raw;
          return { path: slotKey(exits, id), ...acceptExit(raw, { id, sent: Number(sent) }) };
        },
      });
      if (done) showDownstream(receipt);
      return done;
    },
    onClose,
  );
  return (
    <CommandModal title={x.entries.edit} cmd={cmd} error={error} onClose={onClose} onSubmit={submit}>
      <Form form={form} layout="vertical" disabled={cmd.disabled} initialValues={baseline}>
        <ExitFields editable={editable} permission={permission} {...group} />
      </Form>
    </CommandModal>
  );
}

/**
 * 离职申请提交审批（POST /exits/:id/submit，If-Match = 离职单 revision）：新建申请只建草稿，这一步成功才算提交。
 * auto：新建后自动提交一次；失败时草稿保留，在本弹窗重试（同一草稿、不再建单），或稍后在详情中提交。
 */
export function SubmitForm(props: DocumentProps & { revision: number; auto?: boolean; confirmable?: boolean }) {
  const { id, revision, onClose, refresh } = props;
  const read = useExitRead(id);
  const [baseline] = useState<Values>({});
  const cmd = useExitCommand(exits, { id, revision, baseline, read }, 'submit', refresh);
  const { error, submit } = useFormSubmit(
    cmd.disabled,
    async () =>
      cmd.submit({}, [], {
        path: `${slotKey(exits, id)}/submit`,
        method: 'POST',
        body: (_, confirm) => submitBody(confirm),
        accept: (raw, sent) => ({ path: slotKey(exits, id), ...acceptExit(raw, { id, sent: Number(sent) }) }),
        confirmable: props.confirmable,
      }),
    onClose,
  );
  const started = useRef(false);
  useEffect(() => {
    if (!props.auto || started.current) return;
    started.current = true;
    // 只在打开时自动提交一次（StrictMode 重复挂载由 started 挡住）
    void submit();
  }, []);
  return (
    <CommandModal
      title={x.entries.submit}
      cmd={cmd}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={x.entries.submit}
    >
      <Alert type="info" message={x.draftSaved} />
    </CommandModal>
  );
}

/** 撤销离职：必填撤销原因；超编时服务端要求确认（CONFIRMATION_REQUIRED），确认后同一命令上下文重提。 */
export function CancelForm(props: DocumentProps & { revision: number }) {
  const { id, revision, onClose, refresh } = props;
  const read = useExitRead(id);
  const [baseline] = useState<Values>({ reason: null });
  const cmd = useExitCommand(exits, { id, revision, baseline, read }, 'cancel', refresh);
  const [form] = Form.useForm();
  useDraftRefill(cmd.form, ['reason'], form);
  const { error, submit } = useFormSubmit(
    cmd.disabled,
    async () => {
      let receipt: unknown;
      const done = await cmd.submit({ reason: String((await form.validateFields()).reason).trim() }, ['reason'], {
        path: `${slotKey(exits, id)}/cancel`,
        method: 'POST',
        body: (merged, confirm) => ({ reason: merged.reason, ...confirm }),
        accept: (raw, sent) => {
          receipt = raw;
          return { path: slotKey(exits, id), ...acceptExit(raw, { id, sent: Number(sent) }) };
        },
      });
      if (done) showDownstream(receipt);
      return done;
    },
    onClose,
  );
  return (
    <CommandModal title={x.entries.cancel} cmd={cmd} error={error} onClose={onClose} onSubmit={submit}>
      <Alert type="warning" message={x.cancelConfirm} />
      <Form form={form} layout="vertical" disabled={cmd.disabled} initialValues={baseline}>
        <Form.Item
          name="reason"
          label={x.cancelReason}
          rules={[{ required: true, whitespace: true, message: x.required(x.cancelReason) }]}
        >
          <Input.TextArea aria-label={x.cancelReason} maxLength={500} rows={3} />
        </Form.Item>
      </Form>
    </CommandModal>
  );
}

/** 命令表单的外壳：处理中不能关闭；内核状态（冲突 / 结果未知 / 拒绝）与本地错误分开显示。 */
export function CommandModal(props: {
  title: string;
  cmd: ExitCommand;
  error: unknown;
  onClose(): void;
  onSubmit(): Promise<void>;
  children: ReactNode;
  /** 表单上方、锁定区以外的内容（员工、提交前检查结果）。 */
  before?: ReactNode;
  locked?: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
}) {
  const { cmd, error } = props;
  const locked = props.locked ?? cmd.disabled;
  return (
    <Modal
      open
      title={props.title}
      onCancel={props.onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={props.onClose} disabled={cmd.form.busy}>
            {x.cancel}
          </Button>
          <Button
            type="primary"
            loading={cmd.form.busy}
            disabled={locked || props.submitDisabled}
            onClick={() => void props.onSubmit()}
          >
            {props.submitLabel ?? x.save}
          </Button>
        </Space>
      }
    >
      <CommandStatus submission={cmd.form} labels={x.fields} />
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      {props.before}
      <FormLock locked={locked}>{props.children}</FormLock>
    </Modal>
  );
}
