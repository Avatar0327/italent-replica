/**
 * 组织调整详情与明细分区（R2-T08 §10 路由 13 / 14、§4.5；BE-10d）。
 * - 详情：可见头字段（派生名称跟随源字段）+ revision（并发元数据）+ 最新审批实例 ID + 各分区 {count, hiddenRowCount}；
 *   分区没有可见行或该分区字段全不披露时不返回。本片只有组织分区，其它分区随 11c～11f。
 * - 明细：只有 org 分区，其它分区与未知分区 404；行可见性见 disclosure.visibleItems，列按 `orgItems.*` 字段裁剪，
 *   行身份列（id / seq / 连带发起行 / 基线）总返回，执行结果四列跟随所在行（§4.5“执行结果三列跟随所在行的可见性”）。
 */
import { sql, type Tx } from '@italent/db';
import {
  ORG_ADJUSTMENT_ITEM_RESULT_LABELS,
  ORG_ADJUSTMENT_ORG_ITEM_TYPE_LABELS,
  ORG_ADJUSTMENT_STAGED_LABEL,
} from '@italent/domain';
import { rowsOf } from '../org/read-model.js';
import { scopeAllows } from '../permission/module-access.js';
import { canSee, notFound, orgSectionDisclosed, visibleItems, type Disclosure } from './disclosure.js';
import { CONTENT_KEYS, loadItems, type OrgItem } from './items-store.js';
import { loadHead, orgNamesAt, projectHeads } from './queries.js';

export const ORG_SECTION = 'org';

/** 详情（路由 13）。 */
export async function readDetail(tx: Tx, tenantId: string, disclosure: Disclosure) {
  const head = await loadHead(tx, tenantId, disclosure.view.id);
  if (!head) throw notFound();
  const [projected] = await projectHeads(tx, tenantId, [head], disclosure.fields);
  const sections: Record<string, { count: number; hiddenRowCount: number }> = {};
  if (orgSectionDisclosed(disclosure)) {
    const { items, hiddenRowCount } = visibleItems(disclosure, await loadItems(tx, tenantId, head.id));
    // §10 分区为空不返回：按查看人可见的行数判断，全部行被隐去时同样不返回（不经分区露出“有隐藏行”）。
    if (items.length > 0) sections[ORG_SECTION] = { count: items.length, hiddenRowCount };
  }
  return { ...projected, revision: head.revision, approvalInstanceId: disclosure.instanceId, sections };
}

interface ExecutionResult {
  readonly id: string;
  readonly result: 1 | 2 | null;
  readonly reason: string | null;
  readonly message: string | null;
}

