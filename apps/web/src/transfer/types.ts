export type FieldValue = string | number | boolean | readonly string[] | null;
export type FieldValues = Readonly<Record<string, FieldValue>>;
export type FieldMode = 'editable' | 'readonly' | 'hidden' | 'absent';
export interface Choice {
  readonly id: string;
  readonly name: string;
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
}
export interface TransferBusiness {
  readonly id: string;
  readonly revision: number;
  readonly employeeRevision: number;
  readonly status: string;
}
