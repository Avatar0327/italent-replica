import { ORG_ADJUSTMENT_DETAIL_OBJECT_CODE as DETAIL, ORG_ADJUSTMENT_OBJECT_CODE as MAIN } from './fields.js';
import type { ButtonLevel } from '../permission/object-permission.js';

/** R2-T08 §9.3 路由 4：只登记契约，入口/载荷校验随 10b2；editor.drag 只许改行政上级（DEC-659②）。 */
export const ORG_ITEM_ENTRY_BUTTONS = {
  'editor.sub': { objectCode: MAIN, code: 'AddSubOrgApprovalDetails', level: 'app_page', adjustType: 1 },
  'editor.peer': { objectCode: MAIN, code: 'AddPeerOrgApprovalDetail', level: 'app_page', adjustType: 1 },
  'editor.create': { objectCode: MAIN, code: 'AddOrgBtn', level: 'app_page', adjustType: 1 },
  'editor.change': { objectCode: MAIN, code: 'ChangeOrgBtn', level: 'app_page', adjustType: 2 },
  'editor.drag': { objectCode: MAIN, code: 'DragToGenerateOrgApprovalDetails', level: 'app_page', adjustType: 2 },
  'editor.stop': { objectCode: MAIN, code: 'StopOrgBtn', level: 'app_page', adjustType: 3 },
  'detail.create': { objectCode: DETAIL, code: 'OrgAjustDetailCreate', level: 'list', adjustType: 1 },
  'detail.change': { objectCode: DETAIL, code: 'OrgAdjustDetailChange', level: 'list', adjustType: 2 },
  'detail.stop': { objectCode: DETAIL, code: 'orgAdjustDetailStop', level: 'list', adjustType: 3 },
} as const satisfies Record<string, { objectCode: string; code: string; level: ButtonLevel; adjustType: 1 | 2 | 3 }>;
export type OrgItemEntry = keyof typeof ORG_ITEM_ENTRY_BUTTONS;
