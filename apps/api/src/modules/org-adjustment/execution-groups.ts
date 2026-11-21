/**
 * R2-T08 §7.4 执行组、组间顺序与涉及组织集合（§7.6 范围规则）。
 * 暂存行及其连带行不组成执行组；一组 = 一条非暂存用户明细 + 它的连带行。各明细执行器随 BE-11b～11f 接入。
 */
import { and, eq, orgAdjustmentTransferItems, sql, type Tx } from '@italent/db';
import { rowsOf } from '../approval/context.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { orgSubtreeAt } from '../org/employment-linkage.js';

interface OrgExecutionItem {
  readonly id: string;
  readonly seq: number;
  readonly adjustType: 1 | 2 | 3;
  readonly targetOrgId: string | null;
  readonly parentOrgId: string | null;
  readonly parentItemId: string | null;
  readonly transferToOrgId: string | null;
  readonly transferToItemId: string | null;
  readonly cascadedFromItemId: string | null;
  readonly addEmployment: boolean | null;
  readonly execPhase: number;
  readonly executionResult: number | null;
}

type TransferRow = typeof orgAdjustmentTransferItems.$inferSelect;
type TransferExecutionItem = Pick<
  TransferRow,
  'id' | 'seq' | 'employeeId' | 'departmentId' | 'departmentItemId' | 'execPhase' | 'executionResult'
> & { readonly adjustType: 'transfer' };

export type ExecutionItem = OrgExecutionItem | TransferExecutionItem;

export interface ExecutionSections {
  /** 内部显式开启。生产排期与执行的调动分区统一随 BE-11c-b 接入。 */
  readonly includeTransfers?: boolean;
}

export interface ExecutionGroup {
  /** 组内用户明细的行 ID，也是 scope_orgs / group_attempts 的组键。 */
  readonly id: string;
  readonly lead: ExecutionItem;
  readonly items: readonly ExecutionItem[];
}

export interface AdjustmentHead {
  readonly id: string;
  readonly code: string;
  readonly subject: string;
  readonly effectiveDate: string;
  readonly createdBy: string;
  readonly subjectOrgId: string;
}

export type ExecutionOutcome = 'done' | 'pending';

export interface GroupInput {
  readonly tenantId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly adjustment: AdjustmentHead;
  /** 本事务内重读的组快照（F-341）：exec_phase / 执行结果是本次调用前的最新值。 */
  readonly group: ExecutionGroup;
  readonly commandId: string;
}

/** 明细执行器：在 fenced 组事务内写入；'pending' 表示分页未完（§7.5），运行器另起事务再调。 */
export type GroupExecutor = (tx: Tx, input: GroupInput) => Promise<ExecutionOutcome>;

export type GroupExecutors = Partial<Record<ExecutionItem['adjustType'], GroupExecutor>>;

