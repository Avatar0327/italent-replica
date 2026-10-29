import type { Authorizer } from '../../authorization.js';
import type { resolveModuleScope } from '../permission/module-access.js';
import type { EmployeeStatusCode, EntryStatusCode } from '@italent/domain';
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
/**
 * 变动类型（原站与业务类型、异动类型并列，W-416）。只由系统写入：职位变更同步直线经理记“职位调整”
 * （`19` §3.1，F-006）；实习转正记“实习转正”（BE-6a，R2f B41）；结束实习记“实习结束”（BE-6b，R2d B41）。
 * 其他业务与存量记录没有原站依据，保持空值。
 */
export const CHANGE_TYPES = ['position_adjustment', 'intern_regularization', 'intern_end'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
/**
 * disapproved：审批沿「不同意」流转到结束，申请办结、不生效（F-003 第二轮，DEC-144）。
 * voided：HR 撤销未审批完成的申请，作废、不生效，只能删除（R1-T11，AC-TRF-07）。
 */
export type EmploymentState =
  'draft' | 'in_review' | 'approved' | 'rejected' | 'disapproved' | 'voided' | 'effective' | 'deleted';
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
  'isStoreManager',
  'addedSubordinateIds',
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
  readonly isStoreManager: boolean | null;
  readonly addedSubordinateIds: readonly string[] | null;
  readonly employType: EmployType | null;
}

export function emptyPresetFields(): PresetFields {
  return Object.fromEntries(PRESET_FIELD_NAMES.map((field) => [field, null])) as unknown as PresetFields;
}

export type EmploymentScope = Awaited<ReturnType<typeof resolveModuleScope>>;

export interface EmploymentContext {
  /** 本人自助路由重验账号绑定后设置；仅用于同表单的字段权限继承策略。 */
  readonly selfServiceEmployeeId?: string;
  readonly managerTransfer?: boolean;
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
  /**
   * 离职门禁的可信端口（R2-T03 §4A）：只能由服务端内部构造（测试造数 / R2-T04 退休），HTTP 与审批路径不可达；
   * 带它的离职创建不经门禁，保持 main 的创建与落地行为，且不写离职扩展行。
   */
  readonly trustedExit?: 'seed' | 'retirement';
  /** 非保存当时落地（定时生效、HR 重试、审批通过）：迟到执行按实际执行日对齐联动（DEC-186 / DEC-195②）。 */
  readonly deferredExecution?: boolean;
  /** 系统代发（BE-15a 自动转正，R2e7）：userId 是规则配置的发起人，审批发起日志标“系统代发”。 */
  readonly systemProxy?: boolean;
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
  readonly changeType: ChangeType | null;
  readonly effectiveDate: string;
  readonly stopDate: string;
  readonly previousRecordId: string | null;
  readonly fields: PresetFields;
  readonly customFields: CustomFields;
  /** F-022：本版本的人员状态 / 入职状态（只经业务流转写入，15 §9）。 */
  readonly employeeStatus: EmployeeStatusCode;
  readonly entryStatus: EntryStatusCode | null;
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
  readonly changeType: ChangeType | null;
  readonly mode: 'direct' | 'application';
  readonly formId: FormId;
  readonly effectiveDate: string;
  /** F-306：本单最新试用期版本，与 revision 同一 SQL 快照；HTTP 响应仍按当前字段权限裁剪。 */
  readonly probation: boolean;
  readonly probationMonths: number | null;
  readonly probationEndDate: string | null;
  readonly fields: PresetFields;
  readonly customFields: CustomFields;
  readonly employeeStatus: EmployeeStatusCode;
  readonly entryStatus: EntryStatusCode | null;
  readonly record: EmploymentRecord | null;
  /** R1-T08 生效结果（DEC-052 / DEC-112）：审批通过的申请与经定时任务 / 重试生效的业务才有。 */
  readonly activation: ActivationSummary | null;
}

export interface PageQuery {
  readonly limit: number;
  readonly offset: number;
}
