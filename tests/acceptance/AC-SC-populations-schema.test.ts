/**
 * R3-T05 B2a：设计 §1.3 / §1.4、拆分方案第 35 行要求的三个独立关系表。
 * 先验证迁移后的字段、租户隔离和唯一键。
 * 默认颜色依据 DEC-420 / D-077：测试租户当前值作为初值（🟡，未证实为出厂值），必填、不可为空。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resultRows } from './AC-ORG-people-support.js';

const testDb = useTestDb();
const tables = [
  {
    table: 'succession_populations',
    columns: [
      'id',
      'tenant_id',
      'code',
      'name',
      'condition_expression',
      'compiled_formula',
      'compiler_version',
      'compile_error',
      'display_order',
      'revision',
    ],
    unique: ['tenant_id', 'code'],
  },
  {
    table: 'succession_population_rows',
    columns: ['id', 'tenant_id', 'population_id', 'row_no', 'field_code', 'filter_operator', 'filter_values'],
    unique: ['tenant_id', 'population_id', 'row_no'],
  },
  {
    table: 'succession_rule_settings',
    columns: ['tenant_id', 'kind', 'default_color', 'levels_revision', 'revision'],
    unique: ['tenant_id', 'kind'],
  },
];

describe('AC-SC B2a 人员范围与默认颜色表契约（设计 §1.3 / §1.4）', () => {
  it.each(tables)('$table：独立字段、强制租户 RLS 与规格唯一键', async ({ table, columns, unique }) => {
    const db = testDb().db;
    const relations = resultRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = to_regclass(${`public.${table}`})`),
    );
    expect(relations, `${table} 必须存在并启用强制租户隔离`).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const actualColumns = resultRows<{ column_name: string }>(
      await db.execute(sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}`),
    );
    expect(actualColumns.map((row) => row.column_name)).toEqual(expect.arrayContaining(columns));
    const keys = resultRows<{ columns: string[] }>(
      await db.execute(sql`SELECT array_agg(a.attname::text ORDER BY k.ordinality) AS columns
        FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = to_regclass(${`public.${table}`}) AND i.indisunique
          AND i.indpred IS NULL AND k.ordinality <= i.indnkeyatts
        GROUP BY i.indexrelid`),
    );
    expect(keys.map((row) => row.columns)).toContainEqual(unique);
  });
});
