/**
 * Offer 审批与 Offer 批量审批（R2 BE-14a3，DEC-581；34 §2.1、OF-R15，DEC-532⑦、DEC-533④）。
 * 本文件只放纯规则：可发起判定、批量单的对象 / 字段与子表列；审批类型、审批人取值与预置在 approval/。
 */
import type { OfferApprovalStatus, OfferStatus } from './rules.js';

/** Offer 批量审批单（原站 TenantBase.OfferBatchApproval）：审批中心按它的字段权限披露单据（DEC-057）。 */
export const OFFER_BATCH_OBJECT = 'TenantBase.OfferBatchApproval';
/** OF-R15 标准编码，发起条件“流程编码 等于 该编码”。 */
export const OFFER_BATCH_PROCESS_CODE = 'OfferBatchApprovalProcess';
/** 单据 = 基本信息（审批主体、备注）+ Offer 子表。 */
export const OFFER_BATCH_FIELDS = ['approvalSubjectOrgId', 'remark', 'offers'] as const;
/**
 * 子表 7 列（OF-R15：姓名、学校、学历、计划入职日期、组织全称、岗位、基本工资）+ Offer ID。学校、学历 Offer 上
 * 没有对应字段（OF-R1 字段集未含），恒为空；组织全称给录用部门 ID、岗位给职位 ID，名称由前端按 ID 取；
 * 基本工资取“转正后工资”（见 PR“未决 / 假设”）。
 */
export const OFFER_BATCH_COLUMNS = [
  'offerId',
  'name',
  'school',
  'education',
  'plannedEntryDate',
  'departmentId',
  'positionId',
  'baseSalary',
] as const;
/** Offer 列表 / 详情的审批进度（A19 视图“当前审批人 / 当前审批节点”）：取在途审批实例，只读。 */
export const OFFER_APPROVAL_PROGRESS_FIELDS = ['currentApprovers', 'currentApprovalNode'] as const;
/** 一张批量单的 Offer 数上限（AGENTS §10「批量」：设上限、整单成败）。 */
export const MAX_OFFER_BATCH = 100;

/**
 * 可发起审批：待发且未发起或上次不通过（34 §2.1 行主操作“发起 Offer 审批”）。审批中不能重复发起；审批通过后再次发起
 * 属 OF-R4（“审批通过允许再次发起审批”开关，BE-14a2 / BE-14b），本段不放开。
 */
export const offerApprovable = (offer: {
  readonly status: OfferStatus;
  readonly approvalStatus: OfferApprovalStatus;
}) => offer.status === 'pending' && (offer.approvalStatus === 'unsubmitted' || offer.approvalStatus === 'disapproved');

/** 审批实例结果 → Offer 审批子状态：驳回、撤回回到“未发起审批”，修改后可重新发起。 */
export const OFFER_APPROVAL_OUTCOMES = {
  started: 'approving',
  approved: 'approved',
  disapproved: 'disapproved',
  returned: 'unsubmitted',
} as const satisfies Record<string, OfferApprovalStatus>;
