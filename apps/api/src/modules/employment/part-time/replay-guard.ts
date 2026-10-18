/**
 * 兼职写入口的命令内权限复核（设计 §7.2 / §7.3A 第 1 层，PT-3b：新增 / 预览；PT-3c：编辑 / 批量结束；PT-4b：申请入口），
 * 照 employment/replay-guard.ts 的 scopedGuard 写法：
 * runCommand 的三个出口（首次、同键重放、失败回查）都先在命令事务内按**当前**授权重跑 §7.2 该入口整行——员工主职在范围、兼职部门
 * 在范围、新增权 + Employment.PartTime 按钮 + 字段创建权——撤权后重放拿不到台账原响应；原响应里的兼职记录另过统一结果复核
 * （permission/employment-replay.ts，兼职部门取记录当前值，PB-69）。入口与命令内共用 requirePartTimeCreateAccess。
 */
import { buttonResource, PART_TIME_BUTTONS } from '@italent/domain';
import type { Tx } from '@italent/db';
import { requirePermission } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import {
  EMPLOYMENT_OBJECT,
  commandContext,
  requireEmployeeInScope,
  requireScopedEmploymentObject,
  requireEmploymentWrite,
  scopedGuard,
  type ScopedCommandGuard,
} from '../context.js';
import type { EmploymentContext } from '../types.js';
import { partTimeNotFound } from './read.js';
import { loadPartTimeRequest, type PartTimeRequestRow } from './request-store.js';
import { notFound as requestNotFound, requireRequestScope } from './request-service.js';
import { readPartTimeRecords, type PartTimeRecordRow } from './store.js';
import { requirePartTimeRecordScope } from './validation.js';

export interface PartTimeCreateTarget {
  readonly employeeId: string;
  /** requireEmploymentWrite 的载荷：实际写入的字段（兼职类型 / 开始日期 / 结束日期 / 预置字段 / 自定义字段）。 */
  readonly business: object;
  readonly departmentId: string;
  /** 按钮：第 1 个与字段创建权一起判，其余只判按钮；缺省为直接新增。申请入口 = 新增兼职申请（建并提交另加 Employment.Submit）。 */
  readonly buttons?: readonly string[];
}

/**
 * 对象权 + 字段写权 + 按钮的单一入口（直接新增、申请的建 / 改 / 动作共用）：第 1 个按钮与载荷字段一起判，其余按钮只判按钮
 * （同一动作要求“与创建同一按钮 + 动作按钮”的组合，§7.2）；载荷为空的命令式动作按 commandOnly 放行空字段集合。
 */
async function requireWriteButtons(
  scoped: EmploymentContext,
  operation: 'create' | 'update' | 'delete',
  business: object,
  buttons: readonly string[],
): Promise<void> {
  const [first, ...more] = buttons;
  await requireEmploymentWrite(scoped, operation, business, first, undefined, {
    commandOnly: !Object.keys(business).length,
  });
  for (const button of more)
    await requireEmploymentWrite(scoped, operation, {}, button, undefined, { commandOnly: true });
}

/**
 * §7.2 的范围两项（PT-R2 员工按主职在范围、PT-R3 兼职部门在范围）的**唯一入口**：入口（事务内查）、命令 guard、预览共用。
 * 必须是事务内的异步判定：同步的 requireEmploymentScope 遇到带 personQuery 的“直线汇报关系”范围会一律拒绝（第 2 轮 P2-1）。
 */
export async function requirePartTimeScope(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string,
): Promise<void> {
  await requireEmployeeInScope(tx, ctx, employeeId);
  await requireScopedEmploymentObject(tx, ctx, employeeId, departmentId);
}

/** §7.2 预览 / 直接新增行：看全部别名写权 → 员工主职与兼职部门在范围 → 新增权 + 按钮 + 字段创建权。 */
export async function requirePartTimeCreateAccess(
  tx: Tx,
  scoped: EmploymentContext,
  target: PartTimeCreateTarget,
): Promise<void> {
  if (scoped.trustedScopeBypass)
    await requirePermission(scoped.authorize!, {
      ...scoped,
      action: 'tenant.employment.write',
      resource: target.employeeId,
    });
  await requirePartTimeScope(tx, scoped, target.employeeId, target.departmentId);
  await requireWriteButtons(scoped, 'create', target.business, target.buttons ?? [PART_TIME_BUTTONS.direct]);
}

/** 直接新增的命令内复核：按当前授权在命令事务内重过 requirePartTimeCreateAccess。 */
export function partTimeCreateGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  target: PartTimeCreateTarget,
): ScopedCommandGuard {
  return scopedGuard({
    before: async (tx) => requirePartTimeCreateAccess(tx, await commandContext(tx, deps, ctx), target),
  });
}

