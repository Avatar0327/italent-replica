import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { PersonnelContext } from './store.js';

/** 人员自助变更申请与审批中心的挂接端口（R1-T07）；由审批模块装配时注册实现。 */
export interface PersonnelApprovalHooks {
  /** 申请创建后同事务发起“员工子集变更”审批；没有可用流程时整单回滚（DEC-017）。 */
  submitted(tx: Tx, ctx: PersonnelContext, requestId: string): Promise<void>;
}

let hooks: PersonnelApprovalHooks = {
  submitted: () => Promise.reject(new AppError('SERVICE_UNAVAILABLE', '审批中心未接入，不能提交申请')),
};

export function registerPersonnelApprovalHooks(implementation: PersonnelApprovalHooks): void {
  hooks = implementation;
}

export const personnelApprovalHooks: PersonnelApprovalHooks = {
  submitted: (...args) => hooks.submitted(...args),
};
