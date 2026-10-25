import { ApiError } from '../foundation/client.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { isBlank, type Values } from '../foundation/forms/values.js';
import { createProfile, profileAccess, profileFields, validateProfile } from './create-profile.js';
import { c } from './create-messages.js';

export interface Candidate extends Values {
  employeeId: string;
  name?: string;
  code?: string;
  email?: string | null;
  endKind?: 'leave' | 'retirement';
  lastWorkDate?: string | null;
  departmentId?: string | null;
}
export interface Selected {
  candidate: Candidate;
  revision: number;
}
export const employmentFields = ['effectiveDate', 'departmentId', 'positionId', 'directManagerId', 'dottedManagerId'];
export const contractFields = ['companyId', 'endDate', 'typeId', 'termType', 'termMonths'];
export const controlFields = ['loginEmail'];
export const docKey = (v: Values) => JSON.stringify([String(v.idType ?? '').trim(), String(v.idNumber ?? '').trim()]);
export function canCreatePerson(p?: ObjectPermission) {
  return p?.dataOperations.create === true && canButton(p, 'Employee.Create', 'detail');
}
export function createAccess(
  person?: ObjectPermission,
  employment?: ObjectPermission,
  contract?: ObjectPermission,
  profile?: ObjectPermission,
  education?: ObjectPermission,
) {
  const permission = (name: string) => {
    if (['name', 'code'].includes(name)) return person;
    if (contractFields.includes(name)) return contract;
    return employment;
  };
  const profileField = profileAccess(profile, education);
  const field = (name: string) => {
    if (profileFields.includes(name)) return profileField(name);
    return controlFields.includes(name) ? { visible: true, editable: true } : fieldAccess(permission(name), name);
  };
  return {
    field,
    allowed:
      canCreatePerson(person) &&
      employment?.dataOperations.create === true &&
      canButton(employment, 'Employment.Create', 'detail') &&
      fieldAccess(employment, 'employType').editable &&
      contract?.dataOperations.create === true &&
      canButton(contract, 'create', 'list'),
  };
}
const present = (v: Values, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => !isBlank(v[key])).map((key) => [key, v[key]]));
/** 严格匹配 BE-R2d4c：F-322 profile 同一事务写入；未来合同只接受两项。 */
export function createBody(v: Values, selected: Selected | undefined, pending: boolean): Values {
  const profile = createProfile(v);
  return {
    ...(Object.keys(profile).length ? { profile } : {}),
    kind: selected ? 'rehire' : 'hire',
    ...(selected ? { employeeId: selected.candidate.employeeId } : present(v, ['name', 'code'])),
    ...present(v, ['loginEmail', 'effectiveDate']),
    fields: {
      employType: 'intern',
      ...present(
        v,
        employmentFields.filter((key) => key !== 'effectiveDate'),
      ),
    },
    contract: present(v, pending ? ['companyId', 'endDate'] : contractFields),
  };
}
export function validateCreate(v: Values, editable: readonly string[], rehire: boolean, pending: boolean) {
  validateProfile(v);
  const required = [
    'effectiveDate',
    'departmentId',
    'endDate',
    ...(rehire ? [] : ['name', 'code', 'loginEmail']),
    ...(pending ? [] : ['companyId', 'typeId']),
  ];
  for (const key of required) {
    if (!editable.includes(key)) throw new ApiError(403, 'FORBIDDEN', 'forbidden', c.denied);
    if (isBlank(v[key])) throw new ApiError(400, 'VALIDATION_FAILED', 'fields', c.required(c.labels[key]!));
  }
  if (String(v.endDate) <= String(v.effectiveDate))
    throw new ApiError(400, 'VALIDATION_FAILED', 'fields', c.invalidDate);
}
export interface CreateReceipt {
  profile?: Values;
  id: string;
  businessId: string;
  employeeId: string;
  revision: number;
  kind: 'hire' | 'rehire';
  view: 'interning' | 'pendingEntry';
  contract: {
    stage: 'formal' | 'pending';
    id: string | null;
    startDate: string;
    endDate: string;
    companyId: string | null;
  };
}
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
/** 新建业务 revision 与候选员工 revision 不同；不拿新业务版本同员工 If-Match 比大小。 */
export function acceptCreateReceipt(raw: unknown, body: Values, sentRevision: number): CreateReceipt {
  const r = raw as CreateReceipt | undefined;
  const contract = body.contract as Values;
  if (
    !r ||
    !id(r.id) ||
    r.id !== r.businessId ||
    !id(r.employeeId) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0 ||
    !Number.isSafeInteger(sentRevision) ||
    sentRevision < 0 ||
    r.kind !== body.kind ||
    (body.employeeId !== undefined && r.employeeId !== body.employeeId) ||
    !['interning', 'pendingEntry'].includes(r.view) ||
    !r.contract ||
    r.contract.startDate !== body.effectiveDate ||
    r.contract.endDate !== contract.endDate ||
    r.contract.companyId !== (contract.companyId ?? null) ||
    (r.view === 'interning'
      ? r.contract.stage !== 'formal' || !id(r.contract.id)
      : r.contract.stage !== 'pending' || r.contract.id !== null)
  )
    throw new Error(c.invalidReceipt);
  return r;
}
