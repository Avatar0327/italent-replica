import { CONTRACT_OBJECT, PROBATION_MONTHS_MAX, PROBATION_MONTHS_MIN, contractAction } from '@italent/domain';
import { Checkbox, Descriptions, Form, Input, InputNumber, Select } from 'antd';
import type { ReactNode } from 'react';
import { m as contracts } from '../contracts/messages.js';
import { NameOf, RefLabel, RefLabels, RefSelect, refPaths as contractRefs } from '../contracts/references.js';
import { LockedField } from '../foundation/forms/FormLock.js';
import { isBlank, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { refPaths } from '../part-time/references.js';
import { m } from './messages.js';
import { contractFields, probationFields, rehireFields } from './rehire-model.js';

const labels: Record<string, string> = {
  ...m.fields,
  employType: m.rehire.employType,
  remarks: m.rehire.remarks,
  probation: m.rehire.probation,
  probationMonths: m.rehire.probationMonths,
  probationEndDate: m.rehire.probationEndDate,
};
const terms = { fixed: '固定期限', indefinite: '无固定期限', task: '以完成一定工作任务为期限' };
const contractNames: Record<string, string> = {
  ...contracts.fields,
  termMonths: '合同期限（月）',
  probationStartDate: '试用开始日期',
  probationEndDate: '试用结束日期',
  probationSalary: '试用期工资',
  regularSalary: '转正工资',
};
const options = (dictionary: Record<string, string>) =>
  Object.entries(dictionary).map(([value, label]) => ({ value, label }));

export function planFields(permission?: ObjectPermission) {
  if (
    !permission?.dataOperations.create ||
    !canButton(permission, 'Employment.Create', 'detail') ||
    !fieldAccess(permission, 'reEmployed').visible
  )
    return [];
  // 退休设计 §8.2：试用期是创建请求 entry 的控制项，任职系统字段的编辑权只约束记录字段。
  return [
    'reEmployed',
    ...Object.keys(probationFields),
    ...Object.entries(rehireFields)
      .filter(([, key]) => fieldAccess(permission, key).editable)
      .map(([key]) => key),
  ];
}

export function useRehireContract(enabled: boolean) {
  const permission = usePermissions(enabled ? CONTRACT_OBJECT : undefined).snapshot.objects[CONTRACT_OBJECT];
  const available =
    enabled &&
    permission?.dataOperations.create &&
    canButton(permission, contractAction('create', 'direct'), 'list') &&
    ['effectiveDate', 'companyId', 'typeId', 'termType'].every((key) => fieldAccess(permission, key).editable);
  return available
    ? [
        'rehireWithContract',
        ...Object.entries(contractFields)
          .filter(([, key]) => fieldAccess(permission, key).editable)
          .map(([key]) => key),
      ]
    : [];
}

function planItem(
  editable: readonly string[],
  field: string,
  label: string,
  control: ReactNode,
  flags: { checkbox?: boolean; required?: boolean } = {},
) {
  return (
    editable.includes(field) && (
      <Form.Item
        key={field}
        name={field}
        label={flags.checkbox ? undefined : label}
        valuePropName={flags.checkbox ? 'checked' : 'value'}
        rules={flags.required ? [{ required: true, message: m.required(label) }] : undefined}
      >
        <LockedField>{control}</LockedField>
      </Form.Item>
    )
  );
}

export function RehireFields({ editable }: { editable: readonly string[] }) {
  const field = (key: keyof typeof rehireFields, control: ReactNode) =>
    planItem(editable, key, labels[rehireFields[key]]!, control);
  return (
    <>
      {field('rehireEmployType', <Select allowClear options={options(m.rehire.relation)} />)}
      {field('rehireDepartmentId', <RefSelect path={refPaths.departmentId!} ariaLabel={m.fields.departmentId} />)}
      {field('rehirePositionId', <RefSelect path={refPaths.positionId!} ariaLabel={m.fields.positionId} />)}
      {field('rehireRemarks', <Input.TextArea maxLength={2000} />)}
    </>
  );
}

function RehireContract({ editable }: { editable: readonly string[] }) {
  const withContract = Form.useWatch('rehireWithContract');
  const field = (key: keyof typeof contractFields, control: ReactNode, required = false) =>
    planItem(editable, key, contractNames[contractFields[key]]!, control, { required });
  if (!editable.includes('rehireWithContract')) return null;
  return (
    <>
      {planItem(editable, 'rehireWithContract', m.rehire.withContract, <Checkbox>{m.rehire.withContract}</Checkbox>, {
        checkbox: true,
      })}
      {withContract && (
        <section aria-label={m.rehire.contract}>
          {field('rehireContractTypeId', <RefSelect path={contractRefs.typeId} />, true)}
          {field('rehireContractCompanyId', <RefSelect path={contractRefs.companyId} />, true)}
          {field('rehireContractTermType', <Select options={options(terms)} />, true)}
          {field('rehireContractNumber', <Input maxLength={100} />)}
          {field('rehireContractTermMonths', <InputNumber min={1} max={1200} precision={0} />)}
          {field('rehireContractEndDate', <TenantDatePicker />)}
          {field('rehireContractSigningDate', <TenantDatePicker />)}
        </section>
      )}
    </>
  );
}

export function RehirePlanFields({ editable }: { editable: readonly string[] }) {
  const enabled = Form.useWatch('reEmployed');
  const probation = Form.useWatch('rehireProbation');
  if (!editable.includes('reEmployed')) return null;
  return (
    <>
      {planItem(editable, 'reEmployed', m.fields.reEmployed!, <Checkbox>{m.fields.reEmployed}</Checkbox>, {
        checkbox: true,
      })}
      {enabled && (
        <section aria-label={m.rehire.title}>
          <h3>{m.rehire.title}</h3>
          <RehireFields editable={editable} />
          {planItem(editable, 'rehireProbation', m.rehire.probation, <Checkbox>{m.rehire.probation}</Checkbox>, {
            checkbox: true,
          })}
          {probation && (
            <>
              {planItem(
                editable,
                'rehireProbationMonths',
                m.rehire.probationMonths,
                <InputNumber min={PROBATION_MONTHS_MIN} max={PROBATION_MONTHS_MAX} precision={0} />,
              )}
              {planItem(editable, 'rehireProbationEndDate', m.rehire.probationEndDate, <TenantDatePicker />)}
            </>
          )}
          <RehireContract editable={editable} />
        </section>
      )}
    </>
  );
}

function display(key: string, value: unknown, contract: boolean) {
  if (isBlank(value)) return m.missing;
  if (contract && (key === 'typeId' || key === 'companyId')) return <RefLabel path={contractRefs[key]} id={value} />;
  if (key === 'addedSubordinateIds') return <RefLabels path={contractRefs.employeeId} ids={value} />;
  if (!contract && refPaths[key]) return <NameOf path={refPaths[key]} id={value} />;
  if (key === 'employType') return m.rehire.relation[String(value)] ?? String(value);
  if (contract && key === 'termType') return (terms as Record<string, string>)[String(value)] ?? String(value);
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  return String(value);
}

function planItems(group: string, value: unknown, names: Record<string, string>, contract = false) {
  if (!value || typeof value !== 'object') return [];
  const { customFields, ...fields } = value as Values;
  return [...Object.entries(fields), ...Object.entries((customFields ?? {}) as Values)].map(([key, field]) => ({
    key: `${group}.${key}`,
    label: names[key] ?? key,
    children: display(key, field, contract),
  }));
}

export function RehirePlanRead({ plan }: { plan: unknown }) {
  if (plan === undefined) return null;
  if (plan === null) return <p>{m.rehire.none}</p>;
  const { fields, entry, contract, customFields, formId } = plan as Values;
  return (
    <section aria-label={m.rehire.title}>
      <Descriptions
        title={m.rehire.title}
        size="small"
        column={2}
        items={[
          ...planItems('fields', fields, labels),
          ...planItems('entry', entry, labels),
          ...planItems('custom', customFields, labels),
          ...(typeof formId === 'string' ? [{ key: 'formId', label: m.rehire.form, children: formId }] : []),
        ]}
      />
      {!!contract && (
        <Descriptions
          title={m.rehire.contract}
          size="small"
          column={2}
          items={planItems('contract', contract, contractNames, true)}
        />
      )}
    </section>
  );
}
