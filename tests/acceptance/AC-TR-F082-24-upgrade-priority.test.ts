/**
 * F-082 迁移（契约 §6.1 步骤 1）：存量里如有优先级 > 1000000 的行，迁移直接失败并报告
 * （输入层自 #184 起已限制在 0～1000000，预期没有；这里验证兜底）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';

const database = useTestDb({ migrateBefore: '_f082_formula_id_binding' });

it('存量优先级超过 1000000：迁移失败并报告约束', async () => {
  const handle = database();
  const [tenantId, fieldId, ruleId, actor] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await handle.db.execute(sql`INSERT INTO tenants (id, code, name) VALUES (${tenantId}, 'f082-pri', 'f082')`);
  await withTenant(handle.db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO talent_review_fields (id, tenant_id, code, name, kind, field_group, precision)
      VALUES (${fieldId}, ${tenantId}, 'score', '得分', 'number', 'result', 2)`);
    await tx.execute(sql`INSERT INTO talent_review_calc_rules (id, tenant_id, name, created_by, updated_by)
      VALUES (${ruleId}, ${tenantId}, '规则', ${actor}, ${actor})`);
    await tx.execute(sql`INSERT INTO talent_review_calc_rule_items
      (tenant_id, rule_id, target_field_id, formula, priority)
      VALUES (${tenantId}, ${ruleId}, ${fieldId}, '1', 1000001)`);
  });
  await expect(handle.migrate()).rejects.toThrow(/priority|check|约束|violat/i);
});
