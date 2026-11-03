/**
 * 组织对象范围外的明细行（读接口“隐藏行”的同一判定）：整单校验信封要把这些行的问题折叠掉（F-339 ②）。
 * 判定本身在 disclosure.ts 的 `visibleItems`（目标 / 新上级 / 转移目标逐个在组织范围，引用的行也须可见），这里只取它的补集。
 */
import type { Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { visibleItems } from './disclosure.js';
import { loadItems } from './items-store.js';

export async function hiddenItemIds(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize' | 'clock'>,
  ctx: TenantContext,
  adjustmentId: string,
): Promise<ReadonlySet<string>> {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const orgScope = await resolveModuleScopeInTransaction(bound, ctx, tx, MODULE_OBJECTS.organization.code);
  const items = await loadItems(tx, ctx.tenantId, adjustmentId);
  const shown = new Set(visibleItems({ orgScope }, items).items.map((item) => item.id));
  return new Set(items.filter((item) => !shown.has(item.id)).map((item) => item.id));
}
