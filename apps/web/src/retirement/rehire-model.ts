import { isBlank, type Values } from '../foundation/forms/values.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { m } from './messages.js';

export const rehireFields = {
  rehireEmployType: 'employType',
  rehireDepartmentId: 'departmentId',
  rehirePositionId: 'positionId',
  rehireRemarks: 'remarks',
} as const;

export const probationFields = {
  rehireProbation: 'probation',
  rehireProbationMonths: 'probationMonths',
  rehireProbationEndDate: 'probationEndDate',
} as const;

export const contractFields = {
  rehireContractTypeId: 'typeId',
  rehireContractCompanyId: 'companyId',
  rehireContractTermType: 'termType',
  rehireContractTermMonths: 'termMonths',
  rehireContractNumber: 'number',
  rehireContractEndDate: 'endDate',
  rehireContractSigningDate: 'signingDate',
} as const;

function pick(values: Values, names: Readonly<Record<string, string>>): Values {
  return Object.fromEntries(
    Object.entries(names).flatMap(([field, key]) => (isBlank(values[field]) ? [] : [[key, values[field]]])),
  );
}

export function rehireOptions(values: Values): Values {
  if (values.reEmployed !== true) return {};
  const entry =
    values.rehireProbation === true ? pick(values, probationFields) : pick(values, { rehireProbation: 'probation' });
  return {
    reEmployed: true,
    rehire: {
      fields: pick(values, rehireFields),
      ...(Object.keys(entry).length ? { entry } : {}),
      ...(values.rehireWithContract === true ? { contract: pick(values, contractFields) } : {}),
    },
  };
}

export const applicantFields = [...Object.keys(rehireFields), 'effectiveDate'];

export const rehireApplicationBody = (values: Values) => ({
  kind: 'retire_rehire',
  mode: 'application',
  effectiveDate: values.effectiveDate,
  fields: pick(values, rehireFields),
});

export function rehireApplicationAccess(permission?: ObjectPermission) {
  const date = fieldAccess(permission, 'effectiveDate').editable;
  const preview = canButton(permission, 'Employment.Preview', 'detail');
  return {
    preview,
    create:
      date &&
      ['kind', 'mode'].every((field) => fieldAccess(permission, field).editable) &&
      !!permission?.dataOperations.create &&
      canButton(permission, 'Employment.Create', 'detail'),
    edit: date && !!permission?.dataOperations.update && canButton(permission, 'Employment.Edit', 'detail'),
  };
}

export function businessValues(business: Values): Values {
  const fields = business.fields as Values | undefined;
  return {
    effectiveDate: business.effectiveDate,
    ...Object.fromEntries(Object.entries(rehireFields).map(([field, key]) => [field, fields?.[key]])),
  };
}

export function acceptRehire(value: Values, employeeId: string, id?: string, sent?: number) {
  const { revision, employeeRevision } = value;
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    (id !== undefined && value.id !== id) ||
    value.employeeId !== employeeId ||
    (Object.hasOwn(value, 'kind') && value.kind !== 'retire_rehire') ||
    (Object.hasOwn(value, 'mode') && value.mode !== 'application') ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 0 ||
    (sent !== undefined && id !== undefined && Number(revision) <= sent) ||
    (sent !== undefined &&
      id === undefined &&
      Object.hasOwn(value, 'employeeRevision') &&
      (!Number.isSafeInteger(employeeRevision) || Number(employeeRevision) <= sent))
  )
    throw new Error(m.invalidReceipt);
  return value as Values & { id: string; revision: number };
}

export function rehireBlockers(value: unknown) {
  const { blockers } = (value ?? {}) as Values;
  return Array.isArray(blockers)
    ? (blockers as Values[]).map(({ message, code, reason }) => String(message ?? code ?? reason ?? m.rehire.blocked))
    : [];
}