/** 预览：新增兼职 / 新增兼职申请两个按钮任一即可（§7.2 预览行），两项都无 403。 */
export async function requirePartTimePreviewButton(deps: TenantRouteDeps, ctx: EmploymentContext): Promise<void> {
  const held = async (code: string) =>
    deps.authorize({ ...ctx, action: 'object.button', resource: buttonResource(EMPLOYMENT_OBJECT, code, 'detail') });
  if (!(await held(PART_TIME_BUTTONS.direct)) && !(await held(PART_TIME_BUTTONS.application)))
    throw new AppError('FORBIDDEN', '没有新增兼职的权限');
}

export interface PartTimeWriteTarget {
  /** 目标兼职记录（编辑 1 条，批量结束 1～200 条，已去重小写）。 */
  readonly recordIds: readonly string[];
  /** requireEmploymentWrite 的载荷：实际写入的字段。 */
  readonly business: object;
  /** 按钮编码：Employment.PartTimeEdit / Employment.PartTimeBatchEnd。 */
  readonly button: string;
  /** 编辑改部门时的新部门：新旧部门都要在范围内。 */
  readonly departmentId?: string;
}

/**
 * §7.2 编辑 / 批量结束行的入口与命令内共用判定：目标都存在（否则整体 404）→ 看全部别名另要任职写权 → 每条的兼职部门（及新部门）
 * 在写入口径范围内（范围外与不存在同一个 404，批量任一条被拒整批 404）→ 对象更新权 + 字段写权 + 按钮。返回入口读到的行。
 */
export async function requirePartTimeWriteAccess(
  tx: Tx,
  scoped: EmploymentContext,
  target: PartTimeWriteTarget,
): Promise<PartTimeRecordRow[]> {
  const rows = await readPartTimeRecords(tx, scoped, target.recordIds);
  if (rows.length !== target.recordIds.length) throw partTimeNotFound();
  if (scoped.trustedScopeBypass)
    for (const employeeId of new Set(rows.map((row) => row.employeeId)))
      await requirePermission(scoped.authorize!, {
        ...scoped,
        action: 'tenant.employment.write',
        resource: employeeId,
      });
  for (const row of rows) {
    await requirePartTimeRecordScope(tx, scoped, row, row.departmentId);
    if (target.departmentId) await requirePartTimeRecordScope(tx, scoped, row, target.departmentId);
  }
  await requireEmploymentWrite(scoped, 'update', target.business, target.button);
  return rows;
}

/** 编辑 / 批量结束的命令内复核：按当前授权在命令事务内重过 requirePartTimeWriteAccess（重放、失败回查三个出口，兼职部门取当前值）。 */
export function partTimeWriteGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  target: PartTimeWriteTarget,
): ScopedCommandGuard {
  return scopedGuard({
    before: async (tx) => {
      await requirePartTimeWriteAccess(tx, await commandContext(tx, deps, ctx), target);
    },
  });
}

export interface PartTimeRequestTarget {
  readonly requestId: string;
  readonly operation: 'update' | 'delete';
  /** requireEmploymentWrite 的载荷：修改申请实际改动的字段；提交 / 撤回 / 撤销 / 删除为空。 */
  readonly business: object;
  /** 第 1 个按钮与字段写权一起判，其余只判按钮：申请动作 = 新增兼职申请 + Employment.Submit / Withdraw / Delete，撤销只要 Employment.Revoke。 */
  readonly buttons: readonly string[];
  /** 修改申请时改了兼职部门的新部门：新旧部门都要在范围内。 */
  readonly departmentId?: string;
}

/**
 * §7.2 申请修改 / 提交 / 撤回 / 撤销 / 删除行的入口与命令内共用判定：申请存在（否则 404）→ 看全部别名另要任职写权 → 员工主职与申请
 * 部门在写入口径范围内（范围外与不存在同一个 404；使用用户维度取申请发起人）→ 对象权 + 字段写权 + 按钮。
 * 提交 / 撤回只允许原发起人在命令内的锁内判（PART_TIME_NOT_INITIATOR），这里不管。返回入口读到的申请。
 */
export async function requirePartTimeRequestAccess(
  tx: Tx,
  scoped: EmploymentContext,
  target: PartTimeRequestTarget,
): Promise<PartTimeRequestRow> {
  const request = await loadPartTimeRequest(tx, scoped.tenantId, target.requestId);
  if (!request) throw requestNotFound();
  if (scoped.trustedScopeBypass)
    await requirePermission(scoped.authorize!, {
      ...scoped,
      action: 'tenant.employment.write',
      resource: request.employeeId,
    });
  await requireRequestScope(tx, scoped, request);
  if (target.departmentId && target.departmentId !== request.version.departmentId)
    await requireScopedEmploymentObject(tx, scoped, request.employeeId, target.departmentId);
  await requireWriteButtons(scoped, target.operation, target.business, target.buttons);
  return request;
}

/** 申请入口的命令内复核：按当前授权在命令事务内重过 requirePartTimeRequestAccess（重放、失败回查三个出口，申请部门取当前值）。 */
export function partTimeRequestGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  target: PartTimeRequestTarget,
): ScopedCommandGuard {
  return scopedGuard({
    before: async (tx) => {
      await requirePartTimeRequestAccess(tx, await commandContext(tx, deps, ctx), target);
    },
  });
}
