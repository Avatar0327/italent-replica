import { Alert, Button, Checkbox, Descriptions, Form, Modal, Space, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { RefSelect } from '../contracts/references.js';
import { newCommand, rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import type { Latest } from '../foundation/forms/store.js';
import { employeePath, useEmployeeRead } from '../intern/commands.js';
import { WithOpening } from '../intern/RegularizeForm.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { refPaths } from '../part-time/references.js';
import { useRetireCommand } from './commands.js';
import { m } from './messages.js';
import {
  acceptRetirement,
  apiRoot,
  cellValue,
  object,
  previewNotices,
  retireBody,
  retireSlot,
  retirements,
  type Extra,
  type Row,
} from './model.js';

export interface FormProps {
  row: Row;
  mode: 'direct' | 'application';
  onClose(): void;
  /** 写入与本单回读已确认：关闭表单与详情。 */
  onDone(): void;
  refresh(): Promise<unknown>;
}
const people = refPaths.directManagerId!;
const businesses = `${apiRoot}/businesses`;
const dutyFields = ['dutyReceiverId', 'dutySubordinateIds', 'transferDepartmentHead'];
const opening = (): Values => ({
  lastWorkDate: null,
  handoverEmployeeId: null,
  dutyReceiverId: null,
  dutySubordinateIds: [],
  transferDepartmentHead: false,
});

/** 退休办理（B22，含职责转交区）与退休申请（B23，无职责转交区）共用：先预览，再以同一命令上下文提交。 */
export function RetireForm(props: FormProps) {
  const read = useEmployeeRead(props.row.employeeId!, opening, false);
  const title = props.mode === 'direct' ? m.entries.retire : m.entries.apply;
  return (
    <WithOpening read={read} title={title} onClose={props.onClose}>
      {(latest) => <RetireEditor {...props} opening={latest} read={read} />}
    </WithOpening>
  );
}

interface Preview {
  lastWorkDate: string;
  data: Values;
}
function usePreview(employeeId: string) {
  const direct = useDirectApi();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const run = async (lastWorkDate: unknown) => {
    if (typeof lastWorkDate !== 'string' || !lastWorkDate)
      return setError(new Error(m.required(m.fields.lastWorkDate!)));
    setLoading(true);
    setError(undefined);
    try {
      const path = `${slotKey(retireSlot, employeeId)}/preview`;
      setPreview({ lastWorkDate, data: await direct(path, 'POST', newCommand({ lastWorkDate })) });
    } catch (cause) {
      setPreview(undefined);
      setError(cause);
    } finally {
      setLoading(false);
    }
  };
  return { preview, error, loading, run };
}

type EditorProps = FormProps & { opening: Latest; read(): Promise<Latest> };
type Draft = { id: string; revision: number };
/**
 * 新建（POST /retirements/employees/:id，If-Match = 员工 revision）或申请第二步提交草稿（If-Match = 草稿 revision）。
 * 回执按 EmploymentBusiness 核对；申请新建只建草稿，草稿 id / revision 交 onCreated 进入第二步。
 */
function retireSend(row: Row, mode: FormProps['mode'], draft: Draft | undefined, onCreated: (draft: Draft) => void) {
  const employeeId = row.employeeId!;
  return {
    path: draft ? `${slotKey(retirements, draft.id)}/submit` : slotKey(retireSlot, employeeId),
    body: draft
      ? (_: Values, extra: Extra) => (extra.ack ? { pendingTransferAck: extra.ack } : {})
      : (input: Values, extra: Extra) => retireBody(input, mode, row.departmentId, extra),
    accept: (raw: Values, sent: number) => {
      const receipt = acceptRetirement(raw, { employeeId, sent, id: draft?.id });
      const status = draft ? 'in_review' : mode === 'application' ? 'draft' : undefined;
      if (receipt.mode !== mode || (status && receipt.status !== status)) throw new Error(m.invalidReceipt);
      if (draft) return { path: slotKey(businesses, draft.id), id: draft.id, revision: Number(receipt.revision) };
      if (mode === 'application') onCreated({ id: String(receipt.id), revision: Number(receipt.revision) });
      return { path: employeePath(employeeId), id: employeeId, revision: Number(receipt.employeeRevision) };
    },
  };
}

/** 可提交字段：最后工作日 / 交接人按字段权；职责转交区是控制项（exit-gate.ts EXIT_CONTROL_KEYS），随“新增”可写。 */
function useEditable(mode: FormProps['mode']) {
  const permission = usePermissions(object).snapshot.objects[object];
  const create = !!permission?.dataOperations.create;
  const may = (field: string) => create && !!permission?.editableFields.includes(field);
  const editable = [
    ...['lastWorkDate', 'handoverEmployeeId'].filter(may),
    ...(mode === 'direct' && create ? dutyFields : []),
  ];
  return { permission, editable, writable: may('lastWorkDate') };
}

function useRetire({ row, mode, onDone, refresh, opening, read }: EditorProps, editable: string[], writable: boolean) {
  const employeeId = row.employeeId!;
  const [form] = Form.useForm();
  const [baseline] = useState(() => opening.values);
  // 申请两步：草稿创建确认后，同一恢复槽、同一动作按草稿 revision 自动提交（结构同 intern RegularizeForm）
  const [draft, setDraft] = useState<Draft>();
  const autoSubmit = useRef(false);
  const draftRead = async (): Promise<Latest> => ({ ...(await read()), revision: draft?.revision ?? -1 });
  const revision = draft?.revision ?? opening.revision;
  const cmd = useRetireCommand(
    retireSlot,
    { id: employeeId, revision, baseline, read: draft ? draftRead : read },
    mode,
    refresh,
  );
  useDraftRefill(cmd.form, editable, form);
  const previewing = usePreview(employeeId);
  const lastWorkDate = Form.useWatch('lastWorkDate', form) as string | null | undefined;
  const preview = previewing.preview?.lastWorkDate === lastWorkDate ? previewing.preview : undefined;
  const notices = preview ? previewNotices(preview.data) : undefined;
  const [error, setError] = useState<unknown>();
  const locked = cmd.disabled || !writable;
  const ready = !!draft || (!!notices && notices.blockers.length === 0);
  const submit = async () => {
    if (locked || !ready) return;
    setError(undefined);
    try {
      const values = projectFields(draft ? form.getFieldsValue(true) : await form.validateFields(), editable);
      let created: Draft | undefined;
      const send = retireSend(row, mode, draft, (next) => (created = next));
      // 预览令牌作为初始确认项随单提交（两种办理方式新建时都核令牌，exit-gate.ts createConditions）
      const ack = (preview?.data.ack as { ackToken?: string } | null | undefined)?.ackToken;
      if (!(await cmd.submit(values, editable, send, draft ? {} : { ack }))) return;
      if (created) {
        autoSubmit.current = true;
        return setDraft(created);
      }
      void message.success(m.success[mode === 'direct' ? 'retire' : 'apply']);
      onDone();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  // 创建已确认才自动进入第二步；失败时草稿留在“全部退休记录”，由用户显式提交
  useEffect(() => {
    if (autoSubmit.current && draft) {
      autoSubmit.current = false;
      void submit();
    }
  });
  return { form, baseline, cmd, error, locked, ready, submit, draft, previewing, preview, notices };
}

function RetireEditor(props: EditorProps) {
  const { row, mode, onClose } = props;
  const { permission, editable, writable } = useEditable(mode);
  const { form, baseline, cmd, error, locked, ready, submit, draft, previewing, preview, notices } = useRetire(
    props,
    editable,
    writable,
  );
  const visible = (field: string) => !!permission?.viewableFields.includes(field);
  return (
    <Modal
      open
      width={720}
      title={mode === 'direct' ? m.entries.retire : m.entries.apply}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose} disabled={cmd.form.busy}>
            {m.cancel}
          </Button>
          <Button
            disabled={locked || !!draft}
            loading={previewing.loading}
            onClick={() => void previewing.run(form.getFieldValue('lastWorkDate'))}
          >
            {m.preview}
          </Button>
          <Button type="primary" loading={cmd.form.busy} disabled={locked || !ready} onClick={() => void submit()}>
            {m.submit}
          </Button>
        </Space>
      }
    >
      <CommandStatus submission={cmd.form} labels={m.fields} />
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      {!!draft && <Alert type="info" message={m.draftCreated} />}
      <FormLock locked={locked || !!draft}>
        <Form form={form} layout="vertical" disabled={locked || !!draft} initialValues={baseline}>
          <Form.Item
            name="lastWorkDate"
            label={m.fields.lastWorkDate}
            rules={[{ required: true, message: m.required(m.fields.lastWorkDate!) }]}
          >
            <LockedField disabled={!editable.includes('lastWorkDate')}>
              <TenantDatePicker />
            </LockedField>
          </Form.Item>
          {visible('handoverEmployeeId') && (
            <Form.Item name="handoverEmployeeId" label={m.fields.handoverEmployeeId}>
              <LockedField disabled={!editable.includes('handoverEmployeeId')}>
                <RefSelect path={people} ariaLabel={m.fields.handoverEmployeeId} />
              </LockedField>
            </Form.Item>
          )}
          {mode === 'direct' && <DutySection editable={editable} departmentId={row.departmentId} />}
        </Form>
      </FormLock>
      {previewing.error ? <Alert type="error" showIcon message={rejectionMessage(previewing.error)} /> : null}
      {!draft && !preview && <Alert type="info" message={previewing.preview ? m.previewStale : m.previewNeeded} />}
      {preview && notices && <PreviewPanel data={preview.data} notices={notices} />}
    </Modal>
  );
}

function DutySection({ editable, departmentId }: { editable: readonly string[]; departmentId: unknown }) {
  const disabled = !editable.includes('dutyReceiverId');
  return (
    <section aria-label={m.duty.title}>
      <h3>{m.duty.title}</h3>
      <Form.Item name="dutyReceiverId" label={m.duty.receiver}>
        <LockedField disabled={disabled}>
          <RefSelect path={people} ariaLabel={m.duty.receiver} />
        </LockedField>
      </Form.Item>
      <Form.Item name="dutySubordinateIds" label={m.duty.subordinates}>
        <LockedField disabled={disabled}>
          <RefSelect path={people} multiple ariaLabel={m.duty.subordinates} />
        </LockedField>
      </Form.Item>
      {typeof departmentId === 'string' && departmentId && (
        <Form.Item name="transferDepartmentHead" valuePropName="checked">
          <LockedField disabled={disabled}>
            <Checkbox>{m.duty.departmentHead}</Checkbox>
          </LockedField>
        </Form.Item>
      )}
      <p className="retirement-note">{m.duty.note}</p>
    </section>
  );
}

const previewFields = ['effectiveDate', 'expectedRetirementDate', 'retireType'];
function PreviewPanel({ data, notices }: { data: Row; notices: ReturnType<typeof previewNotices> }) {
  const lists = [
    ['blockers', 'error'],
    ['warnings', 'warning'],
  ] as const;
  return (
    <section aria-label={m.previewTitle} className="retirement-preview">
      <Descriptions
        title={m.previewTitle}
        size="small"
        column={2}
        items={previewFields.map((key) => ({ key, label: m.fields[key], children: cellValue(data, key) }))}
      />
      {lists.map(([kind, type]) =>
        notices[kind].length ? (
          <Alert key={kind} type={type} message={m[kind]} description={<NoticeList notices={notices[kind]} />} />
        ) : null,
      )}
      {!!data.ack && <Alert type="warning" message={m.ackNote} />}
    </section>
  );
}
function NoticeList({ notices }: { notices: ReturnType<typeof previewNotices>['blockers'] }) {
  return (
    <ul>
      {notices.map((notice) => (
        <li key={notice.reason}>
          {m.notices[notice.reason] ?? notice.reason}
          {notice.count === undefined ? '' : `：${m.count(notice.count)}`}
        </li>
      ))}
    </ul>
  );
}
