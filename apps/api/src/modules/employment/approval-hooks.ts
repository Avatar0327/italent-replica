import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { EmploymentContext } from './types.js';

/** 任职申请与审批中心的挂接端口（R1-T07）；任职模块不 import 审批模块，由审批模块装配时注册实现。 */
export interface EmploymentApprovalHooks {
  /**
   * 提交审批：按审批类型匹配流程并发起（或驳回后同单重提）；失败则整单回滚，申请保持原状态（DEC-054）。
   * 流程编码由审批中心按业务派生，发起人不能指定（PR #35 第二轮清单 14）。
   */
  submitted(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<void>;
  /** 发起人撤回：结束在途实例（AC-TRF-28）。 */
  withdrawn(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<void>;
  /** 删除被驳回的申请：作废退回中的实例。 */
  deleted(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<void>;
}

const unavailable: EmploymentApprovalHooks = {
  submitted: () => Promise.reject(new AppError('SERVICE_UNAVAILABLE', '审批中心未接入，不能提交审批')),
  withdrawn: async () => undefined,
  deleted: async () => undefined,
};
let hooks = unavailable;

export function registerEmploymentApprovalHooks(implementation: EmploymentApprovalHooks): void {
  hooks = implementation;
}

export const employmentApprovalHooks: EmploymentApprovalHooks = {
  submitted: (...args) => hooks.submitted(...args),
  withdrawn: (...args) => hooks.withdrawn(...args),
  deleted: (...args) => hooks.deleted(...args),
};
