import type { Authorizer } from '../../authorization.js';
import type { resolveModuleScope } from '../permission/module-access.js';
import type { ActivationSummary } from './activation-store.js';
export const BUSINESS_KINDS = [
  'hire',
  'rehire',
  'retire_rehire',
  'regularization',
  'transfer',
  'org_adjustment',
  'leave',
  'retirement',
  'intern_regularization',
] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];
/** disapproved：审批沿「不同意」流转到结束，申请办结、不生效（F-003 第二轮，DEC-144）。 */
export type EmploymentState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'disapproved' | 'effective' | 'deleted';
export type EmployType = 'internal' | 'intern' | 'external';
export type CustomValue = string | number | boolean | null;
export type CustomFields = Readonly<Record<string, CustomValue>>;
export type FormId = string;

export const PRESET_FIELD_NAMES = [
  'departmentId',
  'positionId',
  'postId',
  'levelId',
  'gradeId',
  'place',
  'directManagerId',
  'dottedManagerId',
  'employmentType',
  'employmentSource',
  'employmentForm',
  'sequenceId',
  'professionalLineId',
  'isKeyPerson',
  'dimension1',
  'dimension2',
  'dimension3',
  'dimension4',
  'dimension5',
  'jobNumber',
  'remarks',
  'isDepartmentHead',
  'employType',
] as const;
export type PresetField = (typeof PRESET_FIELD_NAMES)[number];

export interface PresetFields {
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly postId: string | null;
  readonly levelId: string | null;
  readonly gradeId: string | null;
  readonly place: string | null;
  readonly directManagerId: string | null;
  readonly dottedManagerId: string | null;
  readonly employmentType: string | null;
  readonly employmentSource: string | null;
  readonly employmentForm: string | null;
  readonly sequenceId: string | null;
  readonly professionalLineId: string | null;
  readonly isKeyPerson: boolean | null;
  readonly dimension1: string | null;
  readonly dimension2: string | null;
  readonly dimension3: string | null;
  readonly dimension4: string | null;
  readonly dimension5: string | null;
  readonly jobNumber: string | null;
  readonly remarks: string | null;
  readonly isDepartmentHead: boolean | null;
  readonly employType: EmployType | null;
}

export function emptyPresetFields(): PresetFields {
  return Object.fromEntries(PRESET_FIELD_NAMES.map((field) => [field, null])) as unknown as PresetFields;
}

export type EmploymentScope = Awaited<ReturnType<typeof resolveModuleScope>>;

export interface EmploymentContext {
  readonly scope?: EmploymentScope;
  readonly scopeEmployeeId?: string;
  readonly scopeEmployeeCreatorId?: string | null;
  readonly authorize?: Authorizer;
  readonly objectCode?: string;
  readonly trustedScopeBypass?: boolean;
  /** Switch 31：仅经调动入口重验源员工后授予指定目标，不能用于任意员工或向后更新。 */
  readonly transferTarget?: {
    readonly employeeId: string;
    readonly departmentId: string | null;
    readonly businessId?: string;
  };
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

export interface EmploymentBusinessInput {
  readonly kind: BusinessKind;
  readonly mode: 'direct' | 'application';
  readonly effectiveDate?: string;
  readonly lastWorkDate?: string | null;
  readonly formId?: FormId;
  readonly fields?: Partial<PresetFields>;
  readonly customFields?: CustomFields;
}

export interface NormalizedEmploymentInput extends EmploymentBusinessInput {
  readonly effectiveDate: string;
  readonly lastWorkDate: string | null;
  readonly formId: FormId;
  readonly fields: Partial<PresetFields>;
  readonly customFields: CustomFields;
}

export interface EmploymentBusinessPatch {
  readonly effectiveDate?: string;
  readonly lastWorkDate?: string | null;
  readonly fields?: Partial<PresetFields>;
  readonly customFields?: CustomFields;
}

export interface EmploymentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly staffId: string;
  readonly entryDate: string;
  readonly serviceType: string;
  readonly kind: BusinessKind;
  readonly effectiveDate: string;
  readonly stopDate: string;
  readonly previousRecordId: string | null;
  readonly fields: PresetFields;
  readonly customFields: CustomFields;
  readonly isCurrent: boolean;
  readonly isLatest: boolean;
  readonly status: 'effective';
  readonly isInserted: boolean;
  readonly before?: { readonly fields: PresetFields; readonly customFields: CustomFields } | null;
}

export interface EmploymentBusiness {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly employeeRevision: number;
  readonly status: EmploymentState;
  readonly kind: BusinessKind;
  readonly mode: 'direct' | 'application';
  readonly formId: FormId;
  readonly effectiveDate: string;
  readonly fields: PresetFields;
  readonly customFields: CustomFields;
  readonly record: EmploymentRecord | null;
  /** R1-T08 生效结果（DEC-052 / DEC-112）：审批通过的申请与经定时任务 / 重试生效的业务才有。 */
  readonly activation: ActivationSummary | null;
}

export interface PageQuery {
  readonly limit: number;
  readonly offset: number;
}
