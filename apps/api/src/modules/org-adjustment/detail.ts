/**
 * 组织调整详情与明细分区（R2-T08 §10 路由 13 / 14、§4.5；BE-10d）。
 * - 详情：可见头字段（派生名称跟随源字段）+ revision（并发元数据）+ 最新审批实例 ID + 各分区 {count, hiddenRowCount}；
 *   分区没有可见行或该分区字段全不披露时不返回。本片只有组织分区，其它分区随 11c～11f。
 * - 明细：只有 org 分区，其它分区与未知分区 404；行可见性见 disclosure.visibleItems，列按 `orgItems.*` 字段裁剪，
 *   行身份列（id / seq / 连带发起行 / 基线）总返回，执行结果四列跟随所在行（§4.5“执行结果三列跟随所在行的可见性”）。
 */
import type { Tx } from '@italent/db';
import {
  ORG_ADJUSTMENT_ITEM_RESULT_LABELS,
  ORG_ADJUSTMENT_ORG_ITEM_TYPE_LABELS,
  ORG_ADJUSTMENT_STAGED_LABEL,
} from '@italent/domain';
import { scopeAllows } from '../permission/module-access.js';
import { loadOrgContent, type ExecutionResult, type OrgContent } from './content.js';
import { canSee, notFound, orgSectionDisclosed, visibleItems, type Disclosure } from './disclosure.js';
import { CONTENT_KEYS, type OrgItem } from './items-store.js';
import { projectHeadRows } from './queries.js';

export const ORG_SECTION = 'org';

/** 内容源：办理时冻结份（已办）或现值（在办 / HR）；两个读入口共用，之后只做纯投影（F-476 §5.4）。 */
async function sourceOf(tx: Tx, tenantId: string, disclosure: Disclosure): Promise<OrgContent> {
  if (disclosure.source) return disclosure.source;
  const live = await loadOrgContent(tx, tenantId, disclosure.view.id);
  if (!live) throw notFound();
  return live;
}

/** 详情（路由 13）。 */
export async function readDetail(tx: Tx, tenantId: string, disclosure: Disclosure) {
  const source = await sourceOf(tx, tenantId, disclosure);
  const { head } = source;
  const { fields } = disclosure;
  const ranges = canSee(fields, 'adjustmentRange') ? new Map([[head.id, source.ranges]]) : null;
  const names =
    canSee(fields, 'createdBy') && source.creatorName ? new Map([[head.createdBy, source.creatorName]]) : null;
  const [projected] = projectHeadRows([head], fields, ranges, names);
  const sections: Record<string, { count: number; hiddenRowCount: number }> = {};
  if (orgSectionDisclosed(disclosure)) {
    const { items, hiddenRowCount } = visibleItems(disclosure, source.items);
    // §10 分区为空不返回：按查看人可见的行数判断，全部行被隐去时同样不返回（不经分区露出“有隐藏行”）。
    if (items.length > 0) sections[ORG_SECTION] = { count: items.length, hiddenRowCount };
  }
  return { ...projected, revision: head.revision, approvalInstanceId: disclosure.instanceId, sections };
}

/** 明细（路由 14）：section 只接受 org；分区字段全不披露时与不存在同一 404。 */
export async function readItems(tx: Tx, tenantId: string, disclosure: Disclosure, section: string) {
  if (section !== ORG_SECTION || !orgSectionDisclosed(disclosure)) throw notFound();
  const source = await sourceOf(tx, tenantId, disclosure);
  const { items, hiddenRowCount } = visibleItems(disclosure, source.items);
  const results = new Map(source.results.map((row) => [row.id, row]));
  // 原上级不参与行可见性，但同样按 HR 的组织对象范围复核：范围外的给 null，不带出名称（§4.5，F-339 同类）。
  const scope = disclosure.orgScope;
  const parents = new Map(Object.entries(source.parents));
  if (scope) {
    for (const [versionId, orgId] of parents) {
      if (orgId && !scopeAllows(scope, { orgId })) parents.set(versionId, null);
    }
  }
  const names = new Map(Object.entries(source.names));
  const itemNames = new Map(items.map((item) => [item.id, item.name]));
  const context = { fields: disclosure.fields, names, itemNames, parents, results };
  const projected = items.map((item) => projectItem(item, context));
  return { adjustmentId: source.head.id, section, items: projected, hiddenRowCount };
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
