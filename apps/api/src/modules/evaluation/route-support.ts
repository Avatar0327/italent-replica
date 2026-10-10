/**
 * 人才评定配置路由的公共部分：命令执行（首次与幂等重放都按当前范围复核结果对象、按当前字段权限裁剪响应，
 * DEC-067 / AGENTS §10）。照 qualification/route-support.ts。
 */
import { withTenant } from '@italent/db';
import type { Context } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { scopeAllows } from '../permission/module-access.js';
import { requireVisible, trimEvaluation, type EvaluationContext, type EvaluationObject } from './access.js';
import { rowAccess, type WriteContext } from './store.js';
import type { Tx } from '@italent/db';

export const EV_BASE = '/api/tenant/evaluation';

export type View = { readonly id: string; readonly revision: number; readonly createdBy: string } & Record<
  string,
  unknown
>;

/** 写命令的上下文：请求上下文 + 本对象当前范围（事务外按当前权限解析，命令内逐个复核）。 */
export function writeContext(ctx: EvaluationContext, scope: WriteContext['scope']): WriteContext {
  return { ...ctx, scope };
}

/** 响应按当前字段权限裁剪。 */
export const presenter =
  (deps: TenantRouteDeps, object: EvaluationObject) =>
  <T extends object>(ctx: EvaluationContext, items: T[]) =>
    trimEvaluation(deps, ctx, object, items);

/**
 * 命令执行：范围在事务外按当前权限解析，首次执行在事务内行锁之后复核；首次与幂等重放都按当前范围复核结果对象
 * （撤权后重放 404），响应按当前字段权限裁剪。
 */
export async function runWrite<T extends View>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  w: WriteContext,
  object: EvaluationObject,
  body: object,
  status: 200 | 201,
  execute: (tx: Tx, ctx: WriteContext) => Promise<T>,
) {
  const result = await runCommand(deps.db, w, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: w.expectedRevision, input: body },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...w, commandId }) }),
  });
  const value = result.body as T;
  await requireStillVisible(deps, w, object, value, c.req.method);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${value.revision}"`);
  return c.json((await presenter(deps, object)(w, [value]))[0] as object, result.status);
}

/** 重放时按当前范围复核结果对象：现存对象按读取谓词，已删除对象按快照的创建人（字典的范围锚点）。 */
async function requireStillVisible(
  deps: TenantRouteDeps,
  w: WriteContext,
  object: EvaluationObject,
  value: View,
  method: string,
) {
  if (method === 'DELETE') {
    requireVisible(scopeAllows(w.scope, { creatorId: value.createdBy }), object);
    return;
  }
  await withTenant(deps.db, w.tenantId, async (tx) => {
    requireVisible((await rowAccess(tx, w, w.scope, object, value.id)).visible, object);
  });
}
