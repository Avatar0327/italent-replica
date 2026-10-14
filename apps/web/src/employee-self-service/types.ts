import type { EmployeeChoice, FieldValues, TransferPreview, TransferCatalog } from '../transfer/types.js';
import type { AvatarReference } from '../account/avatar-api.js';
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
  employee: EmployeeChoice & { readonly avatar?: AvatarReference | null };
  today: string;
  record: OwnRecord | null;
  /** 本人入口判定的本人调动按钮（员工自动身份只作用于本人入口，不走通用权限查询）。 */
  selfServiceButtons?: readonly { buttonCode: string; level: string }[];
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
