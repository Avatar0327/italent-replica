import { Alert, Button, Drawer, Form, Space, Steps } from 'antd';
import { useState } from 'react';
import { checkActivityChains, type ChainDraft } from '@italent/domain';
import { usePermissions } from '../foundation/Permissions.js';
import { ApiError } from '../foundation/client.js';
import { ActivityControl, Chains, Conditions, EV } from './ActivityFields.js';
import { Failure, useWriter } from './runtime.js';
import { evaluationPatch, records, validateDates, type Row } from './model.js';
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
  const writer = useWriter(() => {
    saved();
    close();
  });
  const locked = !!row && row.applyCount !== 0;
  const field = (key: string) => {
    const access = permission.field(key);
    return {
      ...access,
      editable:
        access.editable &&
        row?.status !== 'completed' &&
        !(
          locked &&
          ['typeId', 'orgRange', 'categoryIds', 'maxLevelJump', 'effectiveDate', 'noticeOrgRange'].includes(key)
        ),
    };
  };
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
      await form.validateFields();
      const values = form.getFieldsValue(true) as Record<string, unknown>;
      if (!validateDates(values.startDate as string, values.endDate as string)) throw new Error(m.dateInvalid);
      const editable = groups.flat().filter((key) => field(key).editable);
      const body = evaluationPatch(row ?? {}, values, editable);
      validateChains(body, values);
      await writer.write(
        row ? `${EV}/activities/${row.id}` : `${EV}/activities`,
        row ? 'PATCH' : 'POST',
        body,
        row?.revision ?? 0,
      );
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
      <Failure error={writer.error} retry={writer.reset} />
      <Form form={form} layout="vertical" initialValues={initial} disabled={writer.busy || writer.blocked}>
        <WizardFields state={state} row={row} />
      </Form>
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
        <Button
          type="primary"
          onClick={() => void save()}
          loading={writer.busy}
          disabled={writer.blocked || !canCreate}
        >
          {m.save}
        </Button>
      )}
    </Space>
  );
}

function WizardFields({ state, row }: { state: ReturnType<typeof useWizard>; row?: Row }) {
  const { step, field, writer, locked } = state;
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
                  label={m[key as keyof typeof m]}
                  rules={
                    field(key).editable && required.includes(key)
                      ? [
                          { required: true, message: m.required },
                          ...(['name'].includes(key) ? [{ whitespace: true, message: m.required }] : []),
                        ]
                      : []
                  }
                >
                  {key === 'chains' ? (
                    <Chains
                      disabled={!field(key).editable || writer.blocked}
                      locked={locked}
                      {...(!field(key).editable ? { value: records(row?.chains) } : {})}
                    />
                  ) : key === 'conditions' ? (
                    <Conditions
                      disabled={!field(key).editable || writer.blocked}
                      {...(!field(key).editable ? { value: records(row?.conditions) } : {})}
                    />
                  ) : field(key).editable ? (
                    <ActivityControl name={key} disabled={writer.blocked} />
                  ) : (
                    <span>{textValue(row?.[key])}</span>
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