async function executionResults(tx: Tx, tenantId: string, adjustmentId: string) {
  const rows = rowsOf<ExecutionResult>(
    await tx.execute(sql`SELECT id, execution_result AS result, execution_reason AS reason,
        execution_message AS message
      FROM org_adjustment_org_items WHERE tenant_id = ${tenantId} AND adjustment_id = ${adjustmentId}`),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/** 变更 / 停用行的原上级：取行基线版本的行政上级（“变更前”从版本链取，不单独建列）。 */
async function baselineParents(tx: Tx, tenantId: string, items: readonly OrgItem[]) {
  const versionIds = [...new Set(items.flatMap((item) => (item.baseVersionId ? [item.baseVersionId] : [])))];
  if (!versionIds.length) return new Map<string, string | null>();
  const rows = rowsOf<{ versionId: string; parentOrgId: string | null }>(
    await tx.execute(sql`SELECT version_id AS "versionId", parent_org_id AS "parentOrgId" FROM org_hierarchy_links
      WHERE tenant_id = ${tenantId} AND dimension = 'admin'
        AND version_id = ANY(${`{${versionIds.join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((row) => [row.versionId, row.parentOrgId]));
}

/** 明细（路由 14）：section 只接受 org；分区字段全不披露时与不存在同一 404。 */
export async function readItems(tx: Tx, tenantId: string, disclosure: Disclosure, section: string) {
  if (section !== ORG_SECTION || !orgSectionDisclosed(disclosure)) throw notFound();
  const view = disclosure.view;
  const all = await loadItems(tx, tenantId, view.id);
  const { items, hiddenRowCount } = visibleItems(disclosure, all);
  const results = await executionResults(tx, tenantId, view.id);
  const parents = await baselineParents(tx, tenantId, items);
  // 原上级不参与行可见性，但同样按 HR 的组织对象范围复核：范围外的给 null，不带出名称（§4.5，F-339 同类）。
  const scope = disclosure.orgScope;
  if (scope) {
    for (const [versionId, orgId] of parents) {
      if (orgId && !scopeAllows(scope, { orgId })) parents.set(versionId, null);
    }
  }
  const orgIds = items.flatMap((item) => [
    item.targetOrgId,
    item.parentOrgId,
    item.transferToOrgId,
    item.baseVersionId ? (parents.get(item.baseVersionId) ?? null) : null,
  ]);
  const names = await orgNamesAt(
    tx,
    tenantId,
    orgIds.filter((id): id is string => !!id),
    view.effectiveDate,
  );
  const itemNames = new Map(items.map((item) => [item.id, item.name]));
  const context = { fields: disclosure.fields, names, itemNames, parents, results };
  return { adjustmentId: view.id, section, items: items.map((item) => projectItem(item, context)), hiddenRowCount };
}

interface ProjectContext {
  readonly fields: ReadonlySet<string> | undefined;
  readonly names: ReadonlyMap<string, string>;
  readonly itemNames: ReadonlyMap<string, string | null>;
  readonly parents: ReadonlyMap<string, string | null>;
  readonly results: ReadonlyMap<string, ExecutionResult>;
}

/** 有引用的列（上级、转移目标）连同名称一起出现或隐去；引用本单新增行时名称跟随 `orgItems.name`。 */
function projectItem(item: OrgItem, context: ProjectContext) {
  const { fields, names } = context;
  const see = (field: string) => canSee(fields, `orgItems.${field}`);
  const orgName = (orgId: string | null) => (orgId ? (names.get(orgId) ?? null) : null);
  const refName = (orgId: string | null, itemId: string | null) =>
    orgId ? orgName(orgId) : itemId && see('name') ? (context.itemNames.get(itemId) ?? null) : null;
  const out: Record<string, unknown> = {
    id: item.id,
    seq: item.seq,
    cascadedFromItemId: item.cascadedFromItemId,
    baseVersionId: item.baseVersionId,
    baseOrgRevision: item.baseOrgRevision,
  };
  if (see('adjustType')) {
    Object.assign(out, {
      adjustType: item.adjustType,
      adjustTypeLabel: ORG_ADJUSTMENT_ORG_ITEM_TYPE_LABELS[item.adjustType],
    });
  }
  if (see('targetOrgId'))
    Object.assign(out, { targetOrgId: item.targetOrgId, targetOrgName: orgName(item.targetOrgId) });
  if (see('targetOrgId') && see('parentOrgId')) {
    const original = item.baseVersionId ? (context.parents.get(item.baseVersionId) ?? null) : null;
    Object.assign(out, { originalParentOrgId: original, originalParentOrgName: orgName(original) });
  }
  for (const key of CONTENT_KEYS) {
    if (key === 'parentItemId' || key === 'transferToItemId') continue;
    if (key === 'parentOrgId' || key === 'transferToOrgId') continue;
    if (see(key)) out[key] = item[key];
  }
  if (see('parentOrgId')) {
    Object.assign(out, {
      parentOrgId: item.parentOrgId,
      parentItemId: item.parentItemId,
      parentOrgName: refName(item.parentOrgId, item.parentItemId),
    });
  }
  if (see('transferToOrgId')) {
    Object.assign(out, {
      transferToOrgId: item.transferToOrgId,
      transferToItemId: item.transferToItemId,
      transferToOrgName: refName(item.transferToOrgId, item.transferToItemId),
    });
  }
  if (see('isStaged')) {
    Object.assign(out, { isStaged: item.isStaged, stagedLabel: item.isStaged ? ORG_ADJUSTMENT_STAGED_LABEL : null });
  }
  const result = context.results.get(item.id);
  const code = result?.result ?? null;
  return Object.assign(out, {
    executionResult: code,
    executionResultLabel: code ? ORG_ADJUSTMENT_ITEM_RESULT_LABELS[code] : null,
    executionReason: result?.reason ?? null,
    executionMessage: result?.message ?? null,
  });
}
