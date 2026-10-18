/**
 * 兼职申请的状态机（docs/08_设计/R2-T05_兼职设计.md §2.2）：状态集合与任职业务一致，迁移表另写一份小表，不复用
 * transitionEmployment（后者只认 employment_business_objects）。approved 与 effective 是两条事件（硬规则 4）：
 * 末节点同意的同一事务先写 approved，再落地成功写 effective，落地复核失败写 voided；没有“approved 停留待调度”的中间态。
 */
import type { PartTimeRequestState } from './part-time-constants.js';

export type PartTimeRequestAction =
  'submit' | 'approve' | 'reject' | 'disapprove' | 'withdraw' | 'revoke' | 'delete' | 'land' | 'void';

const TRANSITIONS: Readonly<
  Record<PartTimeRequestState, Partial<Record<PartTimeRequestAction, PartTimeRequestState>>>
> = {
  draft: { submit: 'in_review', delete: 'deleted', revoke: 'voided', void: 'voided' },
  in_review: {
    approve: 'approved',
    reject: 'rejected',
    disapprove: 'disapproved',
    withdraw: 'draft',
    revoke: 'voided',
    void: 'voided',
  },
  rejected: { submit: 'in_review', delete: 'deleted', revoke: 'voided', void: 'voided' },
  // 落地复核失败的作废发生在 approved 上（§4.4）；effective 之后的申请办结，不再迁移
  approved: { land: 'effective', void: 'voided' },
  disapproved: {},
  voided: {},
  effective: {},
  deleted: {},
};

/** 动作后的状态；该状态下不允许此动作返回 null。 */
export function nextPartTimeRequestState(
  state: PartTimeRequestState,
  action: PartTimeRequestAction,
): PartTimeRequestState | null {
  return TRANSITIONS[state][action] ?? null;
}

/** 未办结：草稿 / 审批中 / 驳回（离职、调动作废的对象，E-4 与外派 / 借调唯一校验同口径）。 */
export const PART_TIME_REQUEST_OPEN_STATES: readonly PartTimeRequestState[] = ['draft', 'in_review', 'rejected'];

/** 组织停用计数口径（§6.3）：审批中或已批未落地的新增申请（未落地的瞬时态不存在，实际只有 in_review）。 */
export const PART_TIME_REQUEST_PENDING_STATES: readonly PartTimeRequestState[] = ['in_review', 'approved'];
