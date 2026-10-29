/**
 * 组织调整申请单的状态与明细枚举（R2-T08 设计 §2.1 / §2.2 / §3；规格 33「单据状态与执行」，DEC-526④）。
 * 审批状态、执行状态各自一列（§2.1），不合成单一状态；列表下拉 8 项里“草稿”“已暂存”都对应审批状态 0（A-8a）。
 * 文案集中在此（DEC-045），界面与审计不再各写一份。
 */

/** 审批状态（approval_status）：4“生效”复刻不写入，只在下拉与枚举里保留（A-7）。 */
export const ORG_ADJUSTMENT_APPROVAL_STATUS = {
  staged: 0,
  reviewing: 1,
  approved: 2,
  notApproved: 3,
  effective: 4,
  voided: 5,
  rejected: 6,
} as const;
export type OrgAdjustmentApprovalStatus =
  (typeof ORG_ADJUSTMENT_APPROVAL_STATUS)[keyof typeof ORG_ADJUSTMENT_APPROVAL_STATUS];

/** 执行状态（execution_status）：审批通过只排期，执行器领到后才是执行中（§3）。 */
export const ORG_ADJUSTMENT_EXECUTION_STATUS = { pending: 1, executed: 2, executing: 3 } as const;
export type OrgAdjustmentExecutionStatus =
  (typeof ORG_ADJUSTMENT_EXECUTION_STATUS)[keyof typeof ORG_ADJUSTMENT_EXECUTION_STATUS];

export const ORG_ADJUSTMENT_APPROVAL_STATUS_LABELS: Readonly<Record<OrgAdjustmentApprovalStatus, string>> = {
  0: '已暂存',
  1: '审批中',
  2: '审批通过',
  3: '审批未通过',
  4: '生效',
  5: '作废',
  6: '已驳回',
};
export const ORG_ADJUSTMENT_EXECUTION_STATUS_LABELS: Readonly<Record<OrgAdjustmentExecutionStatus, string>> = {
  1: '未执行',
  2: '已执行',
  3: '执行中',
};

/** 列表审批状态下拉 8 项（DEC-526④）：编码是接口取值，状态值由 statusFilterApprovalStatus 换算。 */
export const ORG_ADJUSTMENT_STATUS_FILTERS = [
  { code: 'draft', label: '草稿', approvalStatus: 0 },
  { code: 'staged', label: '已暂存', approvalStatus: 0 },
  { code: 'reviewing', label: '审批中', approvalStatus: 1 },
  { code: 'approved', label: '审批通过', approvalStatus: 2 },
  { code: 'not_approved', label: '审批未通过', approvalStatus: 3 },
  { code: 'effective', label: '生效', approvalStatus: 4 },
  { code: 'voided', label: '作废', approvalStatus: 5 },
  { code: 'rejected', label: '已驳回', approvalStatus: 6 },
] as const satisfies readonly { code: string; label: string; approvalStatus: OrgAdjustmentApprovalStatus }[];
export type OrgAdjustmentStatusFilter = (typeof ORG_ADJUSTMENT_STATUS_FILTERS)[number]['code'];

export function statusFilterApprovalStatus(code: string): OrgAdjustmentApprovalStatus | null {
  return ORG_ADJUSTMENT_STATUS_FILTERS.find((filter) => filter.code === code)?.approvalStatus ?? null;
}

/** 组织明细调整类型（org_adjustment_org_items.adjust_type）。 */
export const ORG_ADJUSTMENT_ORG_ITEM_TYPE = { create: 1, change: 2, deactivate: 3 } as const;
/** 高半级显示 / 低半级显示（half_level）。 */
export const ORG_ADJUSTMENT_HALF_LEVEL = { high: 1, low: 2 } as const;
/** 停用时的编制处理（deactivation_establishment_mode）：方式 1 拍板前关闭（A-4）。 */
export const ORG_ADJUSTMENT_DEACTIVATION_MODE = { reduceParents: 1, transferToTarget: 2 } as const;
/** 明细执行结果（execution_result）：成功 / 失败，可空表示未执行。 */
export const ORG_ADJUSTMENT_ITEM_RESULT = { success: 1, failed: 2 } as const;
/** 明细执行阶段（exec_phase，§7.5）：0 未执行 / 1 组织已写入、任职联动待续 / 2 已完成。 */
export const ORG_ADJUSTMENT_EXEC_PHASE = { pending: 0, employmentPending: 1, done: 2 } as const;
