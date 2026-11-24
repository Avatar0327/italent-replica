import { RETIREMENT_BUTTONS } from '@italent/domain';
import { Button, Descriptions, Form, Modal, Select } from 'antd';
import { RefSelect } from '../contracts/references.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { changedFields, isBlank, projectFields, type Values } from '../foundation/forms/values.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { useApiClient } from '../foundation/Session.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { refPaths } from '../part-time/references.js';
import { useRetireCommand } from './commands.js';
import { m } from './messages.js';
import { acceptRetirement, cellValue, retirements, retireSlot, type Row } from './model.js';
import { completeDutyPlan, DutyTransferEdit } from './DutyTransferEdit.js';
import { RehirePlanRead } from './RehirePlan.js';

const timing = 'dutyTransferTiming';
const date = 'dutyTransferDate';
const duty = 'dutyTransfer';
const editFields = ['handoverEmployeeId', timing, date, duty] as const;
const planEditable = (detail?: Row) =>
  detail &&
  Object.hasOwn(detail, 'dutyTransferPlan') &&
  !detail.dutyTransferPlanLocked &&
  ['draft', 'in_review', 'approved', 'rejected'].includes(String(detail.status));
const readonlyFields = ['lastWorkDate', 'effectiveDate', 'reEmployed'];

const labels = { ...m.fields, [timing]: m.edit.timing, [date]: m.edit.date, [duty]: m.duty.title };
const dutyRules = [
  {
    validator: (_: unknown, plan: Parameters<typeof completeDutyPlan>[0]) =>
      completeDutyPlan(plan) ? Promise.resolve() : Promise.reject(new Error(m.duty.incomplete)),
  },
];

export function retirementEditFields(permission?: ObjectPermission, detail?: Row) {
  if (!permission?.dataOperations.update || !canButton(permission, RETIREMENT_BUTTONS.edit, 'detail')) return [];
  return editFields.filter(
    (field) =>
      fieldAccess(permission, field).editable &&
      (field !== date || fieldAccess(permission, timing).visible) &&
      (field !== duty || planEditable(detail)),
  );
}

export function retirementPatch(values: Values, before: Values, writable: readonly string[]) {
  return Object.fromEntries(
    changedFields(
      values,
      before,
      editFields.filter((field) => writable.includes(field)),
    ).flatMap((field) =>
      field === duty
        ? [[field, values[field] ?? null]]
        : isBlank(values[field]) || (field === date && (values[timing] ?? before[timing]) !== 'specified_date')
          ? []
          : [[field, values[field]]],
    ),
  );
}

export function retirementEditBaseline(detail: Values) {
  return projectFields({ ...detail, [duty]: detail.dutyTransferPlan }, editFields);
}

type Props = {
  detail: Row;
  editable: readonly string[];
  onClose(): void;
  onDone(): void;
  refresh(): Promise<unknown>;
};
function useRetirementEdit({ detail, editable: allowed, onDone, refresh }: Props) {
  const api = useApiClient();
  const [form] = Form.useForm();
  const id = detail.id!;
  const employeeId = detail.employeeId!;
  const path = slotKey(retirements, id);
  const baseline = retirementEditBaseline(detail);
  const read = async () => {
    const row = acceptRetirement(await api.request<Values>(path), { id, employeeId, sent: -1 });
    return { id: employeeId, revision: Number(row.revision), values: { ...row, ...retirementEditBaseline(row) } };
  };
  const cmd = useRetireCommand(
    retireSlot,
    { id: employeeId, revision: detail.revision, baseline, read },
    `edit/${id}`,
    refresh,
  );
  const snapshot = (cmd.form.state?.latest?.values ?? detail) as Row;
  const editable = allowed.filter((field) => field !== duty || planEditable(snapshot));
  const watched = Form.useWatch([], { form, preserve: true }) as Values | undefined;
  useDraftRefill(cmd.form, editable, form);
  const values = { ...cmd.full, ...watched };
  const patch = retirementPatch(values, cmd.full, editable);
  const locked = cmd.disabled || editable.length === 0;

  const submit = async () => {
    const next = await form.validateFields().catch(() => undefined);
    if (!next || locked) return;
    try {
      const done = await cmd.submit({ ...cmd.full, ...next }, editable, {
        path,
        method: 'PATCH',
        body: (input) => retirementPatch(input, cmd.full, editable),
        accept: (raw, sent) => {
          const receipt = acceptRetirement(raw, { id, employeeId, sent });
          return { path, id, revision: Number(receipt.revision) };
        },
      });
      if (done) onDone();
    } catch {
      // 拒绝保留草稿，冲突重读和未知锁由内核显示。
    }
  };

  return { form, cmd, baseline, snapshot, values, patch, locked, submit, editable };
}

export function RetirementEdit(props: Props) {
  const { onClose } = props;
  const { form, cmd, baseline, snapshot, values, patch, locked, submit, editable } = useRetirementEdit(props);
  const handover = m.fields.handoverEmployeeId!;
  const required = (label: string) => [{ required: true, message: m.required(label) }];
  return (
    <Modal
      open
      title={m.edit.title}
      width={680}
      maskClosable={false}
      closable={!cmd.form.busy}
      keyboard={!cmd.form.busy}
      onCancel={onClose}
      footer={[
        <Button key="cancel" disabled={cmd.form.busy} onClick={onClose}>
          {m.cancel}
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={cmd.form.busy}
          disabled={locked || !Object.keys(patch).length}
          onClick={() => void submit()}
        >
          {m.save}
        </Button>,
      ]}
    >
      <CommandStatus submission={cmd.form} labels={labels} />
      <Descriptions
        size="small"
        column={2}
        items={readonlyFields
          .filter((key) => Object.hasOwn(snapshot, key))
          .map((key) => ({
            key,
            label: m.fields[key],
            children: cellValue(snapshot, key),
          }))}
      />
      <RehirePlanRead plan={snapshot.rehire} />
      <FormLock locked={locked}>
        <Form form={form} layout="vertical" disabled={locked} initialValues={baseline}>
          {editable.includes('handoverEmployeeId') && (
            <Form.Item
              name="handoverEmployeeId"
              label={handover}
              rules={changedFields(values, cmd.full, ['handoverEmployeeId']).length ? required(handover) : []}
            >
              <RefSelect path={refPaths.directManagerId!} ariaLabel={handover} />
            </Form.Item>
          )}
          {editable.includes(timing) && (
            <Form.Item name={timing} label={m.edit.timing}>
              <Select
                options={Object.entries(m.edit.timings).map(([value, label]) => ({
                  value,
                  label,
                  disabled: value === 'specified_date' && !editable.includes(date) && !values[date],
                }))}
              />
            </Form.Item>
          )}
          {editable.includes(date) && values[timing] === 'specified_date' && (
            <Form.Item name={date} label={m.edit.date} rules={required(m.edit.date)}>
              <TenantDatePicker />
            </Form.Item>
          )}
          {Object.hasOwn(snapshot, 'dutyTransferPlan') && (
            <Form.Item name={duty} rules={dutyRules}>
              <DutyTransferEdit disabled={locked || !editable.includes(duty)} />
            </Form.Item>
          )}
        </Form>
      </FormLock>
    </Modal>
  );
}
