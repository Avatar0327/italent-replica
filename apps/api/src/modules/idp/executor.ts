/**
 * IDP 写命令的唯一执行器（PR-A 第 4 轮成形；PR #115 第 2 轮 P2-6 起计划、执行人、干预、关键信息同用，不另写执行器）。
 * 范围在事务外按当前权限解析，首次执行在事务内（行锁之后）复核；无论首次还是幂等重放，返回前都：
 * 1. 先复核命令实际用到的权限（嵌套写权限、复制 / 带出源的查看权，只看权限不看数据）；
 * 2. 再按对象**当前**归属复核可写性 / 可见性及相关引用（删除按删除时的受控快照）。
 * 这样重放时引用对象的状态差别不会先于权限门禁暴露（AGENTS §10）。
 */
import { type Tx, withTenant } from '@italent/db';
import type { Context } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { type IdpContext, type ModuleScope, type PermissionCheck, replayChecks } from './access.js';
import type { WriteContext } from './write-support.js';

export interface CommandSpec<T, W extends WriteContext = WriteContext> {
  /** 操作人当前范围（事务外解析）。 */
  readonly scope: ModuleScope;
  readonly status: 200 | 201;
  readonly body: unknown;
  /** 在写上下文上补充模块所需的内容（如计划侧的 HR 范围）。 */
  readonly extend?: (w: WriteContext) => W;
  execute(tx: Tx, ctx: W): Promise<T>;
  /** 返回前（首次与重放）按当前数据复核：范围外 404、仅向下公开可见 403、执行人仍有节点按钮等。 */
  recheck(tx: Tx, scope: ModuleScope, result: T): Promise<void>;
}

/** 命令台账里存的结果：业务视图 + 本命令实际用到的权限（重放时复核）。 */
interface Stored<T> {
  readonly view: T;
  readonly checks: PermissionCheck[];
}

export async function runIdpCommand<T, W extends WriteContext = WriteContext>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: IdpContext,
  spec: CommandSpec<T, W>,
): Promise<{ view: T; status: number }> {
  const extend = spec.extend ?? ((w: WriteContext) => w as W);
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: spec.body },
    execute: async (tx, commandId) => {
      const checks: PermissionCheck[] = [];
      const view = await spec.execute(tx, extend({ ...ctx, commandId, scope: spec.scope, checks }));
      return { status: spec.status, body: { view, checks } satisfies Stored<T> };
    },
  });
  const { view, checks } = result.body as Stored<T>;
  await replayChecks(deps, ctx, checks);
  await withTenant(deps.db, ctx.tenantId, (tx) => spec.recheck(tx, spec.scope, view));
  return { view, status: result.status };
}
