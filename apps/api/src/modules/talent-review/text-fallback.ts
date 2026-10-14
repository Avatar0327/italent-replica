/**
 * 文本兜底的命中查询（F-082 契约 §3.2 第 3 条，长期保留）：非 bound 公式按名称文本引用了字段的当前名称。
 * 删除守卫与改名固化共用，口径只有一份：SQL 粗筛要求字段名的**每一段**都出现（含点号的名称在公式里可以写成
 * `盘点对象 . 甲 . 乙`，整名不一定连续出现，R1-P2-1），再用领域层 textMentionsField 解析精确判定（解析失败宁可多保护）。
 * 带连字符的写法按租户当前全部字段名定型（#89-4，已存在字段优先），只认实际解释，不把减法读法也算成引用。
 * 调用时该字段仍在目录里（删除前 / 改名前），目录就是公式当前的解释依据。
 */
import { eq, sql, talentReviewFields as F, type Tx } from '@italent/db';
import { fieldNameTerms, textMentionsField } from '@italent/domain';

const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export async function textFallbackItems(tx: Tx, tenantId: string, fieldName: string): Promise<string[]> {
  const coarse = sql.join(
    fieldNameTerms(fieldName).map((term) => sql`strpos(formula, ${term}) > 0`),
    sql` AND `,
  );
  const rows = rowsOf<{ id: string; formula: string }>(
    await tx.execute(sql`
      SELECT id, formula FROM talent_review_calc_rule_items
       WHERE tenant_id = ${tenantId}::uuid AND formula_binding <> 'bound' AND ${coarse}
       ORDER BY id`),
  );
  if (rows.length === 0) return [];
  const names = (await tx.select({ name: F.name }).from(F).where(eq(F.tenantId, tenantId))).map((row) => row.name);
  return rows.filter((row) => textMentionsField(row.formula, fieldName, names)).map((row) => row.id);
}
