// F-127b A9～A12：新签 / 变更 / 续签 / 终止统一走 F-123 内核（docs/08_设计/F-123 §F-127b 适配）。
import { Button, Form, Input, InputNumber, Select, message } from 'antd';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { PersonSelect, TenantDatePicker, type Choice } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { useContractCommand } from './commands.js';
import { forAction } from '../foundation/forms/action.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { slotKey } from '../foundation/forms/slot.js';
import { lockedContext } from '../foundation/forms/store.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';
import { projectFields } from '../foundation/forms/values.js';
import {
  availableModes,
  commandFields,
  editableFormFields,
  formFieldNames,
  initialValues,
  linkTerm,
  parseContractReceipt,
  validateContract,
  type ContractReceipt,
  type Mode,
  type Operation,
} from './forms.js';
import { m } from './messages.js';
import { contractApi, object, value, type Row } from './model.js';
import { employmentItems, employmentOf } from './parts.js';
import { NameOf, RefLabel, RefSelect, refPaths, usePeople, useToday } from './references.js';
import { useRead } from './useRead.js';

const { commands, records } = contractApi;
/** 槽上下文（F-147）：操作与方式；新签另记所选人员与任职摘要，换入口重开时按它恢复表单。 */
type Context = { op: Operation; mode: Mode; employee?: Choice; employment?: Row };
/** 恢复槽：变更 / 续签 / 终止按源合同，新签按合同集合路径（与人员、方式无关）。 */
const slotOf = (sourceId?: string) => slotKey(records, sourceId);
const idOf = (source?: Row) => (typeof source?.id === 'string' ? source.id : undefined);
export const modeLabel = (op: Operation, mode: Mode) =>
  mode === 'direct' ? m.operations[op] : m.applyFor(m.operations[op]!);

/**
 * 按钮按（操作 × 方式）授权渲染；新签为列表级，其余为详情级。
 * 本对象有未确认的命令时，任一按钮都按槽里的操作与方式重开那条命令核对，不打开别的表单（F-147）。
 */
export function ContractButtons({
  ops,
  source,
  employee,
  employment,
  onDone,
}: {
  ops: Operation[];
  source?: Row;
  employee?: Choice;
  /** 新签时所选人员的任职摘要（入职缺失行带入）；变更 / 续签取源合同详情里的摘要。 */
  employment?: Row;
  onDone(): void;
}) {
  const permission = usePermissions(object);
  const [open, setOpen] = useState<Context>();
  const held = lockedContext<Context>(useContractCommand(slotOf(idOf(source))).state);
  // 没有可核对的 revision 时不提供变更类入口，避免带着无效 If-Match 提交。
  if (source && !Number.isSafeInteger(source.revision)) return null;
  return (
    <>
      {ops.flatMap((op) =>
        availableModes(permission.can, op).map((mode) => (
          <Button
            key={`${op}-${mode}`}
            type={op === 'create' ? 'primary' : 'default'}
            onClick={() => setOpen(held ?? { op, mode, employee, employment })}
          >
            {modeLabel(op, mode)}
          </Button>
        )),
      )}
      {open && <ContractForm {...open} source={source} onClose={() => setOpen(undefined)} onDone={onDone} />}
    </>
  );
}

const project = (row: Row, op: Operation) => projectFields(row, formFieldNames(op));

