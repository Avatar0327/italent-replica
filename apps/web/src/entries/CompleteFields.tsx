import { EMPLOYEE_STATUS_LABELS, type EmployeeStatusCode } from '@italent/domain';
import { Button, Form, Input, InputNumber, Select } from 'antd';
import { useEffect, type ReactNode } from 'react';
import type { FormField, FormGroup } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { NameOf, RefSelect, RefLabels, refPaths } from '../contracts/references.js';
import { useFormLock } from '../foundation/forms/FormLock.js';
import { isBlank, type Values } from '../foundation/forms/values.js';
import { contractObject, endOfTerm, hasContract } from './model.js';
import { m } from './messages.js';

export const readOnly = (label: string, display: ReactNode = '--'): FormField => ({
  name: label,
  label,
  display,
  control: null,
  access: { visible: true, editable: false },
});
export const placeholders = (text: string) => text.split('|').map((label) => readOnly(label));
export const required = [{ required: true, message: m.required }];
export const titleExtra = (
  <>
    <Button type="text" disabled>
      {m.translate}
    </Button>
    <Button type="text" disabled>
      {m.configure}
    </Button>
  </>
);
function MonthSelect({
  date,
  target,
  replace,
  value,
  onChange,
}: {
  date: string;
  target: string;
  replace?: boolean;
  value?: number;
  onChange?: (value: number) => void;
}) {
  const form = Form.useFormInstance();
  const lock = useFormLock();
  return (
    <Select
      value={value}
      disabled={lock.disabled}
      placeholder={m.choose}
      options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
      onChange={lock.guard((months: number) => {
        onChange?.(months);
        if (replace || isBlank(form.getFieldValue(target))) form.setFieldValue(target, endOfTerm(date, months));
      })}
    />
  );
}
function TermMonths({
  date,
  value,
  onChange,
}: {
  date: string;
  value?: number;
  onChange?: (value: number | null) => void;
}) {
  const form = Form.useFormInstance();
  const lock = useFormLock();
  return (
    <InputNumber
      min={1}
      precision={0}
      value={value}
      disabled={lock.disabled}
      onChange={lock.guard((months: number | null) => {
        onChange?.(months);
        if (months && form.getFieldValue('termType') === 'fixed' && isBlank(form.getFieldValue('endDate')))
          form.setFieldValue('endDate', endOfTerm(date, months));
      })}
    />
  );
}
export function TrialSelect({
  value,
  onChange,
  report,
}: {
  value?: boolean | null;
  onChange?: (value: boolean) => void;
  report?(value: boolean): void;
}) {
  useEffect(() => report?.(value === true), [value, report]);
  const lock = useFormLock();
  return (
    <Select
      placeholder={m.choose}
      value={value === null || value === undefined ? undefined : String(value)}
      options={[
        { value: 'true', label: m.yes },
        { value: 'false', label: m.no },
      ]}
      disabled={lock.disabled}
      onChange={lock.guard((next: string) => onChange?.(next === 'true'))}
    />
  );
}
function yesNo(value: unknown) {
  if (typeof value !== 'boolean') return '--';
  return value ? m.yes : m.no;
}
function displayFields(data: Values, email: ReactNode) {
  const date = String(data.effectiveDate ?? '');
  const reference = (key: keyof typeof refPaths) => <NameOf path={refPaths[key]} id={data[key]} asOf={date} />;
  const displays: Record<string, ReactNode> = {
    入职日期: date || '--',
    入职类型: m.kind[data.kind as keyof typeof m.kind] ?? '--',
    工号: String(data.code ?? '--'),
    部门: reference('departmentId'),
    职务: reference('positionId'),
    任职职位: reference('postId'),
    雇佣关系: m.relation[data.employType as keyof typeof m.relation] ?? '--',
    姓名: String(data.name ?? '--'),
    电子邮件: email,
    邀请激活账号: <Input disabled />,
    职级: <NameOf path="/api/tenant/job/levels" id={data.levelId} asOf={date} />,
    职等: <NameOf path="/api/tenant/job/grades" id={data.gradeId} asOf={date} />,
    职务序列: <NameOf path="/api/tenant/job/sequences" id={data.sequenceId} asOf={date} />,
    工作地点: String(data.place ?? '--'),
    是否部门负责人: yesNo(data.isDepartmentHead),
    新增下属: <RefLabels path={refPaths.employeeId} ids={data.addedSubordinateIds} />,
    直线经理: <NameOf path={refPaths.employeeId} id={data.directManagerId} />,
    虚线经理: <NameOf path={refPaths.employeeId} id={data.dottedManagerId} />,
    人员状态: EMPLOYEE_STATUS_LABELS[data.employeeStatus as EmployeeStatusCode] ?? '--',
  };
  return (labels: string) => labels.split('|').map((label) => readOnly(label, displays[label] ?? '--'));
}
function fieldBuilders(data: Values, canEdit: boolean, create: boolean, permission: ReturnType<typeof usePermissions>) {
  const writable = (
    name: keyof typeof m.fields,
    control: ReactNode,
    access = canEdit,
    rules = required,
  ): FormField => ({
    name,
    label: m.fields[name],
    control,
    rules,
    display: String(data[name] ?? '--'),
    access: { visible: true, editable: access },
  });
  const contract = (name: keyof typeof m.fields, control: ReactNode): FormField => ({
    ...writable(name, control, create && permission.field(name).editable, []),
    rules: [
      ({ getFieldsValue }) => ({
        validator: async (_, value) => {
          const values = getFieldsValue();
          const needed =
            ['companyId', 'typeId', 'termType'].includes(name) || (name === 'endDate' && values.termType === 'fixed');
          if (hasContract(values) && needed && isBlank(value)) throw new Error(m.required);
        },
      }),
    ],
  });
  return { writable, contract };
}
export function useCompleteGroups(
  data: Values,
  canEdit: boolean,
  trial: boolean,
  setTrial: (value: boolean) => void,
  email: ReactNode,
) {
  const permission = usePermissions(contractObject);
  const create = canEdit && permission.snapshot.objects[contractObject]?.dataOperations.create === true;
  const date = String(data.effectiveDate ?? '');
  const { writable, contract } = fieldBuilders(data, canEdit, create, permission);
  const readonlyFields = displayFields(data, email);
  const fields = readonlyFields(m.employment).map((field) =>
    field.label === m.fields.probation ? writable('probation', <TrialSelect report={setTrial} />) : field,
  );
  const groups: FormGroup[] = [
    { title: '', fields },
    { title: m.groups[0]!, fields: readonlyFields(m.employee) },
    ...(trial
      ? [
          {
            title: m.groups[1]!,
            fields: [
              writable('probationMonths', <MonthSelect date={date} target="probationEndDate" replace />),
              writable(
                'probationEndDate',
                <TenantDatePicker />,
                canEdit && (!create || permission.field('probationEndDate').editable),
              ),
              ...placeholders(m.probationReadonly),
            ],
          },
        ]
      : []),
    { title: m.groups[2]!, fields: readonlyFields(m.reporting) },
    {
      title: m.groups[3]!,
      fields: [
        contract('companyId', <RefSelect path={refPaths.companyId} />),
        contract('typeId', <RefSelect path={refPaths.typeId} />),
        contract(
          'termType',
          <Select
            placeholder={m.choose}
            options={Object.entries(m.terms).map(([value, label]) => ({ value, label }))}
          />,
        ),
        contract('termMonths', <TermMonths date={date} />),
        contract('endDate', <TenantDatePicker />),
        readOnly(m.sign, m.no),
      ],
    },
    { title: m.groups[4]!, fields: placeholders(m.salary) },
    { title: m.groups[5]!, fields: placeholders(m.insurance) },
  ];
  return {
    groups,
    fields: groups
      .flatMap((group) => group.fields)
      .filter((field) => field.access.editable)
      .map((field) => field.name)
      .concat(create && permission.field('probationStartDate').editable ? ['probationStartDate'] : []),
    create,
  };
}
