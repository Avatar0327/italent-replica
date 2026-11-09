/**
 * 组织调整的“内容源”（F-476 §5.4）：详情 / 明细两个读入口只消费这一份对象，现值与办理时冻结份共用同一套裁剪投影。
 * 现值由 `loadOrgContent` 一次读全（头、调整范围、申请人名、全部组织明细、逐行执行结果、基线原上级、生效日名称）；
 * 办理时冻结的是它的完整 JSON（未按任何查看人裁剪，披露裁剪在读取时按上限 ∩ 节点表单 ∩ 当前权限做）。
 * 人员联动失败（employmentFailures）是执行态，不在其中，仍读现值。
 * P2：另带预览 / 导出的冻结输入 `preview`（preview-input.ts），预览与导出对已办读者是它加明细的纯投影。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from '../org/read-model.js';
import { loadItems, type OrgItem } from './items-store.js';
import { loadPreviewInput, type PreviewInput, type PreviewLoad } from './preview-input.js';
import { loadHead, memberNames, orgNamesAt, rangesOf, type HeadRow, type RangeOrg } from './queries.js';

export interface ExecutionResult {
  readonly id: string;
  readonly result: 1 | 2 | null;
  readonly reason: string | null;
  readonly message: string | null;
}

export interface OrgContent {
  readonly head: HeadRow;
  readonly ranges: readonly RangeOrg[];
  readonly creatorName: string | null;
  readonly items: readonly OrgItem[];
  readonly results: readonly ExecutionResult[];
  /** 基线版本 ID → 行政上级组织 ID（“变更前”从版本链取，不单独建列）。 */
  readonly parents: Readonly<Record<string, string | null>>;
  /** 组织 ID → 单据生效日的名称。 */
  readonly names: Readonly<Record<string, string>>;
  /**
   * 预览 / 导出的冻结输入；读现值的详情 / 明细不需要时为 null。办理份里缺它（P1 形状）时预览 / 导出 503，
   * 不退回现值（DEC-807）。
   */
  readonly preview: PreviewInput | null;
}

export interface LoadOptions {
  /**
   * 预览输入的读法：缺省 freeze（办理时冻结，体积有界）；现值预览 / 导出读 live（读全）；
   * 现值详情 / 明细读 none，省掉组织与编制查询。
   */
  readonly preview?: PreviewLoad | 'none';
}

async function executionResults(tx: Tx, tenantId: string, adjustmentId: string) {
  return rowsOf<ExecutionResult>(
    await tx.execute(sql`SELECT id, execution_result AS result, execution_reason AS reason,
        execution_message AS message
      FROM org_adjustment_org_items WHERE tenant_id = ${tenantId} AND adjustment_id = ${adjustmentId}`),
  );
}

async function baselineParents(tx: Tx, tenantId: string, items: readonly OrgItem[]) {
  const versionIds = [...new Set(items.flatMap((item) => (item.baseVersionId ? [item.baseVersionId] : [])))];
  if (!versionIds.length) return {};
  const rows = rowsOf<{ versionId: string; parentOrgId: string | null }>(
    await tx.execute(sql`SELECT version_id AS "versionId", parent_org_id AS "parentOrgId" FROM org_hierarchy_links
      WHERE tenant_id = ${tenantId} AND dimension = 'admin'
        AND version_id = ANY(${`{${versionIds.join(',')}}`}::uuid[])`),
  );
  return Object.fromEntries(rows.map((row) => [row.versionId, row.parentOrgId]));
}

/** 读全组织调整现值；单据不存在返回 null。办理时冻结（approval/handling-content.ts）按缺省读全，含预览输入。 */
export async function loadOrgContent(
  tx: Tx,
  tenantId: string,
  adjustmentId: string,
  options: LoadOptions = {},
): Promise<OrgContent | null> {
  const head = await loadHead(tx, tenantId, adjustmentId);
  if (!head) return null;
  const items = await loadItems(tx, tenantId, adjustmentId);
  const parents = await baselineParents(tx, tenantId, items);
  const orgIds = items.flatMap((item) => [item.targetOrgId, item.parentOrgId, item.transferToOrgId]);
  const names = await orgNamesAt(
    tx,
    tenantId,
    [...orgIds, ...Object.values(parents)].filter((id): id is string => !!id),
    head.effectiveDate,
  );
  const ranges = (await rangesOf(tx, tenantId, [head.id])).get(head.id) ?? [];
  const creatorName = (await memberNames(tx, [head.createdBy])).get(head.createdBy) ?? null;
  return {
    head,
    ranges,
    creatorName,
    items,
    results: await executionResults(tx, tenantId, adjustmentId),
    parents,
    names: Object.fromEntries(names),
    preview:
      options.preview === 'none'
        ? null
        : await loadPreviewInput(
            tx,
            tenantId,
            head.effectiveDate,
            ranges.map((range) => range.orgId),
            items,
            options.preview ?? 'freeze',
          ),
  };
}
