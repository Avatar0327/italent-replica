import type { ObjectDefinition } from '../permission/object-permission.js';
import { EMPLOYEE_FIELDS, SUBSETS } from './fields.js';

export const PERSONNEL_OBJECT = 'TenantBase.EmployeeInformation';
export const PERSONNEL_REQUEST_OBJECT = 'TenantBase.PersonalInformationChange';
export const TENURE_FIELDS = [
  'currentJobPostInYears',
  'accumulateJobPostInYears',
  'currentJobLevelInYears',
  'accumulateJobLevelInYears',
  'currentPositionInYears',
  'accumulatePositionInYears',
  'currentCadreServiceYears',
  'accumulateCadreServiceInYears',
];
export const EMPLOYEE_ATTRIBUTE_FIELDS = [
  'code',
  'userId',
  'age',
  'firstEntryDate',
  'latestEntryDate',
  'entryDate',
  'lastWorkDate',
  'organizationSortNumber',
  'postSortNumber',
  'positionSortNumber',
  'levelSortNumber',
  'gradeSortNumber',
  // DEC-148 / DEC-170 / DEC-171 / 15 §12：人员组合名次由 F-010 周期重算后存储。
  'orderCode',
];
export const SUBSET_EMPLOYEE_ATTRIBUTES: Readonly<Record<string, string>> = {
  code: 'code',
  userId: 'userId',
  employeeName: 'name',
  employeeEntryDate: 'entryDate',
  employeeFirstEntryDate: 'firstEntryDate',
  employeeLatestEntryDate: 'latestEntryDate',
  employeeLastWorkDate: 'lastWorkDate',
  organizationSortNumber: 'organizationSortNumber',
  postSortNumber: 'postSortNumber',
  positionSortNumber: 'positionSortNumber',
  levelSortNumber: 'levelSortNumber',
  gradeSortNumber: 'gradeSortNumber',
  orderCode: 'orderCode',
};
const metadata = ['id', 'tenantId', 'employeeId', 'revision', 'createdAt', 'createdBy', 'deleted', 'recordId'];
export const PERSONNEL_BUTTONS = [
  { code: 'create', level: 'list', requires: 'create' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'detail', requires: 'delete' },
  { code: 'history', level: 'detail' },
] as const;

export const PERSONNEL_OBJECTS: readonly ObjectDefinition[] = [
  {
    code: PERSONNEL_OBJECT,
    application: 'TenantBase',
    fields: [
      ...EMPLOYEE_FIELDS.map((field) => ({ code: field.code, system: field.system === true })),
      ...[...metadata, ...EMPLOYEE_ATTRIBUTE_FIELDS, ...TENURE_FIELDS].map((code) => ({ code, system: true })),
    ],
    buttons: PERSONNEL_BUTTONS.filter((button) => button.code === 'update' || button.code === 'history'),
  },
  ...Object.values(SUBSETS).map((subset) => ({
    code: subset.objectCode,
    application: 'TenantBase',
    fields: [
      ...subset.fields.map((field) => ({ code: field.code, system: 'system' in field && field.system === true })),
      ...['sourceType', 'sourceId'].map((code) => ({ code, system: true })),
      ...[...metadata, ...Object.keys(SUBSET_EMPLOYEE_ATTRIBUTES)].map((code) => ({ code, system: true })),
    ],
    buttons: PERSONNEL_BUTTONS,
  })),
  {
    code: PERSONNEL_REQUEST_OBJECT,
    application: 'TenantBase',
    fields: [
      ...['employeeId', 'subset', 'recordId', 'targetRevision'].map((code) => ({ code, system: false })),
      ...['id', 'revision', 'status', 'createdAt', 'createdBy'].map((code) => ({ code, system: true })),
    ],
    buttons: [
      { code: 'submit', level: 'list', requires: 'create' },
      // DEC-085: independent of HR create rights and management data scope.
      { code: 'self-service-submit', level: 'list' },
    ],
  },
];

export const PERSONNEL_SCOPE_FIELDS: Readonly<Record<string, string>> = Object.fromEntries(
  PERSONNEL_OBJECTS.map((object) => [object.code, object.code === PERSONNEL_OBJECT ? 'id' : 'employeeId']),
);
