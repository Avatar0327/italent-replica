/**
 * 意向退休日期申请的写范围与按钮复核（R2-T04 5d2，设计 §11.1）——HR 路由（创建 / 修改 / 提交 / 撤回）与审批中心经适配器进入的
 * 撤回 / 重提（approval/access.ts 的 withdrawGuard / resubmitGuard）共用这一个入口，全部在命令事务内、按“当前”授权判定。
 * 写入口径与任职模块同一分工（DEC-193）：scopeAllowsInTransaction 的三个坐标取申请行自己的列——部门 = 申请时快照、员工 =
 * 申请员工、创建人 = 本表发起人；不用 employmentVisibilitySql（它只管看），也不查任职业务创建人（意向 ID 不在业务头表）。
 */
import type { Tx } from '@italent/db';
import { RETIREMENT_INTENTION_BUTTON } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllowsInTransaction,
} from '../permission/module-access.js';
import { EMPLOYMENT_OBJECT, requireEmploymentWrite } from './context.js';
import { loadIntention, type IntentionRow } from './retirement-intention-store.js';
import type { EmploymentContext } from './types.js';

export interface IntentionWriteTarget {
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly initiatorUserId: string;
}

/** 范围外与不存在同一个 404（不泄露存在性）；拒绝发生在任何写之前。ctx.scope 缺省（可信端口）不设限。 */
export async function requireIntentionWriteScope(
  tx: Tx,
  ctx: EmploymentContext,
  target: IntentionWriteTarget,
): Promise<void> {
  if (!ctx.scope || ctx.scope.all) return;
  const allowed = await scopeAllowsInTransaction(tx, ctx.scope, {
    personId: target.employeeId,
    orgId: target.departmentId,
    creatorId: target.initiatorUserId,
  });
  if (!allowed) throw new AppError('NOT_FOUND', '意向退休申请不存在');
}

/** 审批中心命令里的上下文：授权器绑定本事务，数据范围按当前授权在本事务内解析（不沿用请求前的快照）。 */
export async function intentionCommandContext(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: TenantContext,
): Promise<EmploymentContext> {
  return {
    ...ctx,
    now: deps.clock(),
    commandId: '',
    expectedRevision: 0,
    objectCode: EMPLOYMENT_OBJECT,
    authorize: authorizeInTransaction(deps.authorize, tx),
    scope: await resolveModuleScopeInTransaction(deps, ctx, tx, EMPLOYMENT_OBJECT),
  };
}

/**
 * 审批中心对意向申请的撤回 / 重提：在 requireWithdrawRight / requireResubmitRight 之外，再过写范围（记录部门快照）与按钮，
 * 两道都过才执行（设计 §11.2）。重提还复核对象更新权。
 */
export async function requireIntentionApprovalRight(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: TenantContext,
  intentionId: string,
  operation: 'withdraw' | 'resubmit',
): Promise<IntentionRow> {
  const row = await loadIntention(tx, ctx.tenantId, intentionId);
  const scoped = await intentionCommandContext(tx, deps, ctx);
  await requireEmploymentWrite(scoped, 'update', {}, RETIREMENT_INTENTION_BUTTON, EMPLOYMENT_OBJECT, {
    commandOnly: operation === 'withdraw' || operation === 'resubmit',
  });
  await requireIntentionWriteScope(tx, scoped, row);
  return row;
}
