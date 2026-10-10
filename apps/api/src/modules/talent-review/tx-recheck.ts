/**
 * 盘点配置写命令的事务内重新授权（AGENTS §10 权限、DEC-067；照 evaluation/route-support.ts 的 runGuarded）：
 * 外层检查通过之后、命令事务提交之前，管理员可能撤掉按钮 / 数据操作权 / 范围 / 字段目录范围。所以首次执行、直接重放、
 * 并发败者失败后回查三条路径都在**命令事务内**重新解析：对象数据操作权 + 按钮、数据范围（resolveModuleScopeInTransaction，
 * 不用带请求缓存的 requestScope）、提交字段的编辑权。拒绝即整体回滚：业务写、revision、审计、命令台账都不提交。
 * 返回台账结果前再按事务内的范围复核结果对象可见性（撤权后 404）。不改 config-kit 的共用签名。
 */
import type { Tx } from '@italent/db';
import type { Context } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import {
  codeOf,
  checkWriteFields,
  type ModuleScope,
  requireConfigVisible,
  reviewWriteContext,
  type TalentReviewContext,
} from './access.js';
import type { ConfigObject } from './config-kit.js';

export interface Rechecked {
  /** 绑定了当前命令事务的依赖：之后的授权判定（字段目录访问、披露权限…）都用它。 */
  readonly txDeps: TenantRouteDeps;
  readonly ctx: TalentReviewContext;
  /** 本对象在事务内解析的当前数据范围。 */
  readonly scope: ModuleScope;
}

/** 对象数据操作权 + 按钮 + 范围 + （新建 / 修改）提交字段的编辑权，全部在事务内按当前授权重新判定。 */
export async function recheckWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  object: ConfigObject,
  operation: 'create' | 'update' | 'delete',
  expectedRevision: number,
  payload?: Readonly<Record<string, unknown>>,
): Promise<Rechecked> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = await reviewWriteContext(c, txDeps, object, operation, expectedRevision);
  const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf(object));
  if (operation !== 'delete' && payload) await checkWriteFields(txDeps, ctx, object, operation, payload);
  return { txDeps, ctx, scope };
}

/** 返回台账结果前：结果对象按事务内的当前范围仍须可见（撤范围后重放 404）。 */
export function requireResultVisible(scope: ModuleScope, object: ConfigObject, view: unknown): void {
  requireConfigVisible(scope, object, (view as { createdBy: string | null }).createdBy);
}
