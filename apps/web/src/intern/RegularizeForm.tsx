import { Alert, Button, Descriptions, Form, Modal, Radio, Select, Space, message } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NameOf, RefSelect } from '../contracts/references.js';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { PageState } from '../foundation/PageState.js';
import { refPaths } from '../part-time/references.js';
import type { Latest } from '../foundation/forms/store.js';
import {
  employeePath,
  useEmployeeRead,
  useInternCommand,
  useInternDraft,
  useOpening,
  type ApplicationDraft,
} from './commands.js';
import { m } from './messages.js';
import {
  acceptBusiness,
  applicationBody,
  businesses,
  controlFields,
  editableFields,
  formFields,
  interns,
  monthOptions,
  object,
  openingValues,
  probationChanges,
  regularizeFieldErrors,
  regularizeBody,
  validateRegularize,
  type Row,
} from './model.js';

export interface FormProps {
  row: Row;
  application?: boolean;
  onClose(): void;
  /** 写入与写后读取都已确认：关闭表单与详情（列表已在提交完成路径里刷新，补证 R2d 换视图）。 */
  onDone(): void;
  /** 写后刷新当前视图；失败按结果未知锁定（commands.tsx settle）。 */
  refresh(applicationId?: string): Promise<unknown>;
}
const kind = 'intern_regularization';

/** 直接转正与申请共用 R2f1 五区、试用期推算和校验（DEC-647 / DEC-431①）。 */
export function RegularizeForm(props: FormProps) {
  const read = useEmployeeRead(props.row.employeeId!, openingValues, true);
  return (
    <WithOpening read={read} title={props.application ? m.entries.apply : m.entries.regularize} onClose={props.onClose}>
      {(opening) => <RegularizeEditor {...props} opening={opening} read={read} />}
    </WithOpening>
  );
}

/** 基线读到之前只显示加载 / 错误（可重试），不拿空值或列表行冒充打开基线。 */
export function WithOpening({
  read,
  title,
  onClose,
  children,
}: {
  read(): Promise<Latest>;
  title: string;
  onClose(): void;
  children(opening: Latest): ReactNode;
}) {
  const opening = useOpening(read);
  if (opening.data) return <>{children(opening.data)}</>;
  return (
    <Modal open title={title} footer={null} onCancel={onClose}>
      <PageState kind={opening.error ? 'error' : 'loading'} error={opening.error} retry={opening.retry} />
    </Modal>
  );
}

type EditorProps = FormProps & { opening: Latest; read(): Promise<Latest> };
function useRegularizeRead(employeeId: string, draft: ApplicationDraft | undefined, read: () => Promise<Latest>) {
  const api = useApiClient();
  return async (): Promise<Latest> => {
    if (!draft) return read();
    const latest = await api.request<Values>(slotKey(businesses, draft.id));
    if (latest.id !== draft.id || latest.employeeId !== employeeId || !Number.isSafeInteger(latest.revision))
      throw new Error(m.invalidReceipt);
    return {
      id: employeeId,
      revision: Number(latest.revision),
      values: {
        // 当前详情不返回试用期控制项，不能把本地输入冒充最新值（#486 待决定）。
        ...projectFields(
          latest.fields as Values | undefined,
          formFields.filter((field) => !controlFields.includes(field) && field !== 'effectiveDate'),
        ),
        effectiveDate: latest.effectiveDate ?? null,
      },
    };
  };
}

function useRejectedRead(read: () => Promise<Latest>, refresh: FormProps['refresh']) {
  const [readError, setReadError] = useState(false);
  const [reading, setReading] = useState(false);
  const reread = async () => {
    setReading(true);
    try {
      await read();
      await refresh();
      setReadError(false);
    } catch {
      setReadError(true);
    } finally {
      setReading(false);
    }
  };
  return { readError, reading, reread };
}

