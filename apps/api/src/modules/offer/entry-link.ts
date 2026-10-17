/**
 * Offer 与待入职记录的关联查询（R2 BE-14b2，F-201①；34 文末映射“待入职保存 LUOffer 外键”）。
 * 待入职记录经改期 / 编辑换日期会换新 ID（entry-actions.ts 的替换内核），日志表 employment_entry_actions 用
 * previous_business_id 把新旧记录串成链。Offer 上的 pending_entry_business_id 在“已取消入职经改期恢复”时由端口
 * （sync.ts onEntryRestored）更新；普通改期 / 编辑不调端口，这里沿链解析，读到的永远是最新的那条。
 */
import { eq, inArray, offers, sql, and, type Tx } from '@italent/db';
import type { OfferRow } from './service.js';

const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

/** 一批 Offer 当前关联的最新待入职记录 ID（只含已关联的 Offer；Offer ID → 记录 ID）。 */
export async function currentEntryIds(
  tx: Tx,
  tenantId: string,
  list: readonly Pick<OfferRow, 'id' | 'pendingEntryBusinessId'>[],
): Promise<Map<string, string>> {
  const linked = list.filter((offer) => offer.pendingEntryBusinessId !== null);
  const result = new Map<string, string>();
  if (!linked.length) return result;
  const roots = linked.map((offer) => offer.pendingEntryBusinessId!);
  const chain = rows<{ root: string; id: string }>(
    await tx.execute(sql`
      WITH RECURSIVE chain(root, id, depth) AS (
        SELECT r, r, 0 FROM unnest(${`{${roots.join(',')}}`}::uuid[]) AS r
        UNION ALL
        SELECT c.root, a.business_id, c.depth + 1 FROM chain c
        JOIN employment_entry_actions a ON a.tenant_id = ${tenantId} AND a.previous_business_id = c.id
        WHERE c.depth < 100
      )
      SELECT DISTINCT ON (root) root::text, id::text FROM chain ORDER BY root, depth DESC`),
  );
  const latest = new Map(chain.map((row) => [row.root, row.id]));
  for (const offer of linked) result.set(offer.id, latest.get(offer.pendingEntryBusinessId!)!);
  return result;
}

/** 按待入职记录反查 Offer：记录自己或链上任一祖先被 Offer 关联即命中；没有关联为 null。 */
export async function findOfferByPendingEntry(tx: Tx, tenantId: string, businessId: string): Promise<OfferRow | null> {
  const ancestors = rows<{ id: string }>(
    await tx.execute(sql`
      WITH RECURSIVE up(id, depth) AS (
        SELECT ${businessId}::uuid, 0
        UNION ALL
        SELECT a.previous_business_id, u.depth + 1 FROM up u
        JOIN employment_entry_actions a ON a.tenant_id = ${tenantId} AND a.business_id = u.id
        WHERE a.previous_business_id IS NOT NULL AND u.depth < 100
      )
      SELECT id::text FROM up`),
  );
  const [offer] = await tx
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.tenantId, tenantId),
        inArray(
          offers.pendingEntryBusinessId,
          ancestors.map((row) => row.id),
        ),
      ),
    )
    .limit(1);
  return offer ?? null;
}
