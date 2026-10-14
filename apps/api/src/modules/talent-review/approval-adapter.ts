/**
 * 审批中心的盘点结果审批适配器（R3-T04 C-08；设计 §3.3 N12）。PR-A 只登记业务类型 talent_review，占住审批类型、
 * 业务类型与适配器表的位置（R3-T02 C2 / #115 同样改这三处，谁先合并谁占位）；本 PR 没有发起入口，不会产生实例。
 * PR-D 接入：快照（fieldObjectCode = TalentReview.ResultApproval，各对象校准后字段作 foreignFields）、
 * subjects（审批单 → 全部被盘点人，F-048 契约）、通过写回对象与 result_seq、不同意保持对象不变。
 * 在此之前任何回调都拒绝（409），不静默放行。
 */
import { AppError } from '../../errors.js';
import type { BusinessAdapter } from '../approval/adapters.js';

const unavailable = (): never => {
  throw new AppError('CONFLICT', '盘点结果审批尚未开放', { reason: 'TALENT_REVIEW_APPROVAL_UNAVAILABLE' });
};

export const talentReviewAdapter: BusinessAdapter = {
  lock: async () => unavailable(),
  snapshot: async () => unavailable(),
  approved: async () => unavailable(),
  rejected: async () => unavailable(),
  disapproved: async () => unavailable(),
  withdrawn: async () => unavailable(),
  resubmit: async () => unavailable(),
  edit: async () => unavailable(),
};
