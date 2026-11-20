import type { Tx } from '@italent/db';
import { RETIREMENT_BUTTONS } from '@italent/domain';
import type { Context } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { permits, requireEmploymentWrite, tryWriteContext } from './context.js';
import type { ExitItem } from './exit-queries.js';
import { requireBusinessWriteScope } from './replay-guard.js';
import type { EmploymentContext } from './types.js';

export async function requireRetirementRestorePermission(ctx: EmploymentContext) {
  await requireEmploymentWrite(ctx, 'update', {}, RETIREMENT_BUTTONS.cancel, undefined, { commandOnly: true });
}

/** 复用 POST 的对象操作权与范围上下文，调用方按状态字段查看权决定是否查询动作。 */
export async function retirementRestoreContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const ctx = await tryWriteContext(c, deps, 'object.update');
  return ctx && (await permits(() => requireRetirementRestorePermission(ctx))) ? ctx : undefined;
}

/** 用 #432 的撤销记录判定已撤销；读取范围与写范围可能不同，逐单再过 POST 的范围判定。 */
export async function retirementRestoreActions(
  tx: Tx,
  ctx: EmploymentContext | undefined,
  item: Pick<ExitItem, 'id' | 'employeeId' | 'cancellation'>,
) {
  if (!ctx?.authorize || !item.cancellation) return {};
  const authorize = authorizeInTransaction(ctx.authorize, tx);
  if (!(await permits(() => requireBusinessWriteScope(tx, authorize, ctx, item.id, item.employeeId)))) return {};
  return { actions: ['restore'] as const };
}
