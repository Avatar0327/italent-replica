/**
 * 组织列表（带在岗人数 / 总数）与完整组织树的读取（F-474-2b #1，R1a §2.2）。
 * 都在同一查看人范围下取数：范围谓词在 SQL 内先于分页，总数与列表同口径；范围外的节点不出现，
 * 在岗人数也只统计范围内人员（headcount.ts），不留计数侧信道。
 */
import type { Tx } from '@italent/db';
import type { OrgDimension } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ModuleScope } from '../permission/module-access.js';
import { type DimensionEdges, loadDimensionEdges, readHeadcounts } from './headcount.js';
import { countOrgSnapshot, displayOrganization, loadOrgSnapshot, type OrgRecord } from './read-model.js';
import { nearestVisibleParents } from './tree.js';

/** 防御上限：超过时 413，不返回截断的树（截断会让使用者误以为组织就这些）。 */
export const ORG_TREE_NODE_LIMIT = 2000;

export interface OrgViewQuery {
  readonly tenantId: string;
  readonly asOf: string;
  readonly dimension: OrgDimension;
  readonly includeDisabled: boolean;
  readonly scope: ModuleScope;
  readonly name?: string | undefined;
  readonly fullNameStartLevel: number;
}

const filterOf = (q: OrgViewQuery) => ({
  scope: q.scope,
  includeDisabled: q.includeDisabled,
  dimension: q.dimension,
  name: q.name,
});

export type OrgWithHeadcount = OrgRecord & { readonly headcount: number };

async function withHeadcount(tx: Tx, q: OrgViewQuery, orgs: readonly OrgRecord[], edges?: DimensionEdges) {
  const counts = await readHeadcounts(
    tx,
    { tenantId: q.tenantId, asOf: q.asOf, dimension: q.dimension, scope: q.scope },
    orgs.map((org) => org.id),
    edges,
  );
  return orgs.map((org): OrgWithHeadcount => ({ ...org, headcount: counts.get(org.id) ?? 0 }));
}

/** 一页组织（带在岗人数）和同过滤的总数。 */
export async function readOrgPage(tx: Tx, q: OrgViewQuery, page: { limit: number; offset: number }) {
  const records = await loadOrgSnapshot(tx, q.tenantId, q.asOf, page, filterOf(q));
  const items = await withHeadcount(
    tx,
    q,
    records.map((org) => displayOrganization(org, q.fullNameStartLevel)),
  );
  return { items, total: await countOrgSnapshot(tx, q.tenantId, q.asOf, filterOf(q)) };
}

/** 完整树的平铺节点（按组织名次）与每个节点最近的可见祖先下标；与列表同样不含租户根组织。 */
export async function readOrgTreeNodes(tx: Tx, q: OrgViewQuery) {
  const page = { limit: ORG_TREE_NODE_LIMIT + 1, offset: 0 };
  const records = await loadOrgSnapshot(tx, q.tenantId, q.asOf, page, filterOf(q));
  if (records.length > ORG_TREE_NODE_LIMIT) {
    throw new AppError('PAYLOAD_TOO_LARGE', `组织超过 ${ORG_TREE_NODE_LIMIT} 个，请缩小查看范围或使用列表`);
  }
  const edges = await loadDimensionEdges(tx, q.tenantId, q.asOf, q.dimension);
  const shown = records.map((org) => displayOrganization(org, q.fullNameStartLevel));
  const nodes = await withHeadcount(tx, q, shown, edges);
  return {
    nodes,
    parents: nearestVisibleParents(
      nodes.map((node) => node.id),
      edges,
    ),
  };
}