function useRegularize({ row, application, onDone, refresh, opening, read }: EditorProps) {
  const employeeId = row.employeeId!;
  const saved = useInternDraft(employeeId);
  const draft = application ? saved.draft : undefined;
  const autoSubmit = useRef(false);
  const permissions = usePermissions(object);
  const permission = permissions.snapshot.objects[object];
  const editable = editableFields(formFields, permission);
  const [form] = Form.useForm();
  const [baseline] = useState(() => draft?.values ?? opening.values);
  const readCurrent = useRegularizeRead(employeeId, draft, read);
  const target = { id: employeeId, revision: draft?.revision ?? opening.revision, baseline, read: readCurrent };
  const cmd = useInternCommand(interns, target, application ? 'apply' : 'regularize', () =>
    application && !draft ? Promise.resolve() : refresh(draft?.id),
  );
  useDraftRefill(cmd.form, editable, form);
  const [error, setError] = useState<unknown>();
  const { readError, reading, reread } = useRejectedRead(readCurrent, refresh);
  const locked =
    cmd.disabled ||
    reading ||
    readError ||
    !permission?.dataOperations.create ||
    !permissions.can('Employment.Create') ||
    (application && (!permission?.dataOperations.update || !permissions.can('Employment.Submit')));
  const submit = async () => {
    if (locked) return;
    setError(undefined);
    try {
      const values = draft?.values ?? projectFields(await form.validateFields(), editable);
      if (!draft) validateRegularize(values, editable);
      let created: { id: string; revision: number; values: Values } | undefined;
      const done = await cmd.submit(draft ? {} : values, draft ? [] : editable, {
        path: draft
          ? `${slotKey(businesses, draft.id)}/submit`
          : application
            ? `${employeePath(employeeId)}/businesses`
            : `${slotKey(interns, employeeId)}/regularize`,
        body: draft ? () => ({}) : application ? applicationBody : regularizeBody,
        accept: (raw, sent) => {
          const receipt = acceptBusiness(raw, { employeeId, kind, sent, id: draft?.id });
          if (application && receipt.mode !== 'application') throw new Error(m.invalidReceipt);
          if (draft) return { path: slotKey(businesses, draft.id), id: draft.id, revision: Number(receipt.revision) };
          if (application) {
            if (receipt.status !== 'draft') throw new Error(m.invalidReceipt);
            created = { id: String(receipt.id), revision: Number(receipt.revision), values };
          }
          return { path: employeePath(employeeId), id: employeeId, revision: Number(receipt.employeeRevision) };
        },
        rejected: reread,
      });
      if (!done) return;
      if (created) {
        autoSubmit.current = true;
        saved.put(created);
        return;
      }
      if (application) saved.put();
      void message.success(application ? m.success.apply : m.success.regularize);
      onDone();
    } catch (cause) {
      form.setFields(regularizeFieldErrors(cause));
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  // 创建已确认才自动进入第二步；重开页面只恢复同一草稿，由用户显式重提。
  useEffect(() => {
    if (autoSubmit.current && draft) {
      autoSubmit.current = false;
      void submit();
    }
  });
  return { form, baseline, permission, editable, cmd, error, locked, submit, draft, readError, reread };
}

function RegularizeEditor(props: EditorProps) {
  const { row, onClose } = props;
  const state = useRegularize(props);
  const { form, baseline, permission, editable, cmd, error, locked, submit, draft, readError, reread } = state;
  const probation = Form.useWatch('probation', form) === true;
  const footer = (
    <Space>
      <Button onClick={onClose} disabled={cmd.form.busy}>
        {m.cancel}
      </Button>
      <Button type="primary" loading={cmd.form.busy} disabled={locked} onClick={() => void submit()}>
        {props.application ? m.submit : m.save}
      </Button>
    </Space>
  );
  const field = (name: string, control: ReactNode, required = false) => (
    <InternField name={name} editable={editable} permission={permission} required={required}>
      {control}
    </InternField>
  );
  return (
    <Modal
      open
      title={props.application ? m.entries.apply : m.entries.regularize}
      width={800}
      footer={footer}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
    >
      <CommandStatus submission={cmd.form} labels={m.labels} />
      {draft && <Alert type="info" message={m.draftCreated} />}
      {readError && <ReadFailure reread={reread} />}
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      <EmployeeSection row={row} />
      <FormLock locked={locked || !!draft}>
        <Form
          form={form}
          layout="vertical"
          disabled={locked || !!draft}
          initialValues={baseline}
          onValuesChange={(changed: Values, all: Values) => form.setFieldsValue(probationChanges(changed, all))}
        >
          <h3>{m.sections.employment}</h3>
          <div className="intern-form-grid">
            {field('effectiveDate', <TenantDatePicker />, true)}
            {field('departmentId', <RefSelect path={refPaths.departmentId!} ariaLabel={m.labels.departmentId} />, true)}
            {field('positionId', <RefSelect path={refPaths.positionId!} ariaLabel={m.labels.positionId} />)}
            {field('probation', <YesNo />, true)}
          </div>
          <h3>{m.sections.probation}</h3>
          {probation && (
            <div className="intern-form-grid">
              {field('probationMonths', <MonthSelect />, true)}
              {field('probationEndDate', <TenantDatePicker />, true)}
            </div>
          )}
          <h3>{m.sections.reporting}</h3>
          <div className="intern-form-grid">
            {field(
              'directManagerId',
              <RefSelect path={refPaths.directManagerId!} ariaLabel={m.labels.directManagerId} />,
            )}
            {field(
              'dottedManagerId',
              <RefSelect path={refPaths.dottedManagerId!} ariaLabel={m.labels.dottedManagerId} />,
            )}
          </div>
          <h3>{m.sections.contract}</h3>
          <Alert type="info" message={m.contractNote} />
        </Form>
      </FormLock>
    </Modal>
  );
}

function ReadFailure({ reread }: { reread(): Promise<void> }) {
  return (
    <Alert type="error" message={m.rereadFailed} action={<Button onClick={() => void reread()}>{m.refresh}</Button>} />
  );
}

export function InternField({
  name,
  editable,
  permission,
  required,
  checked,
  children,
}: {
  name: string;
  editable: readonly string[];
  permission: Parameters<typeof editableFields>[1];
  required?: boolean;
  checked?: boolean;
  children: ReactNode;
}) {
  if (!controlFields.includes(name) && !permission?.viewableFields.includes(name)) return null;
  const label = m.labels[name]!;
  return (
    <Form.Item
      name={name}
      label={label}
      valuePropName={checked ? 'checked' : 'value'}
      rules={required ? [{ required: true, message: m.required(label) }] : []}
    >
      <LockedField disabled={!editable.includes(name)}>{children}</LockedField>
    </Form.Item>
  );
}

function YesNo(props: { value?: boolean; onChange?(value: boolean): void; disabled?: boolean }) {
  return (
    <Radio.Group
      {...props}
      aria-label={m.labels.probation}
      onChange={(event) => props.onChange?.(event.target.value as boolean)}
      options={[
        { value: true, label: m.yes },
        { value: false, label: m.no },
      ]}
    />
  );
}
function MonthSelect(props: { value?: number; onChange?(value: number): void; disabled?: boolean }) {
  return (
    <Select
      {...props}
      aria-label={m.labels.probationMonths}
      options={monthOptions.map((value) => ({ value, label: m.months(value) }))}
    />
  );
}

/** 员工信息区只读带出（列表行里可见的字段）。 */
function EmployeeSection({ row }: { row: Row }) {
  return (
    <>
      <h3>{m.sections.employee}</h3>
      <Descriptions
        size="small"
        column={2}
        items={[
          { key: 'name', label: m.fields.name, children: row.name ?? m.missing },
          { key: 'code', label: m.fields.code, children: row.code ?? m.missing },
          {
            key: 'departmentId',
            label: m.fields.departmentId,
            children: <NameOf path={refPaths.departmentId!} id={row.departmentId} />,
          },
          { key: 'entryDate', label: m.fields.entryDate, children: row.entryDate ?? m.missing },
        ]}
      />
    </>
  );
}
