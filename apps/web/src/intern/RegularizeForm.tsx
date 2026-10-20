import { expectedProbationEndDate } from '@italent/domain';
import { Alert, Button, Descriptions, Form, Modal, Radio, Select, Space, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { NameOf, RefSelect } from '../contracts/references.js';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { PageState } from '../foundation/PageState.js';
import { refPaths } from '../part-time/references.js';
import { useRead } from '../part-time/useRead.js';
import { employeePath, useDrafts, useInternCommand, useLatest, type Draft } from './commands.js';
import { m } from './messages.js';
import {
  acceptBusiness,
  applicationBody,
  businesses,
  editableFields,
  formFields,
  interns,
  monthOptions,
  object,
  regularizeBody,
  validateRegularize,
  type Row,
} from './model.js';

export interface FormProps {
  row: Row;
  onClose(): void;
  /** 写入已确认：关闭表单与详情、刷新当前视图（成功后人员换视图，补证 R2d）。 */
  onDone(): Promise<void>;
}
const kind = 'intern_regularization';

/** 直接“实习转正”与“实习转正申请”共用任职 / 试用期部分（补证 R2f1 五区）；申请建好草稿后转为“提交草稿”。 */
export function RegularizeForm({ application, ...props }: FormProps & { application: boolean }) {
  const { drafts } = useDrafts();
  const draft = application ? drafts[props.row.employeeId!] : undefined;
  return draft ? <DraftSubmit {...props} draft={draft} /> : <RegularizeEditor {...props} application={application} />;
}

function useRegularize({ row, onDone, application }: FormProps & { application: boolean }) {
  const employeeId = row.employeeId!;
  const employee = useRead<Values>(employeePath(employeeId));
  const permissions = usePermissions(object);
  const permission = permissions.snapshot.objects[object];
  const fields = formFields(application);
  const editable = editableFields(fields, permission);
  const { setDraft } = useDrafts();
  const [form] = Form.useForm();
  const [baseline] = useState(() => projectFields({}, fields));
  const read = useLatest(employeePath(employeeId), baseline);
  const revision = employee.data?.revision as number | undefined;
  const cmd = useInternCommand(
    interns,
    { id: employeeId, revision, baseline, read },
    application ? 'apply' : 'regularize',
  );
  useDraftRefill(cmd.form, editable, form);
  const [error, setError] = useState<unknown>();
  const locked = cmd.disabled || !permission?.dataOperations.create;
  const submit = async () => {
    if (locked) return;
    setError(undefined);
    try {
      const values = projectFields(await form.validateFields(), editable);
      validateRegularize(values, editable, application);
      let created: Draft | undefined;
      await cmd.submit(values, editable, {
        path: application ? `${employeePath(employeeId)}/businesses` : `${interns}/${employeeId}/regularize`,
        body: application ? applicationBody : regularizeBody,
        accept: (raw, sent) => {
          const receipt = acceptBusiness(raw, { employeeId, kind, sent });
          created = { id: String(receipt.id), revision: Number(receipt.revision) };
        },
      });
      if (application && created) {
        setDraft(employeeId, created);
        void message.success(m.draftSaved);
        return;
      }
      void message.success(m.success.regularize);
      await onDone();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  return { form, employee, permission, editable, cmd, error, locked, submit };
}

function RegularizeEditor(props: FormProps & { application: boolean }) {
  const { row, onClose, application } = props;
  const state = useRegularize(props);
  const { form, employee, permission, editable, cmd, error, locked, submit } = state;
  const probation = Form.useWatch('probation', form) === true;
  const footer = (
    <Space>
      <Button onClick={onClose} disabled={cmd.form.busy}>
        {m.cancel}
      </Button>
      <Button type="primary" loading={cmd.form.busy} disabled={locked} onClick={() => void submit()}>
        {application ? m.saveDraft : m.save}
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
      title={application ? m.entries.apply : m.entries.regularize}
      width={800}
      footer={footer}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
    >
      {!employee.data && <PageState kind={employee.error ? 'error' : 'loading'} error={employee.error} />}
      <CommandStatus submission={cmd.form} labels={m.labels} />
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      <EmployeeSection row={row} />
      <FormLock locked={locked}>
        <Form
          form={form}
          layout="vertical"
          disabled={locked}
          initialValues={{ departmentId: row.departmentId ?? null, ...(application ? {} : { probation: true }) }}
          onValuesChange={(changed: Values, all: Values) => fillProbationEnd(form, changed, all)}
        >
          <h3>{m.sections.employment}</h3>
          <div className="intern-form-grid">
            {field('effectiveDate', <TenantDatePicker />, true)}
            {field('departmentId', <RefSelect path={refPaths.departmentId!} ariaLabel={m.labels.departmentId} />, true)}
            {field('positionId', <RefSelect path={refPaths.positionId!} ariaLabel={m.labels.positionId} />)}
            {!application && field('probation', <YesNo />, true)}
          </div>
          <h3>{m.sections.probation}</h3>
          {application ? (
            <Alert type="info" message={m.applicationProbationNote} />
          ) : (
            probation && (
              <div className="intern-form-grid">
                {field('probationMonths', <MonthSelect />, true)}
                {field('probationEndDate', <TenantDatePicker />, true)}
              </div>
            )
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

/** 预计试用结束日期按“转正日 + 月数”自动算（与后端 expectedProbationEndDate 同一函数），可手改；关掉试用期时清空。 */
function fillProbationEnd(form: { setFieldsValue(values: Values): void }, changed: Values, all: Values) {
  if (changed.probation === false) form.setFieldsValue({ probationMonths: null, probationEndDate: null });
  if (!('effectiveDate' in changed || 'probationMonths' in changed)) return;
  const { effectiveDate, probationMonths } = all;
  if (all.probation === true && typeof effectiveDate === 'string' && typeof probationMonths === 'number')
    form.setFieldsValue({ probationEndDate: expectedProbationEndDate(effectiveDate, probationMonths) });
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
  const control = !['probation', 'probationMonths', 'probationEndDate', 'endDate', 'cancelPendingEntry'].includes(name);
  if (control && !permission?.viewableFields.includes(name)) return null;
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

/** 申请草稿已建好：提交走 POST /businesses/:id/submit（空体），草稿 revision 作 If-Match。 */
function DraftSubmit({ row, draft, onClose, onDone }: FormProps & { draft: Draft }) {
  const employeeId = row.employeeId!;
  const { setDraft } = useDrafts();
  const permissions = usePermissions(object);
  const allowed = !!permissions.snapshot.objects[object]?.dataOperations.update && permissions.can('Employment.Submit');
  const read = useLatest(`${businesses}/${draft.id}`, {});
  const cmd = useInternCommand(businesses, { id: draft.id, revision: draft.revision, baseline: {}, read }, 'submit');
  const locked = cmd.disabled || !allowed;
  const submit = async () => {
    if (locked) return;
    try {
      await cmd.submit({}, [], {
        path: `${businesses}/${draft.id}/submit`,
        body: () => ({}),
        accept: (raw, sent) => acceptBusiness(raw, { employeeId, kind, sent, id: draft.id }),
      });
      setDraft(employeeId, undefined);
      void message.success(m.success.apply);
      await onDone();
    } catch {
      // 拒绝 / 冲突 / 结果未知都由内核状态条显示
    }
  };
  return (
    <Modal
      open
      title={m.entries.apply}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose} disabled={cmd.form.busy}>
            {m.cancel}
          </Button>
          <Button type="primary" loading={cmd.form.busy} disabled={locked} onClick={() => void submit()}>
            {m.submitDraft}
          </Button>
        </Space>
      }
    >
      <Alert type="info" showIcon message={allowed ? m.draftSaved : m.denied} />
      <CommandStatus submission={cmd.form} />
    </Modal>
  );
}
