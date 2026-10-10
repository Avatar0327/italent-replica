/**
 * F-082（F082-2）验收夹具：在计算规则夹具上补“bound 数据”的直接构造（开关关闭时没有写入路径，F082-3 才有）、
 * 引用表 / 字段目录版本的直接读取，以及改名 / 删除字段的快捷调用。
 */
import { sql, withTenant } from '@italent/db';
import { fieldHandle } from '@italent/domain';
import type { Db } from '@italent/db';
import { calcBody, calcItem, calcWorld, type FieldRef } from './AC-TR-calc-rule-support.js';

export { calcBody, calcItem, calcWorld, fieldHandle };
export type { FieldRef };

const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export type F082World = Awaited<ReturnType<typeof calcWorld>>;

export async function f082World(db: Db, label: string): Promise<F082World> {
  return calcWorld(db, label);
}

/** 开关打开的世界（F082-3 起的新写入路径与新响应；依赖注入覆盖只允许作用于 useTestDb() 建的库）。 */
export async function boundWorld(db: Db, label: string): Promise<F082World> {
  return calcWorld(db, label, { formulaIdBinding: true });
}

/** 计算项目在库里的原始行（formula 是规范文本还是名称文本、绑定状态）。 */
export async function rawItem(db: Db, w: F082World, itemId: string) {
  const found = await withTenant(db, tenantOf(w), (tx) =>
    tx.execute(sql`SELECT formula, formula_binding, binding_issue, uses_ranking FROM talent_review_calc_rule_items
      WHERE id = ${itemId}`),
  );
  return rows<{ formula: string; formula_binding: string; binding_issue: string | null; uses_ranking: boolean }>(
    found,
  )[0]!;
}

/** 规则的版本与项目写入状态快照：用来断言“什么都没写”。 */
export async function ruleFootprint(db: Db, w: F082World, ruleId: string) {
  const found = await withTenant(db, tenantOf(w), (tx) =>
    tx.execute(sql`SELECT k.revision, i.id AS item_id, i.formula, i.formula_binding,
        (SELECT count(*)::int FROM talent_review_calc_item_refs r WHERE r.item_id = i.id) AS refs
      FROM talent_review_calc_rules k LEFT JOIN talent_review_calc_rule_items i ON i.rule_id = k.id
      WHERE k.id = ${ruleId} ORDER BY i.id`),
  );
  return rows<Record<string, unknown>>(found);
}

const tenantOf = (w: F082World) => w.as.tenant;

/** 规则里某个目标字段的计算项目 ID。 */
export async function itemIdOf(db: Db, w: F082World, ruleId: string, targetFieldId: string): Promise<string> {
  const found = await withTenant(db, tenantOf(w), (tx) =>
    tx.execute(sql`SELECT id FROM talent_review_calc_rule_items
      WHERE rule_id = ${ruleId} AND target_field_id = ${targetFieldId}`),
  );
  return rows<{ id: string }>(found)[0]!.id;
}

/** 把已有计算项目改成 bound：写规范文本、状态与 bound 引用（开关关闭时没有 API 写入路径，测试直接构造）。 */
export async function makeBound(
  db: Db,
  w: F082World,
  itemId: string,
  stored: string,
  refs: readonly string[],
): Promise<void> {
  await withTenant(db, tenantOf(w), async (tx) => {
    await tx.execute(sql`UPDATE talent_review_calc_rule_items
      SET formula = ${stored}, formula_binding = 'bound', binding_issue = NULL WHERE id = ${itemId}`);
    await tx.execute(sql`DELETE FROM talent_review_calc_item_refs WHERE item_id = ${itemId}`);
    for (const fieldId of refs) {
      await tx.execute(sql`INSERT INTO talent_review_calc_item_refs (tenant_id, item_id, field_id, kind)
        VALUES (${tenantOf(w)}, ${itemId}, ${fieldId}, 'bound')`);
    }
  });
}

export async function setBinding(db: Db, w: F082World, itemId: string, state: 'legacy' | 'unresolved', issue?: string) {
  await withTenant(db, tenantOf(w), (tx) =>
    tx.execute(sql`UPDATE talent_review_calc_rule_items
      SET formula_binding = ${state}, binding_issue = ${issue ?? null} WHERE id = ${itemId}`),
  );
}

export async function refsOf(db: Db, w: F082World, itemId?: string) {
  const found = await withTenant(db, tenantOf(w), (tx) =>
    tx.execute(sql`SELECT item_id, field_id, kind FROM talent_review_calc_item_refs
      ${itemId ? sql`WHERE item_id = ${itemId}` : sql``} ORDER BY kind, field_id`),
  );
  return rows<{ item_id: string; field_id: string; kind: string }>(found);
}

export async function catalogVersion(db: Db, w: F082World): Promise<number> {
  const found = await withTenant(db, tenantOf(w), (tx) =>
    tx.execute(sql`SELECT version::text AS version FROM talent_review_field_catalog_versions`),
  );
  const [row] = rows<{ version: string }>(found);
  return row ? Number(row.version) : 0;
}

/** calcWorld.read 是计算规则的读取（覆盖了配置夹具的 read），字段走原始请求。 */
export async function fieldView(w: F082World, id: string) {
  const response = await w.request('GET', `/fields/${id}`);
  return (await response.json()) as { name: string; revision: number; enabled: boolean };
}

export async function fieldRevision(w: F082World, id: string): Promise<number> {
  return (await fieldView(w, id)).revision;
}

export async function renameField(w: F082World, field: FieldRef, name: string) {
  return w.request('PATCH', `/fields/${field.id}`, { ifMatch: await fieldRevision(w, field.id), body: { name } });
}

export async function deleteField(w: F082World, field: FieldRef) {
  return w.request('DELETE', `/fields/${field.id}`, { ifMatch: await fieldRevision(w, field.id) });
}

export interface ErrorBody {
  error: { code: string; details: Record<string, unknown> };
}
export const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;
