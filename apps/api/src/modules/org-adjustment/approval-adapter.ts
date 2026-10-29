/**
 * 审批中心的组织调整适配器（R2-T08 设计 §4.1，BE-10a 占位）。
 * 本批只登记业务类型 org_adjustment，占住审批类型、适配器种类与适配器表的位置；模块没有公开路由，不会产生审批实例。
 * BE-10c 接入真适配器（快照、`beforeApprove` 基线判定、各状态回写、审批中编辑、`lockMany`）。
 * 在此之前任何回调都拒绝（409 ORG_ADJUSTMENT_NOT_AVAILABLE），不静默放行。
 */
import { AppError } from '../../errors.js';
import type { BusinessAdapter } from '../approval/adapters.js';

const unavailable = (): never => {
  throw new AppError('CONFLICT', '组织调整审批尚未开放', { reason: 'ORG_ADJUSTMENT_NOT_AVAILABLE' });
};

export const orgAdjustmentAdapter: BusinessAdapter = {
  lock: async () => unavailable(),
  snapshot: async () => unavailable(),
  approved: async () => unavailable(),
  rejected: async () => unavailable(),
  disapproved: async () => unavailable(),
  withdrawn: async () => unavailable(),
  resubmit: async () => unavailable(),
  edit: async () => unavailable(),
};