export async function loadAdjustmentHead(tx: Tx, tenantId: string, id: string): Promise<AdjustmentHead> {
  const [row] = rowsOf<AdjustmentHead>(
    await tx.execute(sql`SELECT id, code, subject, effective_date::text AS "effectiveDate", created_by AS "createdBy",
        approval_subject_org_id AS "subjectOrgId"
      FROM org_adjustments WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
  );
  return row!;
}

export async function loadExecutionItems(
  tx: Tx,
  tenantId: string,
  adjustmentId: string,
  sections: ExecutionSections = {},
): Promise<ExecutionItem[]> {
  const orgs = rowsOf<OrgExecutionItem>(
    await tx.execute(sql`SELECT i.id, i.seq, i.adjust_type AS "adjustType", i.target_org_id AS "targetOrgId",
        i.parent_org_id AS "parentOrgId", i.parent_item_id AS "parentItemId",
        i.transfer_to_org_id AS "transferToOrgId", i.transfer_to_item_id AS "transferToItemId",
        i.cascaded_from_item_id AS "cascadedFromItemId", i.add_employment AS "addEmployment",
        i.exec_phase AS "execPhase", i.execution_result AS "executionResult"
      FROM org_adjustment_org_items i
      LEFT JOIN org_adjustment_org_items s ON s.tenant_id=i.tenant_id AND s.id=i.cascaded_from_item_id
      WHERE i.tenant_id=${tenantId} AND i.adjustment_id=${adjustmentId}::uuid
        AND NOT i.is_staged AND NOT coalesce(s.is_staged, false)
      ORDER BY i.seq`),
  );
  if (!sections.includeTransfers) return orgs;
  const t = orgAdjustmentTransferItems;
  const transfers = await tx
    .select({
      id: t.id,
      seq: t.seq,
      employeeId: t.employeeId,
      departmentId: t.departmentId,
      departmentItemId: t.departmentItemId,
      execPhase: t.execPhase,
      executionResult: t.executionResult,
    })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.adjustmentId, adjustmentId), sql`${t.generatedByItemId} IS NULL`));
  // 生成行随 11c2 / 11d 的发起组接入；这里仅发现独立的用户行。
  return [...orgs, ...transfers.map((item): TransferExecutionItem => ({ ...item, adjustType: 'transfer' }))];
}

/** §7.4 单内顺序：新增（按新建链深度）→ 变更（按生效日完整新树拓扑）→ 停用（目标自下而上）；同层按序号。 */
export async function executionGroupsOf(tx: Tx, tenantId: string, items: readonly ExecutionItem[], date: string) {
  const orgItems = items.filter((item) => item.adjustType !== 'transfer');
  const leads = items.filter((item) => item.adjustType === 'transfer' || !item.cascadedFromItemId);
  const byId = new Map(orgItems.map((item) => [item.id, item]));
  const depth = (item: OrgExecutionItem, next: (i: OrgExecutionItem) => OrgExecutionItem | undefined) => {
    const seen = new Set([item.id]);
    for (let cur = next(item); cur && !seen.has(cur.id); cur = next(cur)) seen.add(cur.id);
    return seen.size - 1;
  };
  const orgLeads = leads.filter((item) => item.adjustType !== 'transfer');
  const orgDepth = await targetDepths(tx, tenantId, orgLeads, date);
  const changedAbove = await changedAncestorCounts(tx, tenantId, orgLeads, byId, date);
  const rank = (item: ExecutionItem): [number, number] => {
    if (item.adjustType === 1) return [1, depth(item, (i) => byId.get(i.parentItemId ?? ''))];
    if (item.adjustType === 2) return [2, changedAbove.get(item.id) ?? 0];
    if (item.adjustType === 'transfer') return [3, 0];
    return [4, -(orgDepth.get(item.targetOrgId!) ?? 0)];
  };
  const ranked = leads.map((lead) => ({ lead, rank: rank(lead) }));
  ranked.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.lead.seq - b.lead.seq);
  return ranked.map(({ lead }): ExecutionGroup => ({
    id: lead.id,
    lead,
    items:
      lead.adjustType === 'transfer'
        ? [lead]
        : orgItems.filter((item) => item.id === lead.id || item.cascadedFromItemId === lead.id),
  }));
}

async function targetDepths(tx: Tx, tenantId: string, leads: readonly OrgExecutionItem[], date: string) {
  const ids = leads.filter((i) => i.adjustType === 3).map((i) => i.targetOrgId!);
  if (!ids.length) return new Map<string, number>();
  const rows = rowsOf<{ id: string; depth: number }>(
    await tx.execute(sql`WITH RECURSIVE versions AS (
        SELECT DISTINCT ON (org_id) id, org_id FROM org_versions
        WHERE tenant_id=${tenantId} AND start_date<=${date}::date ORDER BY org_id, start_date DESC, version_no DESC
      ), up AS (
        SELECT org_id AS id, org_id, 0 AS depth FROM versions WHERE org_id=ANY(${`{${ids.join(',')}}`}::uuid[])
        UNION ALL
        SELECT up.id, h.parent_org_id, up.depth + 1 FROM up JOIN versions v ON v.org_id=up.org_id
          JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.version_id=v.id AND h.dimension='admin'
        WHERE up.depth < 64
      ) SELECT id, max(depth)::int AS depth FROM up GROUP BY id`),
  );
  return new Map(rows.map((row) => [row.id, row.depth]));
}

/**
 * 变更行在“生效日当前树叠加同单全部变更”的新树里，上行祖先链上有几个同单变更目标：祖先先于后代执行。
 * 链会穿过没有变更明细的中间组织（根→A→B→P，A 挂 P、B 移根时，A 须排在 B 之后）。
 */
async function changedAncestorCounts(
  tx: Tx,
  tenantId: string,
  leads: readonly OrgExecutionItem[],
  byId: ReadonlyMap<string, OrgExecutionItem>,
  date: string,
) {
  const changes = leads.filter((i) => i.adjustType === 2);
  const moved = new Set(changes.map((i) => i.targetOrgId!));
  const requested = new Map(changes.map((i) => [i.targetOrgId!, resolveParent(i, byId)]));
  const start = [...moved, ...[...requested.values()].filter((id): id is string => !!id)];
  const current = await adminParentsAt(tx, tenantId, start, date);
  const parentOf = (orgId: string) => (moved.has(orgId) && requested.get(orgId)) || current.get(orgId) || null;
  const counts = new Map<string, number>();
  for (const item of changes) {
    const seen = new Set<string>([item.targetOrgId!]);
    let count = 0;
    for (let cur = parentOf(item.targetOrgId!); cur && !seen.has(cur); cur = parentOf(cur)) {
      seen.add(cur);
      if (moved.has(cur)) count++;
    }
    counts.set(item.id, count);
  }
  return counts;
}

/** 生效日当前树中这些组织及其全部祖先的行政上级：orgId → parentOrgId。 */
async function adminParentsAt(tx: Tx, tenantId: string, ids: readonly string[], date: string) {
  if (!ids.length) return new Map<string, string | null>();
  const rows = rowsOf<{ org_id: string; parent_org_id: string | null }>(
    await tx.execute(sql`WITH RECURSIVE versions AS (
        SELECT DISTINCT ON (org_id) id, org_id FROM org_versions
        WHERE tenant_id=${tenantId} AND start_date<=${date}::date ORDER BY org_id, start_date DESC, version_no DESC
      ), up AS (
        SELECT v.org_id, h.parent_org_id FROM versions v
          JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.version_id=v.id AND h.dimension='admin'
        WHERE v.org_id=ANY(${`{${ids.join(',')}}`}::uuid[])
        UNION
        SELECT v.org_id, h.parent_org_id FROM up JOIN versions v ON v.org_id=up.parent_org_id
          JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.version_id=v.id AND h.dimension='admin'
      ) SELECT org_id, parent_org_id FROM up`),
  );
  return new Map(rows.map((row) => [row.org_id, row.parent_org_id]));
}

/** 新建行引用同单新建行时，沿引用链取第一个已存在的组织（§2.6）。 */
function resolveParent(
  item: OrgExecutionItem | undefined,
  byId: ReadonlyMap<string, OrgExecutionItem>,
  seen = 0,
): string | null {
  if (!item || seen > 64) return null;
  return item.parentOrgId ?? resolveParent(byId.get(item.parentItemId ?? ''), byId, seen + 1);
}

/** §7.6 涉及组织集合：审批时写成 S、执行开始按当前树重算 S′；只计非暂存行。 */
export async function groupScope(
  tx: Tx,
  tenantId: string,
  group: ExecutionGroup,
  items: readonly ExecutionItem[],
  date: string,
): Promise<string[]> {
  const byId = new Map(items.filter((item) => item.adjustType !== 'transfer').map((item) => [item.id, item]));
  const scope = new Set<string>();
  const subtrees: string[] = [];
  const add = (id: string | null | undefined) => id && scope.add(id);
  for (const item of group.items) {
    if (item.adjustType === 'transfer') {
      const source = await findCurrentRecord(tx, tenantId, item.employeeId, date);
      add(source?.fields.departmentId);
      add(item.departmentId ?? resolveParent(byId.get(item.departmentItemId ?? ''), byId));
      continue;
    }
    if (item.adjustType === 1) add(resolveParent(item, byId));
    else add(item.targetOrgId);
    if (item.adjustType === 2) add(item.parentOrgId);
    if (item.adjustType === 3 || (item.adjustType === 2 && item.addEmployment)) subtrees.push(item.targetOrgId!);
    add(item.transferToOrgId);
    if (item.transferToItemId) add(resolveParent(byId.get(item.transferToItemId), byId));
  }
  for (const id of await orgSubtreeAt(tx, tenantId, subtrees, date)) scope.add(id);
  return [...scope].sort();
}

/** 组织明细仍可分页，调动组为同分区单事务；表名只从受控的组类型取得。 */
export function executionTable(group: ExecutionGroup) {
  return sql.identifier(
    group.lead.adjustType === 'transfer' ? 'org_adjustment_transfer_items' : 'org_adjustment_org_items',
  );
}

export function executionRefs(item: ExecutionItem) {
  return item.adjustType === 'transfer' ? [item.departmentItemId] : [item.parentItemId, item.transferToItemId];
}
