import { Alert, Button, Drawer, Form, Space, Steps } from 'antd';
import { useState } from 'react';
import { checkActivityChains, type ChainDraft } from '@italent/domain';
import { usePermissions } from '../foundation/Permissions.js';
import { ApiError } from '../foundation/client.js';
import { ActivityControl, Chains, Conditions, editableChains, EV } from './ActivityFields.js';
import { useRecordForm } from './useRecordForm.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { evaluationPatch, records, validateDates, validateConditions, type Row } from './model.js';
import { m, textValue } from './messages.js';
export const EVALUATION = 'TEvaluation.EvaluationActivity';
const groups = [
  [
    'name',
    'typeId',
    'ownerOrgId',
    'year',
    'cycleId',
    'managerEmployeeId',
    'startDate',
    'endDate',
    'effectiveDate',
    'applicants',
    'orgRange',
    'categoryIds',
    'levelIds',
    'maxLevelJump',
    'noticeOrgRange',
  ],
  ['conditions'],
  ['chains'],
];
const required = [
  'name',
  'typeId',
  'cycleId',
  'ownerOrgId',
  'year',
  'managerEmployeeId',
  'effectiveDate',
  'applicants',
  'orgRange',
  'categoryIds',
  'levelIds',
  'chains',
];
interface WizardProps {
  row?: Row;
  close(): void;
  saved(): void;
}
function useWizard({ row, close, saved }: WizardProps) {
  const permission = usePermissions(EVALUATION);
  const [step, setStep] = useState(0);
  const [form] = Form.useForm();
  const writer = useRecordForm(`${EV}/activities`, row);
  const current = writer.current;
  const locked = !!current && current.applyCount !== 0;
  const field = (key: string) => {
    const access = permission.field(key);
    return {
      ...access,
      editable:
        access.editable &&
        current?.status !== 'completed' &&
        !(locked && ['typeId', 'orgRange', 'categoryIds', 'levelIds', 'effectiveDate', 'noticeOrgRange'].includes(key)),
    };
  };
  // 重读后按内核 refillDraft 回填（F-142）：只有改过且当前可提交的字段保留草稿，其余取最新记录。
  useDraftRefill(
    writer,
    groups.flat().filter((key) => field(key).editable),
    form,
  );
  const initial = row ?? {
    maxLevelJump: 1,
    applicants: [],
    orgRange: [],
    conditions: [],
    chains: [
      { type: 'apply', name: m.apply, transferMode: 'auto' },
      { type: 'result', name: m.result, transferMode: 'manual' },
    ],
  };
  const canCreate = !!row || required.every((key) => field(key).editable);
  const save = async () => {
    try {
      if (writer.locked) return;
      setLocalError('');
      await form.validateFields();
      const values = { ...form.getFieldsValue(true) } as Record<string, unknown>;
      if (locked) values.chains = editableChains(current?.chains, values.chains);
      if (!validateDates(values.startDate as string, values.endDate as string)) throw new Error(m.dateInvalid);
      const editable = groups.flat().filter((key) => field(key).editable);
      const body = evaluationPatch(current ?? {}, values, editable);
      validateChains(body, values);
      if ('conditions' in body) validateConditions(body.conditions);
      await writer.save(values, editable, row ? 'PATCH' : 'POST');
      writer.clear();
      saved();
      close();
    } catch (error) {
      if (error instanceof ApiError) form.setFields(error.fieldErrors);
      if (error instanceof Error) setLocalError(error.message);
    }
  };
  const [localError, setLocalError] = useState('');
  return { permission, step, setStep, form, writer, locked, field, initial, canCreate, save, localError };
}
export function ActivityWizard(props: WizardProps) {
  const { row, close } = props;
  const state = useWizard(props);
  const { writer, step, form, initial, canCreate, localError } = state;
  return (
    <Drawer
      open
      width={960}
      title={row ? m.edit : m.create}
      onClose={close}
      closable={!writer.busy}
      maskClosable={!writer.busy}
      keyboard={!writer.busy}
      footer={<WizardFooter state={state} close={close} />}
    >
      <Steps
        className="r3b-steps"
        current={step}
        items={[m.basic, m.conditions, m.chains].map((title) => ({ title }))}
      />
      {!canCreate && <Alert type="warning" message={m.restricted} />}
      {localError && <Alert type="error" message={localError} />}
      <CommandStatus submission={writer} labels={m} />
      <FormLock locked={writer.locked}>
        <Form form={form} layout="vertical" initialValues={initial} disabled={writer.locked}>
          <WizardFields state={state} />
        </Form>
      </FormLock>
    </Drawer>
  );
}

