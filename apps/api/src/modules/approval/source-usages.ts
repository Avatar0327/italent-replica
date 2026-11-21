/**
 * F-326 §6：变量 / 矩阵被哪些流程节点引用。三类“在用版本”——草稿、当前已发布、仍有可恢复实例的旧已发布版本——
 * 都算引用：旧版本上的实例还会按 v1 的节点激活（AC-APV-F326-18），只看当前版本会漏掉它们。
 */
import { sql, type Tx } from '@italent/db';
import { approvalError, rowsOf } from './context.js';

/** F-326-L §1：撤回算已结束，不能阻止系统停用。 */
export const LIFECYCLE_INSTANCE_STATUSES = ['running', 'returned'] as const;
/** §6.1 与 resumableInstanceOf 同口径，撤回后仍可重提。 */
export const RESUMABLE_INSTANCE_STATUSES = [...LIFECYCLE_INSTANCE_STATUSES, 'withdrawn'] as const;
export type Usage = 'reference' | 'lifecycle';
/** 引用清单分页上限（设计 §6）；total 始终是全量。 */
export const USAGE_PAGE_LIMIT = 200;

export type UsageTarget = { kind: 'variable'; id: string } | { kind: 'matrix'; id: string };
export interface SourceUsage {
  processId: string;
  processCode: string;
  processName: string;
  approvalType: string;
  versionKind: 'draft' | 'current' | 'in_flight';
  versionNo: number;
  nodeKey: string;
  nodeName: string;
  position: 'approver' | 'empty_approver';
  /** 仅矩阵引用有值：被引用的角色列 */
  columnId: string | null;
  /** 仅 in_flight 有值：仍绑定该版本的可恢复实例数 */
  instanceCount: number | null;
}

const statusesOf = (usage: Usage) =>
  usage === 'lifecycle' ? LIFECYCLE_INSTANCE_STATUSES : RESUMABLE_INSTANCE_STATUSES;
const onActiveHead = sql`p.status='active' AND (v.status='draft' OR p.current_version_id=v.id)`;
const boundInstances = (usage: Usage) => sql`FROM approval_instances i
  WHERE i.tenant_id=v.tenant_id AND i.version_id=v.id AND i.status IN
    (${sql.join(
      statusesOf(usage).map((status) => sql`${status}`),
      sql`, `,
    )})`;
const versionIdsOf = (ids: readonly string[]) => sql`SELECT value::uuid FROM jsonb_array_elements_text(
  ${JSON.stringify(ids)}::jsonb)`;

/** 单人、会签与空人候选三列统一展开成槽位，允许按登记的版本收窄。 */
const slots = (tenantId: string, versionIds?: readonly string[]) => {
  const versions = versionIds ? sql`AND n.version_id IN (${versionIdsOf(versionIds)})` : sql``;
  const scope = sql`n.tenant_id=${tenantId}::uuid ${versions}`;
  return sql`
    SELECT n.version_id, n.node_key, n.name AS node_name, n.seq, 'approver' AS pos, n.approver_expression AS src
      FROM approval_process_nodes n
      WHERE ${scope} AND n.node_type='single' AND n.approver_expression IS NOT NULL
    UNION ALL
    SELECT n.version_id, n.node_key, n.name, n.seq, 'approver', e.value
      FROM approval_process_nodes n CROSS JOIN LATERAL jsonb_array_elements(n.approver_expressions) e
      WHERE ${scope} AND n.node_type='countersign'
    UNION ALL
    SELECT n.version_id, n.node_key, n.name, n.seq, 'empty_approver', e.value
      FROM approval_process_nodes n CROSS JOIN LATERAL jsonb_array_elements(n.empty_approver_sources) e
      WHERE ${scope}`;
};

const matches = (target: UsageTarget) =>
  target.kind === 'variable'
    ? sql`s.src->>'type' IN ('public_variable','application_variable') AND s.src->>'value'=${target.id}`
    : sql`s.src->>'type'='matrix' AND split_part(s.src->>'value', ':', 1)=${target.id}`;

interface UsageRow {
  process_id: string;
  process_code: string;
  process_name: string;
  approval_type: string;
  kind: SourceUsage['versionKind'];
  version_no: number;
  node_key: string;
  node_name: string;
  pos: SourceUsage['position'];
  column_id: string | null;
  instance_count: number | null;
}

/**
 * 全量引用（含可选的角色列过滤）。草稿与当前版本只算未废弃流程：废弃流程不会再发起新实例，
 * 但它版本上仍可恢复的实例照样引用，按“在途旧版本”计。
 */
