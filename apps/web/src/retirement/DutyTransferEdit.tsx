import { Button, Form, Select } from 'antd';
import { RefSelect } from '../contracts/references.js';
import { refPaths } from '../part-time/references.js';
import { m } from './messages.js';

type Relation = keyof typeof m.duty.relations;
type OrgRole = keyof typeof m.duty.orgRoles;
type Subordinate = { employeeId: string | null; receiverId: string | null; relation: Relation };
type Role = { orgId: string | null; receiverId: string | null; role: OrgRole };
type DutyPlan = { subordinates: readonly Subordinate[]; orgRoles: readonly Role[] };
const emptyPlan: DutyPlan = { subordinates: [], orgRoles: [] };
const people = refPaths.directManagerId!;
const orgs = refPaths.departmentId!;
const options = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));

export function completeDutyPlan(plan?: DutyPlan | null): boolean {
  return (
    !plan ||
    (plan.subordinates.every(({ employeeId, receiverId }) => !!employeeId && !!receiverId) &&
      plan.orgRoles.every(({ orgId, receiverId }) => !!orgId && !!receiverId))
  );
}

function reference(
  label: string,
  path: string,
  value: string | null,
  disabled: boolean,
  change: (id: string | null) => void,
) {
  return (
    <Form.Item label={label}>
      <RefSelect
        path={path}
        ariaLabel={label}
        value={value}
        disabled={disabled}
        onChange={(id) => change(typeof id === 'string' ? id : null)}
      />
    </Form.Item>
  );
}

const replace = <T,>(rows: readonly T[], index: number, next: Partial<T>) =>
  rows.map((row, i) => (i === index ? { ...row, ...next } : row));

type DutyFieldsProps<T> = {
  row: T;
  disabled: boolean;
  update(next: Partial<T>): void;
  remove(): void;
};

function SubordinateFields({ row, disabled, update, remove }: DutyFieldsProps<Subordinate>) {
  return (
    <fieldset disabled={disabled}>
      {reference(m.duty.subordinates, people, row.employeeId, disabled, (employeeId) => update({ employeeId }))}
      <Form.Item label={m.duty.relation}>
        <Select
          aria-label={m.duty.relation}
          value={row.relation}
          options={options(m.duty.relations)}
          disabled={disabled}
          onChange={(relation) => update({ relation })}
        />
      </Form.Item>
      {reference(m.duty.receiver, people, row.receiverId, disabled, (receiverId) => update({ receiverId }))}
      <Button disabled={disabled} onClick={remove}>
        {m.duty.removeSubordinate}
      </Button>
    </fieldset>
  );
}

function OrgRoleFields({ row, disabled, update, remove }: DutyFieldsProps<Role>) {
  return (
    <fieldset disabled={disabled}>
      {reference(m.duty.organization, orgs, row.orgId, disabled, (orgId) => update({ orgId }))}
      <Form.Item label={m.duty.orgRole}>
        <Select
          aria-label={m.duty.orgRole}
          value={row.role}
          options={options(m.duty.orgRoles)}
          disabled={disabled}
          onChange={(role) => update({ role })}
        />
      </Form.Item>
      {reference(m.duty.receiver, people, row.receiverId, disabled, (receiverId) => update({ receiverId }))}
      <Button disabled={disabled} onClick={remove}>
        {m.duty.removeOrgRole}
      </Button>
    </fieldset>
  );
}

export function DutyTransferEdit({
  value,
  onChange,
  disabled = false,
}: {
  value?: DutyPlan | null;
  onChange?: (value: DutyPlan | null) => void;
  disabled?: boolean;
}) {
  const plan = value ?? emptyPlan;
  const change = (next: DutyPlan) => {
    if (disabled) return;
    onChange?.(next.subordinates.length || next.orgRoles.length ? next : null);
  };

  return (
    <section aria-label={m.duty.title}>
      <h3>{m.duty.title}</h3>
      {!plan.subordinates.length && !plan.orgRoles.length && <p>{m.duty.empty}</p>}
      {plan.subordinates.map((row, index) => (
        <SubordinateFields
          key={index}
          row={row}
          disabled={disabled}
          update={(next) => change({ ...plan, subordinates: replace(plan.subordinates, index, next) })}
          remove={() => change({ ...plan, subordinates: plan.subordinates.filter((_, i) => i !== index) })}
        />
      ))}
      {plan.orgRoles.map((row, index) => (
        <OrgRoleFields
          key={index}
          row={row}
          disabled={disabled}
          update={(next) => change({ ...plan, orgRoles: replace(plan.orgRoles, index, next) })}
          remove={() => change({ ...plan, orgRoles: plan.orgRoles.filter((_, i) => i !== index) })}
        />
      ))}
      {!disabled && (
        <>
          <Button
            disabled={plan.subordinates.length >= 200}
            onClick={() =>
              change({
                ...plan,
                subordinates: [...plan.subordinates, { employeeId: null, receiverId: null, relation: 'direct' }],
              })
            }
          >
            {m.duty.addSubordinate}
          </Button>
          <Button
            disabled={plan.orgRoles.length >= 50}
            onClick={() =>
              change({
                ...plan,
                orgRoles: [...plan.orgRoles, { orgId: null, receiverId: null, role: 'person_in_charge' }],
              })
            }
          >
            {m.duty.addOrgRole}
          </Button>
        </>
      )}
    </section>
  );
}
