import { Alert, Form, Modal } from 'antd';
import { useState } from 'react';
import { usePeople } from '../contracts/references.js';
import { newCommand } from '../foundation/client.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Latest } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { PersonSelect, type Choice } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { employeePath, useEmployeeRead } from '../intern/commands.js';
import { WithOpening } from '../intern/RegularizeForm.js';
import { CommandModal } from './EditForm.js';
import { useExitCommand, useFormSubmit } from './ExitCommands.js';
import { ExitFields } from './ExitFields.js';
import { x } from './messages.js';
import {
  acceptExit,
  createBody,
  editableFields,
  exitEmployees,
  object,
  openingValues,
  parsePreview,
  previewNotice,
  validateExit,
} from './exit-model.js';

export interface ExitFormProps {
  mode: 'application' | 'direct';
  /** 行内“离职处理”（B15）预填员工；工具栏入口先选人。 */
  employee?: Choice;
  onClose(): void;
  /** 写入后切到“离职中”并刷新（写后回读之后调用；失败按结果未确认）。 */
  onDone(): Promise<unknown>;
}

/** 离职申请 / 直接离职（B12）：先选离职员工，再按员工 revision 打开表单。 */
export function ExitForm(props: ExitFormProps) {
  const [employee, setEmployee] = useState(props.employee);
  const [picked, setPicked] = useState(props.employee);
  const people = usePeople();
  if (picked) return <ExitOpening {...props} employee={picked} />;
  return (
    <Modal
      open
      title={x.entries[props.mode]}
      onCancel={props.onClose}
      maskClosable={false}
      okText={x.pick}
      cancelText={x.cancel}
      okButtonProps={{ disabled: !employee }}
      onOk={() => setPicked(employee)}
    >
      <Form layout="vertical">
        <Form.Item label={x.employee} required>
          <PersonSelect load={people} value={employee} onChange={setEmployee} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ExitOpening(props: ExitFormProps & { employee: Choice }) {
  const read = useEmployeeRead(props.employee.value, openingValues, false);
  return (
    <WithOpening read={read} title={x.entries[props.mode]} onClose={props.onClose}>
      {(opening) => <ExitEditor {...props} opening={opening} read={read} />}
    </WithOpening>
  );
}

type EditorProps = ExitFormProps & { employee: Choice; opening: Latest; read(): Promise<Latest> };
type Checked = { lastWorkDate: string; notice: ReturnType<typeof previewNotice> };

/** 提交前检查（POST preview）：只读，不进命令内核；最后工作日变了就要重新检查。 */
function usePreview(employeeId: string) {
  const api = useApiClient();
  const [checked, setChecked] = useState<Checked>();
  const check = async (lastWorkDate: string) => {
    const path = `${slotKey(exitEmployees, employeeId)}/preview`;
    const raw = await api.request<unknown>(path, { method: 'POST', command: newCommand({ lastWorkDate }) });
    const result = { lastWorkDate, notice: previewNotice(parsePreview(raw, lastWorkDate)) };
    setChecked(result);
    return result;
  };
  return { checked, check, reset: () => setChecked(undefined) };
}

function ExitEditor({ mode, employee, onDone, onClose, opening, read }: EditorProps) {
  const employeeId = employee.value;
  const permission = usePermissions(object).snapshot.objects[object];
  const editable = editableFields(permission, 'create');
  const [form] = Form.useForm();
  const black = Form.useWatch('addToBlacklist', form) === true;
  const [baseline] = useState(() => opening.values);
  const target = { id: employeeId, revision: opening.revision, baseline, read };
  const cmd = useExitCommand(exitEmployees, target, mode, onDone);
  useDraftRefill(cmd.form, editable, form);
  const preview = usePreview(employeeId);
  const locked = cmd.disabled || !permission?.dataOperations.create;
  const { error, submit } = useFormSubmit(
    locked,
    async () => {
      const values = projectFields(await form.validateFields(), editable);
      validateExit(values, editable);
      const lastWorkDate = String(values.lastWorkDate);
      // 首次点击或改了最后工作日：先检查，展示提示后由用户再点一次提交
      if (preview.checked?.lastWorkDate !== lastWorkDate) return void (await preview.check(lastWorkDate));
      const { notice } = preview.checked;
      if (notice.blockers.length) return false;
      const ack: Values = notice.ackToken ? { pendingTransferAck: notice.ackToken } : {};
      return cmd.submit(values, editable, {
        path: slotKey(exitEmployees, employeeId),
        method: 'POST',
        body: (merged, confirm) => createBody(merged, mode, { ...ack, ...confirm }),
        accept: (raw, sent) => ({
          path: employeePath(employeeId),
          id: employeeId,
          revision: acceptExit(raw, { employeeId, sent: Number(sent) }).revision,
        }),
        // F-240：超上限时后端不给令牌，不进确认循环
        confirmable: !notice.tooMany,
      });
    },
    onClose,
  );
  const notice = preview.checked?.notice;
  return (
    <CommandModal
      title={x.entries[mode]}
      cmd={cmd}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      locked={locked}
      submitLabel={notice?.label ?? x.submit}
      submitDisabled={!!notice?.blockers.length}
      before={
        <>
          <p>
            {x.employee}：{employee.label}
          </p>
          {notice && <PreviewNotice notice={notice} />}
        </>
      }
    >
      <Form
        form={form}
        layout="vertical"
        disabled={locked}
        initialValues={baseline}
        onValuesChange={(changed: Values) => 'lastWorkDate' in changed && preview.reset()}
      >
        <ExitFields editable={editable} permission={permission} black={black} />
      </Form>
    </CommandModal>
  );
}

function PreviewNotice({ notice }: { notice: ReturnType<typeof previewNotice> }) {
  if (notice.blockers.length)
    return <Alert type="error" showIcon message={x.blocked} description={notice.blockers.join('；')} />;
  const lines = [...notice.messages, ...(notice.ackToken ? [x.ackHint] : [])];
  return (
    <Alert
      type={notice.tooMany ? 'error' : 'warning'}
      showIcon
      message={x.previewTitle}
      description={lines.length ? lines.map((line) => <div key={line}>{line}</div>) : x.noWarning}
    />
  );
}
