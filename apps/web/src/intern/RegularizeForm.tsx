import { expectedProbationEndDate } from '@italent/domain';
import { Alert, Button, Descriptions, Form, Modal, Radio, Select, Space, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { NameOf, RefSelect } from '../contracts/references.js';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { PageState } from '../foundation/PageState.js';
import { refPaths } from '../part-time/references.js';
import type { Latest } from '../foundation/forms/store.js';
import { employeePath, useEmployeeRead, useInternCommand, useOpening } from './commands.js';
import { m } from './messages.js';
import {
  acceptBusiness,
  controlFields,
  editableFields,
  formFields,
  interns,
  monthOptions,
  object,
  openingValues,
  regularizeBody,
  validateRegularize,
  type Row,
} from './model.js';

export interface FormProps {
  row: Row;
  onClose(): void;
  /** 写入与写后读取都已确认：关闭表单与详情（列表已在提交完成路径里刷新，补证 R2d 换视图）。 */
  onDone(): void;
  /** 写后刷新当前视图；失败按结果未知锁定（commands.tsx settle）。 */
  refresh(): Promise<unknown>;
}
const kind = 'intern_regularization';

/** 直接“实习转正”（补证 R2f1 五区）。DEC-647：不开放“实习转正申请”，申请表单与试用期区由 F-285 后补。 */
export function RegularizeForm(props: FormProps) {
  const read = useEmployeeRead(props.row.employeeId!, openingValues, true);
  return (
    <WithOpening read={read} title={m.entries.regularize} onClose={props.onClose}>
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
function useRegularize({ row, onDone, refresh, opening, read }: EditorProps) {
  const employeeId = row.employeeId!;
  const permissions = usePermissions(object);
  const permission = permissions.snapshot.objects[object];
  const editable = editableFields(formFields, permission);
  const [form] = Form.useForm();
  const [baseline] = useState(() => opening.values);
  const target = { id: employeeId, revision: opening.revision, baseline, read };
  const cmd = useInternCommand(interns, target, 'regularize', refresh);
  useDraftRefill(cmd.form, editable, form);
  const [error, setError] = useState<unknown>();
  const locked = cmd.disabled || !permission?.dataOperations.create;
  const submit = async () => {
    if (locked) return;
    setError(undefined);
    try {
      const values = projectFields(await form.validateFields(), editable);
      validateRegularize(values, editable);
      const done = await cmd.submit(values, editable, {
        path: `${slotKey(interns, employeeId)}/regularize`,
        body: regularizeBody,
        accept: (raw, sent) => {
          const receipt = acceptBusiness(raw, { employeeId, kind, sent });
          return { path: employeePath(employeeId), id: employeeId, revision: Number(receipt.employeeRevision) };
        },
      });
      if (!done) return;
      void message.success(m.success.regularize);
      onDone();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  return { form, baseline, permission, editable, cmd, error, locked, submit };
}

function RegularizeEditor(props: EditorProps) {
  const { row, onClose } = props;
  const state = useRegularize(props);
  const { form, baseline, permission, editable, cmd, error, locked, submit } = state;
  const probation = Form.useWatch('probation', form) === true;
  const footer = (
    <Space>
      <Button onClick={onClose} disabled={cmd.form.busy}>
        {m.cancel}
      </Button>
      <Button type="primary" loading={cmd.form.busy} disabled={locked} onClick={() => void submit()}>
        {m.save}
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
      title={m.entries.regularize}
      width={800}
      footer={footer}
      onCancel={onClose}
      closable={!cmd.form.busy}
      maskClosable={false}
    >
      <CommandStatus submission={cmd.form} labels={m.labels} />
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      <EmployeeSection row={row} />
      <FormLock locked={locked}>
        <Form
          form={form}
          layout="vertical"
          disabled={locked}
          initialValues={baseline}
          onValuesChange={(changed: Values, all: Values) => fillProbationEnd(form, changed, all)}
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