type Props = {
  op: Operation;
  mode: Mode;
  source?: Row;
  employee?: Choice;
  employment?: Row;
  onClose(): void;
  onDone(): void;
};
export function ContractForm(props: Props) {
  const { op, mode, source, employee, onClose, onDone } = props;
  const api = useApiClient();
  const sourceId = idOf(source);
  const resource = slotOf(sourceId);
  const submission = forAction(useContractCommand(resource), { op, mode });
  const { groups, fields } = useFormFields(op, source, employee, source ? employmentOf(source) : props.employment);
  const submit = useSubmit(props, submission, fields);
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={`${resource}#${op}/${mode}`}
      submission={{
        ...submission,
        reload: sourceId
          ? () =>
              submission.reread(async (id) => {
                const row = await api.request<Row>(`${records}/${encodeURIComponent(String(id))}`);
                return { id: String(row.id), revision: Number(row.revision), values: project(row, op) };
              })
          : undefined,
      }}
      title={
        mode === 'direct'
          ? `${m.operations[op]}${m.contractSuffix}`
          : m.applyFor(`${m.contractSuffix}${m.operations[op]}`)
      }
      groups={groups}
      initialValues={{ ...initialValues(op, source), ...(op === 'create' ? { employee } : {}) }}
      onClose={onClose}
      onRefresh={onDone}
      onSubmit={submit}
    />
  );
}
/** 字段分组与可提交字段：按字段权限渲染，续签不改类型（editableFormFields）。 */
function useFormFields(op: Operation, source?: Row, employee?: Choice, employment?: Row) {
  const permission = usePermissions(object);
  const asOf = useToday();
  // 自动编号只在设置明确开启时放过编号必填；读不到设置时保守按必填。
  const settings = useRead<Row>(op === 'create' ? contractApi.settings : null);
  const context = { source, autoNumber: settings.data?.autoNumber === true };
  const editable = editableFormFields(op, (field) => permission.field(field).editable);
  const access = (field: string) => ({ visible: permission.field(field).visible, editable: editable.includes(field) });
  const rule = (name: string) => [
    ({ getFieldsValue }: { getFieldsValue(all: true): Row }) => ({
      validator: async () => {
        const error = validateContract(op, getFieldsValue(true), context)[name];
        if (error) throw new Error(error);
      },
    }),
  ];
  const field = (name: string, control: FormField['control'], display?: FormField['display']): FormField => ({
    name,
    label: m.fields[name] ?? name,
    control,
    access: access(name),
    rules: rule(name),
    display,
  });
  const contractFields: FormField[] = [
    field('number', <Input maxLength={100} placeholder={context.autoNumber ? m.autoNumberHint : undefined} />),
    field(
      'companyId',
      <RefSelect path={refPaths.companyId} />,
      <RefLabel path={refPaths.companyId} id={source?.companyId} />,
    ),
    field('typeId', <RefSelect path={refPaths.typeId} />, <RefLabel path={refPaths.typeId} id={source?.typeId} />),
    field('termType', <Linked name="termType" kind="termType" />),
    field('signingDate', <TenantDatePicker />),
    field('effectiveDate', <Linked name="effectiveDate" kind="date" />),
    field('termMonths', <Linked name="termMonths" kind="months" />),
    field('endDate', <TenantDatePicker />),
  ];
  // 原站表单：任职信息（只读）→ 合同信息（人员在首位）→ 原合同信息；终止只有实际终止时间一项。
  const person =
    op === 'create' ? employeeField(employee) : targetField(source, permission.field('employeeId').visible);
  const groups =
    op === 'terminate'
      ? [{ title: m.contract, fields: [field('actualTerminationDate', <TenantDatePicker />)] }]
      : [
          { title: m.employment, fields: employmentFields(employment, asOf) },
          { title: m.formGroups[op], fields: [person, ...contractFields] },
          ...(source ? [{ title: m.originalContract, fields: originalFields(op, source, permission.field) }] : []),
        ];
  return { groups, fields: editable.filter((name) => access(name).visible) };
}
/** 只读展示项：不进提交集合（editableFields 只取合同字段）。 */
const shown = (name: string, label: string, display: FormField['display'], visible = true): FormField => ({
  name,
  label,
  control: null,
  access: { visible, editable: false },
  display,
});
/** 任职信息（原站只读分区）：顶部新签选人后后端未提供该人员的任职摘要，各项显示“--”（后端缺口）。 */
function employmentFields(employment: Row | undefined, asOf?: string): FormField[] {
  return employmentItems(employment, asOf).map((item) => shown(`employment.${item.key}`, item.label, item.children));
}
/** 变更 / 续签的新合同区首位是固定人员（命令目标，不可改）。 */
function targetField(source: Row | undefined, visible: boolean): FormField {
  return shown(
    'target.employeeId',
    m.fields.employeeId!,
    <NameOf path={refPaths.employeeId} id={source?.employeeId} />,
    visible,
  );
}
/** 变更 / 续签下方的原合同信息（原站灰底只读分区），只展示、不提交；签订次数只在续签时显示。 */
const originalKeys = [
  'number',
  'companyId',
  'typeId',
  'termType',
  'signingDate',
  'effectiveDate',
  'termMonths',
  'endDate',
];
function originalFields(op: Operation, source: Row, access: (field: string) => { visible: boolean }): FormField[] {
  return [...originalKeys, ...(op === 'renew' ? ['signingCount'] : [])].map((name) => ({
    name: `original.${name}`,
    label: m.fields[name] ?? name,
    control: null,
    access: { visible: access(name).visible, editable: false },
    display:
      name === 'companyId' || name === 'typeId' ? (
        <RefLabel path={refPaths[name]} id={source[name]} />
      ) : (
        value(source[name], name)
      ),
  }));
}
/** 提交经 F-123 内核；回执按实际形态分流（合同 / 申请），不按 mode 推断。 */
function useSubmit(props: Props, submission: CommandForm, fields: string[]) {
  const { op, mode, source, employee, employment, onDone } = props;
  const api = useApiClient();
  const navigate = useNavigate();
  const receipt = useRef<ContractReceipt>(undefined);
  const sourceId = typeof source?.id === 'string' ? source.id : undefined;
  return async (values: Row) => {
    const chosen =
      (values.employee as Choice | undefined)?.value ?? (sourceId ? String(source?.employeeId) : employee?.value);
    const result = await submission.submit({
      values,
      baseline: source && op !== 'terminate' ? project(source, op) : initialValues(op, source),
      editableFields: fields,
      revision: sourceId ? Number(source?.revision) : 0,
      businessId: sourceId,
      patchOnly: op === 'change' || op === 'renew',
      context: op === 'create' ? { employee, employment } : undefined,
      send: async (command) => {
        if (!chosen) throw new Error(m.required);
        const body = {
          operation: op,
          mode,
          employeeId: chosen,
          targetId: sourceId,
          fields: commandFields(command.body),
        };
        const raw = await api.request<unknown>(commands, { method: 'POST', command: { ...command, body } });
        receipt.current = parseContractReceipt(raw, { employeeId: chosen, operation: op, sourceId });
        return { id: sourceId ?? receipt.current.id };
      },
    });
    if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
    submission.clear();
    const done = receipt.current!;
    if (done.kind === 'contract') {
      void message.success(m.saved);
      if (op !== 'terminate') navigate(`/contracts/records/${encodeURIComponent(done.id)}`);
    } else void message.info(done.status === 'approved' ? m.requestApproved : m.requestSubmitted);
    onDone();
  };
}

