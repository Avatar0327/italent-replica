/** #11：健康度字段引用与盘点字段删除共用 F 行锁；删除守卫只读，不反向取等级集合锁。 */
import { sql, type Tx } from '@italent/db';
import type { RuleFieldRef, SuccessionLevelRules } from '@italent/domain';
import { registerConfigReferenceGuard } from '../talent-review/config-kit.js';
import { rowsOf } from './read-sql.js';

export async function lockLevelReviewFields(tx: Tx, tenantId: string, rules: SuccessionLevelRules) {
  const codes = [...new Set(rules.rows.filter((row) => row.fieldSource === 'review').map((row) => row.fieldCode))];
  if (!codes.length) return [];
  // S → 等级行 → F（升序共享锁）；删除为 F → 只读引用守卫 → V，锁后目录读取与写入同事务。
  const fields = rowsOf<{ code: string; kind: RuleFieldRef['kind']; options: RuleFieldRef['optionDomain'] }>(
    await tx.execute(sql`SELECT f.code, f.kind,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', o.value, 'label', o.label, 'enabled', o.enabled))
        FROM talent_review_field_options o
        WHERE o.tenant_id = f.tenant_id AND o.field_id = f.id), '[]'::jsonb) AS options
      FROM talent_review_fields f WHERE f.tenant_id = ${tenantId}::uuid AND f.enabled
        AND f.code IN (${sql.join(
          codes.map((code) => sql`${code}`),
          sql`, `,
        )}) ORDER BY f.id FOR SHARE OF f`),
  );
  return fields.map((field): RuleFieldRef => ({
    object: 'review_object',
    code: field.code,
    path: `review_object.${field.code}`,
    kind: field.kind,
    optionDomain: field.options,
  }));
}

registerConfigReferenceGuard('field', async (tx, tenantId, fieldId) => {
  const [reference] = rowsOf(
    await tx.execute(sql`SELECT r.id FROM succession_health_level_rows r
    JOIN talent_review_fields f ON f.tenant_id = r.tenant_id AND f.code = r.field_code
    WHERE r.tenant_id = ${tenantId}::uuid AND r.field_source = 'review' AND f.id = ${fieldId}::uuid LIMIT 1`),
  );
  return reference ? 'SUCCESSION_HEALTH_LEVEL' : null;
});
