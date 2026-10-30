/**
 * 办理入职生成合同（R2 BE-2b；docs/02_业务建模/34 EN-R11「有合同信息则生成合同」）：
 * 合同信息随办理入职一并提交，在同一事务内调合同模块的 generateContractForBusiness 端口，合同失败整笔回滚。
 * 合同的权限与数据范围按操作人在合同对象上的创建权限与范围重验（端口本身是可信入口，不替调用方授权）。
 * 只接这一处：改期 / 取消 / 删除对合同的影响、入职申请（审批）路径的合同生成原站未验证，不联动（DEC-540）。
 */
import { sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, buttonResource, contractAction } from '@italent/domain';
import type { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { checkFields, checkOperationScope, rowsOf, type ContractContext } from '../contracts/context.js';
import { fieldsSchema } from '../contracts/input.js';
import { generateContractForBusiness } from '../contracts/ports.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

/** 合同字段沿用合同模块的白名单；employmentRecordId 由系统关联，不接受请求指定。 */
export const entryContractSchema = fieldsSchema.omit({ employmentRecordId: true });
export type EntryContract = z.infer<typeof entryContractSchema>;

async function contractContext(tx: Tx, deps: TenantRouteDeps, ctx: EmploymentContext): Promise<ContractContext> {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    timezone: ctx.timezone,
    now: ctx.now,
    commandId: ctx.commandId,
    expectedRevision: 0,
    // 事务内授权器：读本事务的快照，命令台账重放时看到的是当前权限而不是首次执行时的
    authorize: authorizeInTransaction(deps.authorize, tx),
    scope: await resolveModuleScopeInTransaction(deps, ctx, tx, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`),
  };
}

/** 合同生效日缺省取入职日（EN-R11）；可显式给不同的日期。 */
const contractFields = (record: Pick<EmploymentRecord, 'effectiveDate'>, contract: EntryContract) => ({
  effectiveDate: record.effectiveDate,
  ...contract,
});

/**
 * 带合同信息的入职写入，操作人在合同对象上的当前权限：字段创建权、合同“新建”按钮（与 POST /contracts/commands 同一资源）、
 * 对该员工的合同数据范围。由 CommandGuard.before 在命令事务内调用——首次执行、同键重放、失败回查三个出口都先过它
 * （DEC-385③）；合同端口自己的字段 / 范围复核只在真正执行时才跑，命中命令台账的重放到不了那里。
 * 退休同时返聘（R2-T04 §8.2）传已有员工与返聘日 R，复用同一字段、按钮和范围校验。
 * employeeId 为 null = 员工还没建（新增实习生一体写入）：范围复核留给执行时的合同端口，其余照常。
 */
export async function requireContractCreateAccess(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  owner: { readonly employeeId: string | null; readonly effectiveDate: string },
  contract: EntryContract,
): Promise<void> {
  const access = await contractContext(tx, deps, ctx);
  await checkFields(access, 'create', contractFields(owner, contract));
  await requirePermission(access.authorize!, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: 'object.button',
    resource: buttonResource(CONTRACT_OBJECT, contractAction('create', 'direct'), 'list'),
  });
  if (owner.employeeId)
    await checkOperationScope(tx, access, { employeeId: owner.employeeId, operation: 'create' }, null);
}

/** 办理入职带合同信息：合同归属的员工与生效日取自待入职记录。 */
export async function requireEntryContractAccess(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  recordId: string,
  contract: EntryContract,
): Promise<void> {
  const [owner] = rowsOf<{ employeeId: string; effectiveDate: string }>(
    await tx.execute(sql`
    SELECT b.employee_id AS "employeeId", t.start_date::text AS "effectiveDate"
    FROM employment_business_objects b
    JOIN employment_timeline t ON t.tenant_id=b.tenant_id AND t.record_id=b.id
    WHERE b.tenant_id=${ctx.tenantId} AND b.id=${recordId}::uuid
  `),
  );
  if (!owner) throw new AppError('NOT_FOUND', '任职业务不存在');
  await requireContractCreateAccess(tx, deps, ctx, owner, contract);
}

export async function generateEntryContract(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  record: Pick<EmploymentRecord, 'employeeId' | 'effectiveDate'>,
  contract: EntryContract,
) {
  return generateContractForBusiness(tx, await contractContext(tx, deps, ctx), {
    employeeId: record.employeeId,
    fields: contractFields(record, contract),
  });
}