function employeeField(employee?: Choice): FormField {
  return {
    name: 'employee',
    label: m.fields.employeeId!,
    // 从“入职缺失”行带入时人员固定；人员是命令目标，不属于合同字段权限。
    access: { visible: true, editable: !employee },
    control: <EmployeePicker />,
    // 姓名按人员详情解析：入职缺失行的姓名会被列表按合同对象字段裁掉（后端缺口）。
    display: employee ? <NameOf path={refPaths.employeeId} id={employee.value} /> : undefined,
    rules: [{ required: true, message: m.required }],
  };
}
function EmployeePicker(props: { value?: Choice; onChange?: (value: Choice | undefined) => void; disabled?: boolean }) {
  const load = usePeople();
  return <PersonSelect {...props} load={load} />;
}

/** 期限联动只在人工输入时触发；冲突重读回填走 setFieldsValue，不经过这里。 */
function Linked({
  name,
  kind,
  value,
  onChange,
  disabled,
}: {
  name: string;
  kind: 'date' | 'months' | 'termType';
  value?: unknown;
  onChange?: (value: unknown) => void;
  disabled?: boolean;
}) {
  const form = Form.useFormInstance();
  const change = (next: unknown) => {
    onChange?.(next);
    form.setFieldsValue(linkTerm(name, { ...form.getFieldsValue(true), [name]: next }));
  };
  if (kind === 'date') return <TenantDatePicker value={value as string | null} onChange={change} disabled={disabled} />;
  if (kind === 'months')
    return (
      <InputNumber
        min={1}
        max={1200}
        precision={0}
        value={value as number | null}
        disabled={disabled}
        onChange={(next) => change(next ?? null)}
      />
    );
  return (
    <Select
      value={value}
      disabled={disabled}
      onChange={change}
      options={Object.entries(m.values.termType!).map(([key, label]) => ({ value: key, label }))}
    />
  );
}
