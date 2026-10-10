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
import { ANCHOR, requireVisible, trimEvaluation, type EvaluationContext, type EvaluationObject } from './access.js';
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

/** 呈现整形（在读事务内，字段权限裁剪之前）：如评审组成员挂上人员引用出口（person-refs.ts）。 */
export type Shaper = (tx: Tx, views: View[]) => Promise<View[]>;

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
  shape?: Shaper,
) {
  const result = await runCommand(deps.db, w, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: w.expectedRevision, input: body },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...w, commandId }) }),
  });
  const value = result.body as T;
  await requireStillVisible(deps, w, object, value, c.req.method);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${value.revision}"`);
  const shaped = shape ? await withTenant(deps.db, w.tenantId, (tx) => shape(tx, [value])) : [value];
  return c.json((await presenter(deps, object)(w, shaped))[0] as object, result.status);
}

/** 重放时按当前范围复核结果对象：现存对象按读取谓词，已删除对象按快照的范围锚点。 */
async function requireStillVisible(
  deps: TenantRouteDeps,
  w: WriteContext,
  object: EvaluationObject,
  value: View,
  method: string,
) {
  if (method === 'DELETE') {
    // 已删除的对象按快照的范围锚点判断：字典按创建人，所属组织对象按所属组织 ∪ 所属人
    const target =
      ANCHOR[object] === 'owned'
        ? { orgId: value.ownerOrgId as string, creatorId: value.ownerId as string }
        : { creatorId: value.createdBy };
    requireVisible(scopeAllows(w.scope, target), object);
    return;
  }
  await withTenant(deps.db, w.tenantId, async (tx) => {
    requireVisible((await rowAccess(tx, w, w.scope, object, value.id)).visible, object);
  });
}
