import type { AppId } from '../permission/app-directory.js';
import type { ApprovalTypeCode } from './types.js';

/**
 * 审批类型 → 应用归属（设计 §2.4）：流程能用哪个应用的应用变量，由流程的审批类型决定。
 * 显式登记而不从目录反推：同一对象（如任职记录）可能出现在多个应用的目录里。
 * 守卫（tests/acceptance/AC-APV-F326-27）核对：覆盖全部审批类型，且类型的对象在该应用目录内。
 */
export const APPROVAL_TYPE_APPS: Readonly<Record<ApprovalTypeCode, AppId>> = {
  contract_create: 'staff',
  contract_renew: 'staff',
  contract_change: 'staff',
  contract_terminate: 'staff',
  emp_info_change: 'staff',
  offer: 'staff',
  offer_batch: 'staff',
  transfer: 'transfer',
  leave: 'transfer',
  regularization: 'transfer',
  intern_regularization: 'transfer',
  hire: 'transfer',
  retirement: 'transfer',
  add_employee: 'transfer',
  retirement_intention: 'transfer',
  exit_handover: 'transfer',
  part_time_add: 'transfer',
  part_time_extend: 'transfer',
  part_time_end: 'transfer',
  probation_assessment: 'transfer',
  regularization_assessment: 'transfer',
  org_adjustment: 'org',
  idp_plan: 'idp',
  idp_mid_review: 'idp',
  idp_final_review: 'idp',
  talent_review_result: 'talent-review',
  personnel_change: 'self',
};

/**
 * 对象不在任何应用菜单目录里的审批类型（组织调整的对象 TenantBase.OrganizationApproval 只有审批入口）：
 * 仍须有应用归属，守卫对它们跳过“对象在目录内”一项；守卫同时核对这里没有过期条目。
 */
export const APPROVAL_TYPES_OUTSIDE_APP_DIRECTORY: readonly ApprovalTypeCode[] = ['org_adjustment'];

/** 应用变量管理页只开审批流程用得到的应用：映射值去重（设计 §2.4）。 */
export const APPROVAL_VARIABLE_APPS: readonly AppId[] = [...new Set(Object.values(APPROVAL_TYPE_APPS))];
