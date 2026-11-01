import { Alert, Button, Checkbox, Descriptions, Form, Modal, Space, message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { WithOpening } from '../intern/RegularizeForm.js';
import { employeePath, useEmployeeRead } from '../intern/commands.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { refPaths } from '../part-time/references.js';
import { useRetireCommand } from './commands.js';
import { draftFields, type RetireDraft, type RetireDrafts, useRetireDraft } from './draft.js';
import { m } from './messages.js';
import {
  acceptRetirement,
  apiRoot,
  cellValue,
  differs,
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
  const drafts = useRetireDraft(props.row.employeeId!);
  const application = props.mode === 'application';
  const { resume } = drafts;
  // 申请先经草稿入口接续：缓存的草稿读到仍可提交才接续，否则清掉、读员工走新建
  const start = useCallback(() => (application ? resume(read) : read()), [application, resume, read]);
  const title = application ? m.entries.apply : m.entries.retire;
  return (
    <WithOpening read={start} title={title} onClose={props.onClose}>
      {(latest) => <RetireEditor {...props} opening={latest} read={read} drafts={drafts} />}
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

type EditorProps = FormProps & { opening: Latest; read(): Promise<Latest>; drafts: RetireDrafts };
type Draft = RetireDraft;
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
      // 只有申请走草稿两步：新建应为草稿、提交后应为审批中；直接办理的状态随生效日而定，不核
      const status = draft ? 'in_review' : 'draft';
      // 方式 / 状态可按字段权裁剪：缺键不核，在场不符拒绝（第 2 轮 P2-1）
      if (differs(receipt, 'mode', mode) || (mode === 'application' && differs(receipt, 'status', status)))
        throw new Error(m.invalidReceipt);
      if (draft) return { path: slotKey(businesses, draft.id), id: draft.id, revision: Number(receipt.revision) };
      if (mode === 'application') onCreated({ id: String(receipt.id), revision: Number(receipt.revision), values: {} });
      // 员工 revision 被裁剪时，写后回读员工 revision 不低于提交值 + 1 即确认
      const employeeRevision = Number(receipt.employeeRevision ?? sent + 1);
      return { path: employeePath(employeeId), id: employeeId, revision: employeeRevision };
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

function useRetire(props: EditorProps, editable: string[], writable: boolean) {
  const { row, mode, onDone, refresh, opening, read, drafts } = props;
  const employeeId = row.employeeId!;
  const [form] = Form.useForm();
  // 申请两步：草稿创建确认后，同一恢复槽、同一动作按草稿 revision 自动提交（结构同 intern RegularizeForm）；
  // 草稿的接续 / 重读 / 清理只经 useRetireDraft（第 3 轮，DEC-431①），关闭重开仍接同一草稿，第二步失败不重建
  const draft = mode === 'application' ? drafts.draft : undefined;
  const baseline = draft?.values ?? opening.values;
  const autoSubmit = useRef(false);
  const revision = draft?.revision ?? opening.revision;
  // 第二步重读真实草稿（GET /retirements/:id）：revision 与核对字段都取服务端当前值
  const target = { id: employeeId, revision, baseline, read: draft ? drafts.read : read };
  const cmd = useRetireCommand(retireSlot, target, mode, refresh);
  // 第二步不写字段：写入字段集为空，冲突重读后表单整份回填为最新只读值（核对字段另传给内核）
  useDraftRefill(cmd.form, draft ? [] : editable, form);
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
      // 第二步：核对字段取表单当前值（冲突后已回填为最新），只用于差异比较，请求体仍为空
      const values = draft
        ? projectFields(form.getFieldsValue(true) as Values, draftFields)
        : projectFields(await form.validateFields(), editable);
      let created: Draft | undefined;
      const send = retireSend(row, mode, draft, (next) => (created = { ...next, values }));
      // 预览令牌作为初始确认项随单提交（两种办理方式新建时都核令牌，exit-gate.ts createConditions）
      const ack = (preview?.data.ack as { ackToken?: string } | null | undefined)?.ackToken;
      if (!(await cmd.submit(values, draft ? draftFields : editable, send, draft ? {} : { ack }))) return;
      if (created) {
        autoSubmit.current = true;
        return drafts.created(created);
      }
      if (draft) drafts.settle(draft.id);
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
