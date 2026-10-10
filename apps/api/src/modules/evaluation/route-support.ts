/**
 * 人才评定配置路由的公共部分：命令执行（首次与幂等重放都按当前范围复核结果对象、按当前字段权限裁剪响应，
 * DEC-067 / AGENTS §10）。照 qualification/route-support.ts。
 */
import type { Context } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction, scopeAllows } from '../permission/module-access.js';
import {
  checkWriteFields,
  codeOf,
  type EvaluationContext,
  type EvaluationObject,
  evaluationWriteContext,
  requireVisible,
  trimEvaluation,
} from './access.js';
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
 * 命令事务内的当前权限复核（首次执行与各重放路径都经过，写入之前；AGENTS §10 权限、DEC-067）：对象数据操作权、按钮与
 * 数据范围都在**事务内**按当前授权重新解析，不沿用事务外保存的快照。拒绝即整体回滚：业务写、审计、命令台账都不提交。
 * 返回台账结果的两条路径（直接重放、并发败者失败后回查）都经过 commands.ts 的同一出口 ledgerExit，先跑本复核、
 * 再按当前范围复核结果对象（requireStillVisible），撤权后都拿不到首次结果（#199 第 3 轮）。
 */
async function recheck(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  w: WriteContext,
  object: EvaluationObject,
  operation: 'create' | 'update' | 'delete',
): Promise<{ readonly txDeps: TenantRouteDeps; readonly ctx: EvaluationContext; readonly write: WriteContext }> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = await evaluationWriteContext(c, txDeps, object, operation, w.expectedRevision);
  const write = { ...w, scope: await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf(object)) };
  return { txDeps, ctx, write };
}

/** 新建 / 修改：另复核字段编辑权（含显式清空）。 */
async function recheckFields(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  w: WriteContext,
  object: EvaluationObject,
  body: object,
): Promise<WriteContext> {
  const operation = c.req.method === 'POST' ? 'create' : 'update';
  const { txDeps, ctx, write } = await recheck(c, deps, tx, w, object, operation);
  await checkWriteFields(txDeps, ctx, object, operation, body as Record<string, unknown>);
  return write;
}

type Execute<T extends View> = (tx: Tx, ctx: WriteContext) => Promise<T>;

/**
 * 命令执行：权限与范围在命令事务内按当前授权复核（首次、直接重放与失败后回查都经过），首次执行再在行锁之后复核对象；
 * 返回台账结果时结果对象按当前范围仍须可见（撤权后 404），响应按当前字段权限裁剪。
 */
export function runWrite<T extends View>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  w: WriteContext,
  object: EvaluationObject,
  body: object,
  status: 200 | 201,
  execute: Execute<T>,
) {
  return runGuarded(c, deps, w, object, body, status, execute, (tx) => recheckFields(c, deps, tx, w, object, body));
}

/** 删除：无字段输入，只复核对象数据操作权、按钮与范围。 */
export function runDelete<T extends View>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  w: WriteContext,
  object: EvaluationObject,
  id: string,
  execute: Execute<T>,
) {
  const before = async (tx: Tx) => (await recheck(c, deps, tx, w, object, 'delete')).write;
  return runGuarded(c, deps, w, object, { id }, 200, execute, before);
}

async function runGuarded<T extends View>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  w: WriteContext,
  object: EvaluationObject,
  body: object,
  status: 200 | 201,
  execute: Execute<T>,
  recheckInTx: (tx: Tx) => Promise<WriteContext>,
) {
  let current = w;
  const result = await runCommand(deps.db, w, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: w.expectedRevision, input: body },
    guard: {
      before: async (tx) => {
        current = await recheckInTx(tx);
      },
      replayed: (tx, replay) => requireStillVisible(tx, current, object, replay.body as View, c.req.method),
    },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...current, commandId }) }),
  });
  const value = result.body as T;
  if (c.req.method !== 'DELETE') c.header('ETag', `"${value.revision}"`);
  return c.json((await presenter(deps, object)(w, [value]))[0] as object, result.status);
}

/** 重放时按当前范围复核结果对象（事务内）：现存对象按读取谓词，已删除对象按快照的创建人（字典的范围锚点）。 */
async function requireStillVisible(tx: Tx, w: WriteContext, object: EvaluationObject, value: View, method: string) {
  if (method === 'DELETE') {
    requireVisible(scopeAllows(w.scope, { creatorId: value.createdBy }), object);
    return;
  }
  requireVisible((await rowAccess(tx, w, w.scope, object, value.id)).visible, object);
}