function WizardFooter({ state, close }: { state: ReturnType<typeof useWizard>; close(): void }) {
  const { writer, step, setStep, form, save, canCreate } = state;
  return (
    <Space>
      <Button disabled={writer.busy} onClick={close}>
        {m.cancel}
      </Button>
      {step > 0 && <Button onClick={() => setStep(step - 1)}>{m.previous}</Button>}
      {step < 2 ? (
        <Button
          type="primary"
          onClick={async () => {
            try {
              await form.validateFields(groups[step]);
              setStep(step + 1);
            } catch {
              /* Form 展示校验 */
            }
          }}
        >
          {m.next}
        </Button>
      ) : (
        <Button type="primary" onClick={() => void save()} loading={writer.busy} disabled={writer.locked || !canCreate}>
          {m.save}
        </Button>
      )}
    </Space>
  );
}

function WizardFields({ state }: { state: ReturnType<typeof useWizard> }) {
  const { step, field } = state;
  return (
    <>
      {' '}
      {groups.map((keys, index) => (
        <div key={index} style={{ display: index === step ? 'block' : 'none' }}>
          <div className={index === 0 ? 'r3b-form-grid' : undefined}>
            {keys
              .filter((key) => field(key).visible)
              .map((key) => (
                <Form.Item
                  key={key}
                  name={field(key).editable ? key : undefined}
                  label={m[key as 'name']}
                  rules={
                    field(key).editable && required.includes(key)
                      ? [
                          { required: true, message: m.required },
                          ...(['name'].includes(key) ? [{ whitespace: true, message: m.required }] : []),
                        ]
                      : []
                  }
                >
                  {field(key).editable ? (
                    <LockedField>{wizardControl(key, state)}</LockedField>
                  ) : (
                    wizardControl(key, state)
                  )}
                </Form.Item>
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

function validateChains(body: Record<string, unknown>, values: Record<string, unknown>) {
  if ('chains' in body) {
    const chains = records(body.chains).map((chain) => ({
      formId: null,
      approvalProcessCode: null,
      materialTemplate: null,
      hardDeadline: false,
      allowException: false,
      exceptionRoles: [],
      noticeTemplateCode: null,
      ...chain,
    })) as unknown as ChainDraft[];
    const issue = checkActivityChains(
      { startDate: (values.startDate as string) ?? null, endDate: (values.endDate as string) ?? null },
      chains,
    );
    if (issue) throw new Error(issue.named ?? issue.message);
  }
}

function wizardControl(key: string, state: ReturnType<typeof useWizard>) {
  const { field, writer, locked } = state;
  const row = writer.current;
  const disabled = !field(key).editable || writer.locked;
  if (key === 'chains')
    return (
      <Chains
        latest={row?.chains}
        disabled={disabled}
        locked={locked}
        {...(!field(key).editable ? { value: records(row?.chains) } : {})}
      />
    );
  if (key === 'conditions')
    return <Conditions disabled={disabled} {...(!field(key).editable ? { value: records(row?.conditions) } : {})} />;
  if (field(key).editable) return <ActivityControl name={key} disabled={writer.locked} />;
  return <span>{textValue(row?.[key])}</span>;
}
