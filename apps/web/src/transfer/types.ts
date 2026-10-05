export type FieldValue = string | number | boolean | readonly string[] | null;
export type FieldValues = Readonly<Record<string, FieldValue>>;
export type FieldMode = 'editable' | 'readonly' | 'hidden' | 'absent';
export interface Choice {
  readonly id: string;
  readonly name: string;
}
/** 调动联动“变更的合同”候选：无权查看合同编号时 name 为 null（PR #74 第三轮 P2-2）。 */
export interface ContractChoice {
  readonly id: string;
  readonly name: string | null;
}
export interface EmployeeChoice extends Choice {
  readonly code: string;
  readonly revision: number;
}
export interface TransferCatalog {
  readonly today?: string;
  readonly types: readonly { code: string; name: string; formId: string }[];
  readonly reasons: readonly { code: string; name: string; transferTypeCode: string | null }[];
}
export interface TransferPreview {
  readonly requiredFieldsUnavailable?: boolean;
  readonly form: {
    readonly id: string;
    readonly name: string;
    readonly isStandard: boolean;
    readonly excludedAutofillFields: readonly string[];
    readonly fieldModes: Readonly<Record<string, FieldMode>>;
    readonly customFields: readonly { id: string; name: string; valueType: string }[];
  };
  readonly fields: FieldValues;
  readonly customFields: FieldValues;
  readonly before: { fields: FieldValues; customFields: FieldValues } | null;
  readonly employeeRevision: number;
  readonly allowDirectTransfer: boolean;
  readonly allowedActions?: { application: boolean; directList: boolean; directRow: boolean };
}
export interface TransferFormModel {
  readonly initiator?: 'hr' | 'employee';
  readonly employees: readonly EmployeeChoice[];
  readonly departments: readonly Choice[];
  readonly references?: Readonly<Record<string, readonly Choice[]>>;
  readonly catalog: TransferCatalog;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly transferTypeCode: string;
  readonly reasonCode: string;
  readonly fields: FieldValues;
  readonly customFields: FieldValues;
  readonly preview: TransferPreview | null;
  /** HR 入口的联动草稿；本人申请没有联动区块。 */
  readonly linkage?: LinkageDraft;
  /** 可变更的合同（该员工当前有效、操作人可见）。 */
  readonly contracts?: readonly ContractChoice[];
}
export type TransferAction = 'draft' | 'submit' | 'direct';
export interface TransferFormProps {
  readonly model: TransferFormModel;
  readonly busy?: boolean;
  readonly actionsDisabled?: boolean;
  readonly onSelection?: (
    field: 'employeeId' | 'effectiveDate' | 'transferTypeCode' | 'reasonCode',
    value: string,
  ) => void;
  readonly onField?: (source: 'preset' | 'custom', code: string, value: FieldValue) => void;
  readonly onAction?: (action: TransferAction) => void;
  readonly onReferenceQuery?: (code: string, name: string, page: number) => Promise<void>;
  readonly onLinkage?: (patch: Partial<LinkageDraft>) => void;
}
export interface TransferBusiness {
  readonly id: string;
  readonly revision: number;
  readonly employeeRevision: number;
  readonly status: string;
}

/** R1-T10 调动联动的表单草稿（`13` §7：是否变更合同、调整薪资、试岗、交接人；`08` §4：转交职责）。 */
export interface LinkageDraft {
  readonly changeContract: boolean;
  readonly contractTargetId: string;
  readonly contractFields: Readonly<Record<string, string | number | null>>;
  readonly adjustSalary: boolean;
  readonly onTrialMonths: number | null;
  readonly onTrialStartDate: string;
  readonly handoverPersonId: string;
  readonly dutyReceiverId: string;
  readonly dutySubordinateIds: readonly string[];
  readonly transferDepartmentHead: boolean;
}
export interface LinkageItemView {
  readonly id: string;
  readonly revision: number;
  readonly itemType: 'duty_subordinate' | 'duty_org_role' | 'part_time_end';
  readonly subordinateId: string | null;
  readonly orgId: string | null;
  readonly orgRole: string | null;
  readonly receiverId: string | null;
  readonly partTimeRecordId: string | null;
  readonly effectiveDate: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly attemptCount: number;
  readonly failure: { readonly code: string; readonly message: string; readonly rule: string | null } | null;
}
/** GET /transfers/:id/linkage：按权限裁剪后的联动选项与执行结果。 */
export interface LinkageView {
  readonly businessId: string;
  readonly executedAt: string | null;
  readonly contract: { readonly beforeContractId: string | null; readonly afterContractId: string } | null;
  readonly onTrial: { readonly startDate: string; readonly months: number; readonly expectedEndDate: string } | null;
  readonly handover: { readonly handoverStatus: string } | null;
  readonly salaryReminder: { readonly status: string } | null;
  readonly dutyTransfer: {
    readonly total: number;
    readonly failedCount: number;
    readonly items: readonly LinkageItemView[];
  } | null;
  readonly partTimes: readonly LinkageItemView[];
}
