import { Alert, Button, Drawer, Form, Modal, Space, type FormInstance, type FormItemProps } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './client.js';
import { ui } from './messages.js';
import { PermissionField } from './Permissions.js';
import type { FieldAccess } from './permission-model.js';
import { FormLock, LockedField } from './forms/FormLock.js';
import { CommandStatus } from './forms/CommandStatus.js';
import type { CommandForm } from './forms/useCommandForm.js';
import { useSession } from './Session.js';

export interface FormField {
  name: string;
  label: string;
  control: ReactNode;
  access: FieldAccess;
  rules?: FormItemProps['rules'];
  display?: ReactNode;
}
export interface FormGroup {
  title: string;
  fields: FormField[];
}
export interface FormOverlayProps {
  /** 旧入口使用 id:revision；接入内核时只用稳定业务 ID，由内核保留草稿并核对冲突。 */
  recordKey: string;
  submission?: CommandForm;
  title: string;
  open: boolean;
  mode?: 'drawer' | 'modal';
  groups: FormGroup[];
  initialValues?: Record<string, unknown>;
  onSubmit(values: Record<string, unknown>): Promise<void>;
  onClose(): void;
  onRefresh?: () => void;
}
export function FormOverlay(props: FormOverlayProps) {
  const session = useSession();
  return props.open ? (
    <OpenForm key={`${session.tenantId}/${session.identityKey}/${props.recordKey}`} {...props} />
  ) : null;
}
function useSubmission(props: FormOverlayProps, form: FormInstance) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const submit = async (values: Record<string, unknown>) => {
    if (submitting.current || props.submission?.locked) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      // 只提交当前可编辑字段；只读初始值不作为用户输入偷偷带回。
      const editable = props.groups
        .flatMap((group) => group.fields)
        .filter((field) => field.access.visible && field.access.editable)
        .map((field) => field.name);
      await props.onSubmit(Object.fromEntries(Object.entries(values).filter(([name]) => editable.includes(name))));
      if (alive.current) props.onClose();
    } catch (cause) {
      if (!alive.current) return;
      setError(cause);
      if (cause instanceof ApiError) form.setFields(cause.fieldErrors);
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { busy, error, submit };
}
function OpenForm(props: FormOverlayProps) {
  const [form] = Form.useForm();
  const { busy, error, submit } = useSubmission(props, form);
  const submission = props.submission;
  const locked = busy || !!submission?.locked;
  useEffect(() => {
    if (submission?.state?.values) form.setFieldsValue(submission.state.values);
  }, [form, submission?.state?.values]);
  const footer = (
    <Space>
      <Button onClick={props.onClose} disabled={busy}>
        {ui.cancel}
      </Button>
      <Button type="primary" disabled={locked} loading={busy} onClick={() => form.submit()}>
        {ui.save}
      </Button>
    </Space>
  );
  const content = (
    <>
      {submission && <CommandStatus submission={submission} labels={formLabels(props.groups)} />}
      {!!error && (!submission || !submission.state?.error) && (
        <Alert
          type="error"
          showIcon
          message={error instanceof ApiError ? error.message : ui.uncertain}
          action={
            error instanceof ApiError && error.kind === 'refresh' && props.onRefresh ? (
              <Button onClick={props.onRefresh}>{ui.refreshAction}</Button>
            ) : undefined
          }
        />
      )}
      <FormLock locked={locked}>
        <Form
          form={form}
          layout="vertical"
          initialValues={props.initialValues}
          onFinish={submit}
          disabled={locked || undefined}
        >
          <FormGroups
            groups={props.groups}
            values={submission?.state?.latest?.values ?? props.initialValues}
            mode={props.mode}
          />
        </Form>
      </FormLock>
    </>
  );
  return props.mode === 'modal' ? (
    <Modal
      open
      width={800}
      title={props.title}
      onCancel={props.onClose}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      footer={footer}
    >
      {content}
    </Modal>
  ) : (
    <Drawer
      open
      rootClassName="form-overlay"
      title={props.title}
      width={560}
      onClose={props.onClose}
      closable={busy ? false : { placement: 'end' }}
      maskClosable={!busy}
      keyboard={!busy}
      footer={footer}
    >
      {content}
    </Drawer>
  );
}

function FormGroups(props: Pick<FormOverlayProps, 'groups' | 'mode'> & { values?: Record<string, unknown> }) {
  return (
    <>
      {props.groups.map((group) => (
        <section key={group.title}>
          <h2 className="form-group-title">{group.title}</h2>
          <div className={props.mode === 'modal' ? 'form-fields-modal' : undefined}>
            {group.fields
              .filter((field) => field.access.visible)
              .map((field) =>
                field.access.editable ? (
                  <Form.Item key={field.name} name={field.name} label={field.label} rules={field.rules}>
                    <LockedField>{field.control}</LockedField>
                  </Form.Item>
                ) : (
                  <Form.Item key={field.name} label={field.label}>
                    <PermissionField
                      access={field.access}
                      value={field.display ?? String(props.values?.[field.name] ?? '—')}
                    >
                      {field.control}
                    </PermissionField>
                  </Form.Item>
                ),
              )}
          </div>
        </section>
      ))}
    </>
  );
}

function formLabels(groups: FormGroup[]) {
  return Object.fromEntries(
    groups
      .flatMap((g) => g.fields)
      .filter((f) => f.access.visible)
      .map((f) => [f.name, f.label]),
  );
}
