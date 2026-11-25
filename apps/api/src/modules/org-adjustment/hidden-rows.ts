/**
 * 组织对象范围外的明细行（读接口“隐藏行”的同一判定）：整单校验信封要把这些行的问题折叠掉（F-339 ②）。
 * 判定本身在 disclosure.ts 的 `visibleItems`（目标 / 新上级 / 转移目标逐个在组织范围，引用的行也须可见），这里只取它的补集。
 */
import type { Tx } from '@italent/db';
import { MODULE_OBJECTS, ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { AppError } from '../../errors.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { loadOrgCreators, orgAdjustmentDisclosure, orgSectionDisclosed, visibleItems } from './disclosure.js';
import { loadItems, type OrgItem } from './items-store.js';
import { transferSectionDisclosed, visibleTransfers } from './transfer-read.js';
import { loadTransfers } from './transfer-items-store.js';

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
  const orgCreators = await loadOrgCreators(tx, ctx.tenantId, orgScope);
  const shown = new Set(visibleItems({ orgScope, orgCreators }, items).items.map((item) => item.id));
  return new Set(items.filter((item) => !shown.has(item.id)).map((item) => item.id));
}

/**
 * 本单调动行里本人看不到的行 ID（任职对象范围、目标部门组织范围、引用的新增组织行可见性，与读接口 `visibleTransfers` 同一判定）。
 * 写路径的冲突信封只能带本人看得见的调动行 ID，免得借“被引用”探测范围外员工的调动（P2-1）。
 */
export async function hiddenTransferIds(
  tx: Tx,
  deps: Deps,
  ctx: TenantContext,
  adjustmentId: string,
  hiddenOrg: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const orgScope = await resolveModuleScopeInTransaction(bound, ctx, tx, MODULE_OBJECTS.organization.code);
  const orgCreators = await loadOrgCreators(tx, ctx.tenantId, orgScope);
  const employmentScope = await resolveModuleScopeInTransaction(bound, ctx, tx, EMPLOYMENT_OBJECT);
  const transfers = await loadTransfers(tx, ctx.tenantId, adjustmentId);
  const orgItems = await loadItems(tx, ctx.tenantId, adjustmentId);
  const visibleOrg = new Set(orgItems.filter((item) => !hiddenOrg.has(item.id)).map((item) => item.id));
  const { rows } = await visibleTransfers(
    tx,
    ctx.tenantId,
    { orgScope, orgCreators, employmentScope },
    { transfers },
    visibleOrg,
  );
  const shown = new Set(rows.map((row) => row.id));
  return new Set(transfers.filter((row) => !shown.has(row.id)).map((row) => row.id));
}

/**
 * 错误信封里调动行的隐藏集合 = 读接口看不到的行 ∪（调动分区字段全被遮蔽时的全部行）（第 3 轮 P2-2）。
 * 读接口在分区字段全遮蔽时整个分区不披露，信封也不能带任何调动行 ID。写路径的“行不可达”判定仍用 `hiddenTransferIds`。
 */
export async function hiddenTransferRows(
  tx: Tx,
  deps: Deps,
  ctx: TenantContext,
  adjustmentId: string,
  hiddenOrg: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, ORG_ADJUSTMENT_OBJECT_CODE, tx);
  if (transferSectionDisclosed({ fields })) return hiddenTransferIds(tx, deps, ctx, adjustmentId, hiddenOrg);
  return new Set((await loadTransfers(tx, ctx.tenantId, adjustmentId)).map((row) => row.id));
}

/** 信封折叠用：组织行隐藏集合 ∪ 调动行隐藏集合（两种行的 ID 互不相同，可并在一个集合里）。 */
export async function hiddenEnvelopeIds(
  tx: Tx,
  deps: Deps,
  ctx: TenantContext,
  adjustmentId: string,
): Promise<ReadonlySet<string>> {
  const org = await hiddenItemIds(tx, deps, ctx, adjustmentId);
  return new Set([...org, ...(await hiddenTransferRows(tx, deps, ctx, adjustmentId, org))]);
}

/**
 * 审批人回调（审批中编辑 / 同意兜底 / 重提）的信封折叠集合（第 4 轮 P2-3）：与读接口同一份披露
 * （`orgAdjustmentDisclosure`：HR 对象查看权走范围裁剪，否则走审批人路径——节点表单 ∩ 字段查看权，不按范围裁剪）。
 * 分区没披露（节点表单 / 字段权限里没有该分区字段）整区折叠，披露了再按行可见性折叠；读不到本单（404）一律全折叠，fail-closed。
 */
export async function hiddenEnvelopeIdsForViewer(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize' | 'clock'>,
  ctx: TenantContext,
  adjustmentId: string,
): Promise<ReadonlySet<string>> {
  const [items, transfers] = [
    await loadItems(tx, ctx.tenantId, adjustmentId),
    await loadTransfers(tx, ctx.tenantId, adjustmentId),
  ];
  const disclosure = await orgAdjustmentDisclosure(
    tx,
    deps as Parameters<typeof orgAdjustmentDisclosure>[1],
    ctx,
    adjustmentId,
  ).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  });
  const shownOrg = new Set(
    disclosure && orgSectionDisclosed(disclosure) ? visibleItems(disclosure, items).items.map((item) => item.id) : [],
  );
  const shownTransfer = new Set(
    disclosure && transferSectionDisclosed(disclosure)
      ? (await visibleTransfers(tx, ctx.tenantId, disclosure, { transfers }, shownOrg)).rows.map((row) => row.id)
      : [],
  );
  const hidden = [
    ...items.filter((item) => !shownOrg.has(item.id)),
    ...transfers.filter((row) => !shownTransfer.has(row.id)),
  ];
  return new Set(hidden.map((row) => row.id));
}
