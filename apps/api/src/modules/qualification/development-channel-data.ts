/**
 * 发展通道查看的取数（C1-6，QL-R13；管理入口与 ESS 本人入口共用，只读、不做权限判断——授权由调用方按各自的业务关系完成）：
 * 员工的当前资格（C1-3 currentQualification，单一时间轴）→ 当前类别的标准 → 通道。
 * - 纵向 = 本类别标准的级别范围，按顺序号从低到高（loadChannels）；
 * - 横向 = 在**当前级别及以下**的节点上设置的、通往其他类别的路径（QL-R13 “在任一级别节点可添加多条横向路径”，规格 23 §15
 *   “若本类别下多个职级都发展向同一横向路径，则仅需设置最低节点横向路径”）：高于当前级别的节点上的路径对该员工不适用；
 * - 没有当前资格，或当前类别没有标准，是空态（不是错误）。
 */
import { sql, type Tx } from '@italent/db';
import { currentQualification, type CurrentQualification } from './current.js';
import { rowsOf } from './access.js';
import { type ChannelView, loadChannels } from './standard-service.js';

export interface ChannelOverview {
  readonly current: CurrentQualification | null;
  /** 当前类别的标准的通道（横向已按当前级别过滤）；没有当前资格或当前类别没有标准时为 null。 */
  readonly channel: ChannelView | null;
}

/** 类别的任职资格标准 ID（一个类别最多一条标准，AC-QL-02）。 */
export async function standardOfCategory(tx: Tx, tenantId: string, categoryId: string): Promise<string | null> {
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM ql_standards WHERE tenant_id = ${tenantId}::uuid
      AND category_id = ${categoryId}::uuid LIMIT 1`),
  );
  return row?.id ?? null;
}

async function displayOrders(tx: Tx, tenantId: string, levelIds: readonly string[]) {
  if (levelIds.length === 0) return new Map<string, number>();
  const rows = rowsOf<{ id: string; display_order: number }>(
    await tx.execute(sql`SELECT id, display_order FROM ql_levels WHERE tenant_id = ${tenantId}::uuid
      AND id = ANY(${`{${levelIds.join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((row) => [row.id, row.display_order]));
}

export async function channelOverview(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  asOf: string,
): Promise<ChannelOverview> {
  const current = await currentQualification(tx, tenantId, employeeId, asOf);
  if (!current) return { current: null, channel: null };
  const standardId = await standardOfCategory(tx, tenantId, current.categoryId);
  if (!standardId) return { current, channel: null };
  const view = await loadChannels(tx, tenantId, standardId);
  const orders = await displayOrders(tx, tenantId, [current.levelId, ...view.horizontal.map((h) => h.levelId)]);
  const here = orders.get(current.levelId);
  // 当前级别已不存在（配置被删）时没有“当前级别及以下”可比，横向给空
  const horizontal = view.horizontal.filter((h) => here !== undefined && (orders.get(h.levelId) ?? Infinity) <= here);
  return { current, channel: { ...view, horizontal } };
}
