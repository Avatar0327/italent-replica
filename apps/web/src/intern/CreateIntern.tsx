import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { RefSelect, refPaths as contractRefs, useToday } from '../contracts/references.js';
import { object as contractObject } from '../contracts/model.js';
import { rejectionMessage } from '../foundation/client.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { refPaths } from '../part-time/references.js';
import { object, personObject } from './model.js';
import { c } from './create-messages.js';
import { m } from './messages.js';
import { createAccess, docKey, validateCreate, type CreateReceipt } from './create-model.js';
import { RehirePrompt, useRehireCheck } from './RehireCheck.js';
import { useCreateCommand } from './create-command.js';

/** 保持挂在页面根部，关闭弹窗只隐藏；F-123 的页面槽保存未确认命令与草稿。 */
export function CreateIntern({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose(): void;
  onDone(receipt: CreateReceipt): void;
}) {
  const [form] = Form.useForm();
  const person = usePermissions(personObject).snapshot.objects[personObject];
  const employment = usePermissions(object).snapshot.objects[object];
  const contract = usePermissions(contractObject).snapshot.objects[contractObject];
  const access = createAccess(person, employment, contract);
  const today = useToday();
  const date = Form.useWatch('effectiveDate', form) as string | undefined;
  // 此比较仅控制接口允许填写的合同字段；目标视图始终按服务端回执。
  const pending = !!today && !!date && date > today;
  const match = useRehireCheck();
  const cmd = useCreateCommand();
  const [error, setError] = useState<unknown>();
  const selected = match.selected;
  const names = Object.keys(c.labels).filter(
    (name) =>
      !(pending && ['typeId', 'termType', 'termMonths'].includes(name)) &&
      !(selected && ['name', 'code'].includes(name)),
  );
  const editable = names.filter((name) => access.field(name).editable);
  useDraftRefill(cmd.form, editable, form);
  const locked = cmd.form.locked || !access.allowed || !today;
  const check = async () => {
    if (locked) return;
    const values = form.getFieldsValue();
    if (!String(values.idType ?? '').trim() || !String(values.idNumber ?? '').trim()) {
      setError(new Error(c.matchRequired));
      return;
    }
    cmd.form.clear();
    setError(undefined);
    await match.check(values);
  };
  const submit = async () => {
    if (locked || match.busy || match.prompt) return;
    setError(undefined);
    try {
      const all = await form.validateFields();
      const values = projectFields(all, editable);
      if (String(all.idNumber ?? '').trim() && (!match.checked || match.key !== docKey(all)))
        throw new Error(c.matchRequired);
      validateCreate(values, editable, !!selected, pending);
      const receipt = await cmd.submit(values, editable, selected, pending);
      if (!receipt) return;
      match.reset();
      form.resetFields();
      void message.success(c.success);
      onDone(receipt);
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  const field = (name: string, control: ReactNode, required = false) => {
    const permission = access.field(name);
    if (!permission.visible) return null;
    return (
      <Form.Item
        name={name}
        label={c.labels[name]}
        rules={[
          ...(required ? [{ required: true, message: m.required(c.labels[name]!) }] : []),
          ...(name === 'loginEmail' ? [{ type: 'email' as const, message: c.invalidEmail }] : []),
        ]}
      >
        <LockedField disabled={!permission.editable}>{control}</LockedField>
      </Form.Item>
    );
  };
  const input = (name: string, required = false) => field(name, <Input aria-label={c.labels[name]} />, required);
  const ref = (name: string, path: string, required = false) =>
    field(name, <RefSelect path={path} ariaLabel={c.labels[name]} />, required);
  return (
    <>
      <Modal
        open={open}
        forceRender
        title={c.title}
        width={750}
        className="intern-create"
        maskClosable={false}
        closable={!cmd.form.busy}
        keyboard={!cmd.form.busy}
        onCancel={onClose}
        footer={
          <Space>
            <Button disabled={cmd.form.busy} onClick={onClose}>
              {m.cancel}
            </Button>
            <Button
              type="primary"
              disabled={locked || !!match.busy || !!match.prompt}
              loading={cmd.form.busy}
              onClick={() => void submit()}
            >
              {m.save}
            </Button>
          </Space>
        }
      >
        <CommandStatus submission={cmd.form} labels={c.labels} />
        {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
        {!!match.error && <Alert type="error" message={rejectionMessage(match.error)} />}
        {!access.allowed && <Alert type="warning" message={c.denied} />}
        {cmd.form.status === 'unknown' && (
          <Space direction="vertical">
            <Button loading={cmd.query.busy} onClick={() => void cmd.queryResult()}>
              {c.query}
            </Button>
            {cmd.query.message && <Alert type="info" message={cmd.query.message} />}
            {!!cmd.query.error && <Alert type="error" message={rejectionMessage(cmd.query.error)} />}
          </Space>
        )}
        <Alert type="info" message={c.hint} />
        <FormLock locked={locked}>
          <Form
            form={form}
            layout="horizontal"
            disabled={locked}
            initialValues={{ idType: 'id_card' }}
            onValuesChange={(changed: Values) => {
              if ('idType' in changed || 'idNumber' in changed) {
                match.reset();
                cmd.form.clear();
              }
              setError(undefined);
            }}
          >
            <h3>{c.employee}</h3>
            <div className="intern-form-grid">
              {selected ? (
                <Form.Item label={c.labels.name}>{selected.candidate.name ?? '--'}</Form.Item>
              ) : (
                input('name', true)
              )}
              {input('loginEmail', !selected)}
              {input('idType')}
              {input('idNumber')}
            </div>
            <Space>
              <Button disabled={locked || match.busy} loading={match.busy} onClick={() => void check()}>
                {c.match}
              </Button>
              <span>{selected ? c.selected : c.newHire}</span>
              {match.checked && !match.candidate && <span>{c.noMatch}</span>}
            </Space>
            <p>{c.employeeNote}</p>
            <h3>{c.employment}</h3>
            <div className="intern-form-grid">
              {field('effectiveDate', <TenantDatePicker />, true)}
              {selected ? (
                <Form.Item label={c.labels.code}>{selected.candidate.code ?? '--'}</Form.Item>
              ) : (
                input('code', true)
              )}
              {ref('departmentId', refPaths.departmentId!, true)}
              {ref('positionId', refPaths.positionId!)}
            </div>
            <h3>{c.reporting}</h3>
            <div className="intern-form-grid">
              {ref('directManagerId', refPaths.directManagerId!)}
              {ref('dottedManagerId', refPaths.dottedManagerId!)}
            </div>
            <p>{c.managerNote}</p>
            <h3>{c.contract}</h3>
            {pending && <Alert type="info" message={c.pendingNote} />}
            <div className="intern-form-grid">
              {ref('companyId', contractRefs.companyId, !pending)}
              {!pending &&
                field(
                  'termType',
                  <Select
                    allowClear
                    aria-label={c.labels.termType}
                    options={[
                      { value: 'fixed', label: c.fixed },
                      { value: 'task', label: c.task },
                    ]}
                  />,
                )}
              {!pending && ref('typeId', contractRefs.typeId, true)}
              {!pending && field('termMonths', <InputNumber min={1} max={1200} aria-label={c.labels.termMonths} />)}
              {field('endDate', <TenantDatePicker />, true)}
            </div>
          </Form>
        </FormLock>
      </Modal>
      {open && <RehirePrompt match={match} />}
    </>
  );
}
