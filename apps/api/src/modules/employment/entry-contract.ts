/**
 * 办理入职生成合同（R2 BE-2b；docs/02_业务建模/34 EN-R11「有合同信息则生成合同」）：
 * 合同信息随办理入职一并提交，在同一事务内调合同模块的 generateContractForBusiness 端口，合同失败整笔回滚。
 * 合同的权限与数据范围按操作人在合同对象上的创建权限与范围重验（端口本身是可信入口，不替调用方授权）。
 * 只接这一处：改期 / 取消 / 删除对合同的影响、入职申请（审批）路径的合同生成原站未验证，不联动（DEC-540）。
 */
import type { Tx } from '@italent/db';
import { CONTRACT_OBJECT } from '@italent/domain';
import type { z } from 'zod';
import type { ContractContext } from '../contracts/context.js';
import { fieldsSchema } from '../contracts/input.js';
import { generateContractForBusiness } from '../contracts/ports.js';
import { resolveModuleScopeInTransaction } from '../permission/module-access.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

/** 合同字段沿用合同模块的白名单；employmentRecordId 由系统关联，不接受请求指定。 */
export const entryContractSchema = fieldsSchema.omit({ employmentRecordId: true });
export type EntryContract = z.infer<typeof entryContractSchema>;

export async function generateEntryContract(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  record: Pick<EmploymentRecord, 'employeeId' | 'effectiveDate'>,
  contract: EntryContract,
) {
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`);
  const contractCtx: ContractContext = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    timezone: ctx.timezone,
    now: ctx.now,
    commandId: ctx.commandId,
    expectedRevision: 0,
    authorize: ctx.authorize,
    scope,
  };
  // 合同生效日缺省取入职日（EN-R11）；可显式给不同的日期
  return generateContractForBusiness(tx, contractCtx, {
    employeeId: record.employeeId,
    fields: { effectiveDate: record.effectiveDate, ...contract },
  });
}
