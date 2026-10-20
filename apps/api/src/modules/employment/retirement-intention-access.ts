/**
 * 意向退休日期申请的写范围与按钮复核（R2-T04 5d2，设计 §11.1）——HR 路由（创建 / 修改 / 提交 / 撤回）与审批中心经适配器进入的
 * 撤回 / 重提 / 编辑共用这一个入口（DEC-431①）：先取员工锁 → 申请行锁，再在持锁状态下解析当前授权，按实际写入字段复核对象写权 /
 * 字段编辑权 / 按钮，最后检查申请行三坐标写范围。等锁期间被撤权的请求在这里被拒（第 1 轮 P1-2）。
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
import { lockEmploymentEmployee } from './record-store.js';
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
 * 锁序：员工 → 申请行（与服务、审批适配器 lock 同序，审批实例随后才锁）。创建只有员工 ID；其余按申请 ID 先无锁读出员工
 * （员工列创建后冻结），再按序加锁。返回已加锁的申请行；创建返回 null。申请不存在抛 404。
 */
export async function lockIntentionRows(
  tx: Tx,
  ctx: TenantContext,
  target: { readonly employeeId: string } | { readonly intentionId: string },
): Promise<IntentionRow | null> {
  const locking = ctx as unknown as EmploymentContext;
  if ('employeeId' in target) {
    await lockEmploymentEmployee(tx, locking, target.employeeId);
    return null;
  }
  const peek = await loadIntention(tx, ctx.tenantId, target.intentionId);
  await lockEmploymentEmployee(tx, locking, peek.employeeId);
  return loadIntention(tx, ctx.tenantId, target.intentionId, true);
}

export interface IntentionRightRequest {
  readonly operation: 'create' | 'update';
  /** 实际写入的业务字段（创建体 / PATCH 体 / 审批中心重提的修正字段）；空 = 命令式（提交 / 撤回）。 */
  readonly fields: Readonly<Record<string, unknown>>;
  /** 已加锁的申请行；创建没有（写范围由服务按即将写入的快照部门判）。 */
  readonly row: IntentionRow | null;
}

/** 持锁后的当前权限复核：对象写权 + 实际字段的编辑权 + Employment.RetireIntention，再判申请行三坐标写范围。 */
export async function requireIntentionRight(
  tx: Tx,
  scoped: EmploymentContext,
  request: IntentionRightRequest,
): Promise<void> {
  await requireEmploymentWrite(
    scoped,
    request.operation,
    request.fields,
    RETIREMENT_INTENTION_BUTTON,
    EMPLOYMENT_OBJECT,
    {
      commandOnly: Object.keys(request.fields).length === 0,
    },
  );
  if (request.row) await requireIntentionWriteScope(tx, scoped, request.row);
}

/**
 * 审批中心撤回 / 重提 / 编辑的入口（approval/access.ts 的 withdrawGuard / resubmitGuard 调用）：在 requireWithdrawRight /
 * requireResubmitRight 之外，持锁后重解析授权并复核（见文件头）。重提按修正字段复核编辑权，与 HR 直接修改同一口径。
 */
export async function authorizeIntentionApproval(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: TenantContext,
  intentionId: string,
  request: { readonly fields?: Readonly<Record<string, unknown>> } = {},
): Promise<IntentionRow> {
  const row = (await lockIntentionRows(tx, ctx, { intentionId }))!;
  const scoped = await intentionCommandContext(tx, deps, ctx);
  await requireIntentionRight(tx, scoped, { operation: 'update', fields: request.fields ?? {}, row });
  return row;
}
