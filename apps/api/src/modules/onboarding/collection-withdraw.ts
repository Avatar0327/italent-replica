/**
 * 16a-2c 采集撤回受信内核（设计 §4.1 第 7 条 / §5 撤回授权）。
 * 红测提交只放“入口关闭”的占位：旧实现没有撤回，生产公开执行路由保持未注册。
 */
import type { Tx } from '@italent/db';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { EntryCaseWriteRef } from '../employment/onboarding-entry-port.js';
import type { EmploymentContext } from '../employment/types.js';

export interface CollectionWithdrawContext extends EmploymentContext {
  readonly authorize: Authorizer;
}

export interface CollectionWithdrawTarget extends EntryCaseWriteRef {
  readonly taskId: string;
}

export interface CandidateIdentityPort {
  verify(tx: Tx, subject: { tenantId: string; taskId: string; employeeId: string }): Promise<boolean>;
}

export interface CollectionWithdrawReceipt {
  readonly id: string;
  readonly revision: number;
  readonly status: 'withdrawn';
  readonly notificationStatus: 'unavailable';
}

export async function withdrawCollection(
  _tx: Tx,
  _ctx: CollectionWithdrawContext,
  _target: CollectionWithdrawTarget,
  _input: { readonly remark: string },
  _identity: CandidateIdentityPort,
): Promise<CollectionWithdrawReceipt> {
  throw new AppError('CONFLICT', '采集撤回入口尚未开通', { reason: 'COLLECTION_WITHDRAW_UNAVAILABLE' });
}
