/**
 * 组织对象范围外的明细行（读接口“隐藏行”的同一判定）：整单校验信封要把这些行的问题折叠掉（F-339 ②）。
 * 判定本身在 disclosure.ts 的 `visibleItems`（目标 / 新上级 / 转移目标逐个在组织范围，引用的行也须可见），这里只取它的补集。
 */
import type { Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { AppError } from '../../errors.js';
import { visibleItems } from './disclosure.js';
import { loadItems, type OrgItem } from './items-store.js';

export const ROW_NOT_FOUND = '组织调整明细不存在';

/**
 * 按明细 ID 取行时，隐藏行（含其连带行中有隐藏的）与不存在的行同一 404（F-343 ①）。
 * 放在写服务取行的位置（`editable` 之后），与行不存在时的先后一致，旧 revision 也不会把两者区分开。
 */
export function assertRowReachable(items: readonly OrgItem[], itemId: string, hidden: ReadonlySet<string>): void {
  const touched = items.filter((item) => item.id === itemId || item.cascadedFromItemId === itemId);
  if (touched.some((item) => hidden.has(item.id))) throw new AppError('NOT_FOUND', ROW_NOT_FOUND);
}

type RowRef = { readonly itemId?: string } | { readonly orgId?: string } | null | undefined;

/**
 * 请求里按本单行引用的上级 / 转移组织 / 同级来源（`{itemId}`）：引用隐藏行与引用不存在的行同一 404，
 * 不能用虚拟引用探测范围外组织（F-343 ④）。
 */
export function assertRefsReachable(
  input: { readonly parent?: RowRef; readonly transferTo?: RowRef; readonly siblingOf?: RowRef },
  hidden: ReadonlySet<string>,
): void {
  for (const ref of [input.parent, input.transferTo, input.siblingOf]) {
    if (ref && 'itemId' in ref && ref.itemId && hidden.has(ref.itemId)) throw new AppError('NOT_FOUND', ROW_NOT_FOUND);
  }
}

type Deps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

export async function hiddenItemIds(
  tx: Tx,
  deps: Deps,
  ctx: TenantContext,
  adjustmentId: string,
): Promise<ReadonlySet<string>> {
  return hiddenAmong(tx, deps, ctx, await loadItems(tx, ctx.tenantId, adjustmentId));
}

/** 已取出的本单明细里，组织范围外的隐藏行 ID。 */
export async function hiddenAmong(
  tx: Tx,
  deps: Deps,
  ctx: TenantContext,
  items: readonly OrgItem[],
): Promise<ReadonlySet<string>> {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const orgScope = await resolveModuleScopeInTransaction(bound, ctx, tx, MODULE_OBJECTS.organization.code);
  const shown = new Set(visibleItems({ orgScope }, items).items.map((item) => item.id));
  return new Set(items.filter((item) => !shown.has(item.id)).map((item) => item.id));
}