export async function findSourceUsages(
  tx: Tx,
  tenantId: string,
  target: UsageTarget,
  columnIds?: readonly string[],
  usage: Usage = 'reference',
): Promise<SourceUsage[]> {
  const columnFilter =
    columnIds && target.kind === 'matrix'
      ? sql`AND split_part(s.src->>'value', ':', 2) IN (${sql.join(
          columnIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  const rows = rowsOf<UsageRow>(
    await tx.execute(sql`
    WITH slot AS (${slots(tenantId)}),
    usage AS (
      SELECT p.id AS process_id, p.code AS process_code, v.name AS process_name, p.approval_type,
        CASE WHEN v.status='draft' THEN 'draft'
          WHEN p.current_version_id=v.id AND p.status='active' THEN 'current' ELSE 'in_flight' END AS kind,
        v.version_no, s.node_key, s.node_name, s.seq, s.pos,
        CASE WHEN s.src->>'type'='matrix' THEN split_part(s.src->>'value', ':', 2) END AS column_id,
        (SELECT count(*)::int ${boundInstances(usage)}) AS resumable_count,
        (${onActiveHead}) AS active_head
      FROM slot s
      JOIN approval_process_versions v ON v.tenant_id=${tenantId}::uuid AND v.id=s.version_id
      JOIN approval_processes p ON p.tenant_id=v.tenant_id AND p.id=v.process_id
      WHERE ${matches(target)} ${columnFilter}
    )
    SELECT process_id, process_code, process_name, approval_type, kind, version_no, node_key, node_name,
      pos, column_id, CASE WHEN kind='in_flight' THEN resumable_count END AS instance_count
    FROM usage
    WHERE active_head OR (kind='in_flight' AND resumable_count>0)
    ORDER BY process_code, version_no, seq, node_key, pos, column_id`),
  );
  return rows.map((row) => ({
    processId: row.process_id,
    processCode: row.process_code,
    processName: row.process_name,
    approvalType: row.approval_type,
    versionKind: row.kind,
    versionNo: Number(row.version_no),
    nodeKey: row.node_key,
    nodeName: row.node_name,
    position: row.pos,
    columnId: row.column_id,
    instanceCount: row.instance_count === null ? null : Number(row.instance_count),
  }));
}

/** 查看引用接口的返回体：items 最多 200 条，total 是全量。 */
export async function sourceUsagePage(tx: Tx, tenantId: string, target: UsageTarget) {
  const all = await findSourceUsages(tx, tenantId, target);
  return { items: all.slice(0, USAGE_PAGE_LIMIT), total: all.length };
}

/**
 * 停用 / 改动影响确认（设计 §6）：调用方带上从“查看引用”拿到的总数；省略按 0 计。
 * 与当前总数不一致说明确认之后引用又变了（或没看过清单），409 让客户端刷新后显式重提。
 */
export async function assertReferencesAcknowledged(
  tx: Tx,
  tenantId: string,
  target: UsageTarget,
  acknowledged: number | undefined,
) {
  const total = (await findSourceUsages(tx, tenantId, target)).length;
  if (total === (acknowledged ?? 0)) return;
  throw approvalError('CONFLICT', 'APPROVAL_REFERENCES_CHANGED', '引用该对象的流程节点已变化，请重新查看影响后再确认', {
    referenceCount: total,
  });
}

/** 删除矩阵角色列前的保护：被任一在用版本引用的角色列不得删除，409 并列出引用位置。 */
export async function assertRoleColumnsUnused(
  tx: Tx,
  tenantId: string,
  matrixId: string,
  removedColumnIds: readonly string[],
) {
  if (!removedColumnIds.length) return;
  const items = await findSourceUsages(tx, tenantId, { kind: 'matrix', id: matrixId }, removedColumnIds);
  if (!items.length) return;
  throw approvalError('CONFLICT', 'APPROVAL_MATRIX_COLUMN_REFERENCED', '角色列正被流程引用，不能删除', {
    total: items.length,
    items: items.slice(0, USAGE_PAGE_LIMIT),
  });
}

/** 按流程去重。配置视图和保存收尾缺省用 §6.1，系统停用用 F-326-L §1。 */
export async function referencingProcessCounts(
  tx: Tx,
  tenantId: string,
  variableIds: readonly string[],
  usage: Usage = 'reference',
) {
  if (!variableIds.length) return new Map<string, number>();
  const rows = rowsOf<{ id: string; n: number }>(
    await tx.execute(sql`
    WITH slot AS (${slots(tenantId)})
    SELECT s.src->>'value' AS id, count(DISTINCT p.id)::int AS n
    FROM slot s
    JOIN approval_process_versions v ON v.tenant_id=${tenantId}::uuid AND v.id=s.version_id
    JOIN approval_processes p ON p.tenant_id=v.tenant_id AND p.id=v.process_id
    WHERE s.src->>'type'='public_variable'
      AND s.src->>'value' IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(variableIds)}::jsonb))
      AND ((${onActiveHead}) OR (v.status<>'draft' AND EXISTS (SELECT 1 ${boundInstances(usage)})))
    GROUP BY s.src->>'value'`),
  );
  return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

/** §2.4：锁的上界由版本内容决定，自动变量状态可能变化，不能作为筛选条件。 */
export async function versionAutoVariableReferences(tx: Tx, tenantId: string, versionIds: readonly string[]) {
  if (!versionIds.length) return [];
  return rowsOf<{ version_id: string; variable_id: string }>(
    await tx.execute(sql`
      WITH slot AS (${slots(tenantId, versionIds)})
      SELECT DISTINCT s.version_id, a.id AS variable_id
      FROM slot s JOIN approval_variables a ON a.tenant_id=${tenantId}::uuid AND a.id::text=s.src->>'value'
      WHERE s.src->>'type'='public_variable' AND a.origin='auto'`),
  );
}

/** §2.4：取得变量锁后发新语句重新判定。流程头与版本行都只读（§3.5）。 */
export async function drainedVersions(tx: Tx, tenantId: string, versionIds: readonly string[]) {
  return rowsOf<{ id: string; process_id: string; version_no: number; discarded: boolean }>(
    await tx.execute(sql`
      SELECT v.id, v.process_id, v.version_no, p.status='discarded' AS discarded
      FROM approval_process_versions v JOIN approval_processes p ON p.tenant_id=v.tenant_id AND p.id=v.process_id
      WHERE v.tenant_id=${tenantId}::uuid AND v.id IN (${versionIdsOf(versionIds)})
        AND NOT (${onActiveHead}) AND NOT EXISTS (SELECT 1 ${boundInstances('lifecycle')})
      ORDER BY v.version_no, v.id`),
  );
}
