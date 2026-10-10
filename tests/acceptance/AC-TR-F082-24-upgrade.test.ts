/**
 * F-082 迁移（F082-1，契约 §1.3、§6.1 步骤 1）：从旧结构升级——
 * 存量计算项目升级后都是 legacy；已有字段的租户各得一行字段目录版本（版本 0），没有字段的租户不插。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';

const database = useTestDb({ migrateBefore: '_f082_formula_id_binding' });
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

it('AC-24 迁移：存量项目升级后为 legacy；有字段的租户补一行目录版本，空租户不补；重跑迁移不重复', async () => {
  const handle = database();
  const [withFields, empty, fieldId, ruleId, itemId, actor] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await handle.db.execute(sql`INSERT INTO tenants (id, code, name) VALUES
    (${withFields}, 'f082-up-1', 'f082'), (${empty}, 'f082-up-2', 'f082')`);
  await withTenant(handle.db, withFields, async (tx) => {
    await tx.execute(sql`INSERT INTO talent_review_fields (id, tenant_id, code, name, kind, field_group, precision)
      VALUES (${fieldId}, ${withFields}, 'score', '得分', 'number', 'result', 2)`);
    await tx.execute(sql`INSERT INTO talent_review_calc_rules (id, tenant_id, name, created_by, updated_by)
      VALUES (${ruleId}, ${withFields}, '规则', ${actor}, ${actor})`);
    await tx.execute(sql`INSERT INTO talent_review_calc_rule_items
      (id, tenant_id, rule_id, target_field_id, formula, priority)
      VALUES (${itemId}, ${withFields}, ${ruleId}, ${fieldId}, '盘点对象.得分 + 1', 1000000)`);
  });
  await handle.migrate();
  await handle.migrate();
  const item = await withTenant(handle.db, withFields, (tx) =>
    tx.execute(sql`SELECT formula, formula_binding, binding_issue FROM talent_review_calc_rule_items`),
  );
  expect(rows(item)).toEqual([{ formula: '盘点对象.得分 + 1', formula_binding: 'legacy', binding_issue: null }]);
  const read = (tenantId: string) =>
    withTenant(handle.db, tenantId, (tx) =>
      tx.execute(sql`SELECT version::text AS version FROM talent_review_field_catalog_versions`),
    );
  expect(rows(await read(withFields))).toEqual([{ version: '0' }]);
  expect(rows(await read(empty))).toEqual([]);
  const refs = await withTenant(handle.db, withFields, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM talent_review_calc_item_refs`),
  );
  expect(rows<{ n: number }>(refs)[0]!.n).toBe(0);
});
