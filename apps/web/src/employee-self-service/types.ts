import type { EmployeeChoice, FieldValues, TransferPreview, TransferCatalog } from '../transfer/types.js';
export interface OwnRecord {
  id: string;
  kind?: string;
  effectiveDate?: string;
  stopDate?: string | null;
  approvalStatus?: string;
  fields: FieldValues;
  fieldLabels: Record<string, string>;
}
export interface Profile {
  timezone: string;
  employee: EmployeeChoice;
  today: string;
  record: OwnRecord | null;
}
export interface Application {
  id: string;
  businessId: string;
  revision: number;
  status: string;
  createdAt: string;
  effectiveDate?: string;
  title: string;
  category: string;
  initiator: string;
  currentHandlers: string[];
  reason: string;
}
export interface OwnPreview extends TransferPreview {
  reasons: TransferCatalog['reasons'];
  beforeLabels: Record<string, string>;
  valueLabels: Record<string, string>;
}
