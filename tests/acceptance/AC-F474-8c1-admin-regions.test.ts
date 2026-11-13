/** F-474-8b §6 / 8c-1：区划字典第二片播种后的全量字典与只读契约。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();
const tenants = [randomUUID(), randomUUID()];
const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const read = <T>(tenantId: string, query: ReturnType<typeof sql>) =>
  withTenant(testDb().db, tenantId, async (tx) => rows<T>(await tx.execute(query)));

describe('AC-F474-8c1 区划字典第二片', () => {
  it('AC-F474-8c1-01 两租户读到相同的全量 3209 条，分级 34 / 333 / 2842，父级都在更高层级', async () => {
    const all = sql`SELECT code, parent_code, level, name FROM admin_regions ORDER BY level, code`;
    const a = await read(tenants[0]!, all);
    expect(a).toHaveLength(3209);
    expect(await read(tenants[1]!, all)).toEqual(a);
    const levels = sql`SELECT level, count(*)::int AS count FROM admin_regions GROUP BY level ORDER BY level`;
    expect(await read(tenants[0]!, levels)).toEqual([34, 333, 2842].map((count, i) => ({ level: i + 1, count })));
    const orphans = sql`SELECT c.code FROM admin_regions c LEFT JOIN admin_regions p ON p.code = c.parent_code
      WHERE c.level > 1 AND (p.code IS NULL OR p.level >= c.level)`;
    expect(await read(tenants[0]!, orphans)).toEqual([]);
  });

  it('AC-F474-8c1-02 首片 1900 条保持原样，第二片 1309 条全是县级、范围 420704…659012、父级都在首片', async () => {
    const [first, second] = await read<Record<string, unknown>>(
      tenants[0]!,
      sql`WITH o AS (SELECT *, row_number() OVER (ORDER BY level, code) AS rn FROM admin_regions)
        SELECT count(*)::int AS n, min(code) AS lo, max(code) AS hi, min(level) AS min_level,
          bool_and(parent_code IS NULL OR parent_code IN (SELECT code FROM o WHERE rn <= 1900)) AS parents_in_first
        FROM o GROUP BY rn > 1900 ORDER BY rn > 1900`,
    );
    expect(first).toMatchObject({ n: 1900, lo: '110000', parents_in_first: true });
    expect(second).toMatchObject({ n: 1309, lo: '420704', hi: '659012', min_level: 3, parents_in_first: true });
  });

  it('AC-F474-8c1-03 app_user 对第二片的写入仍被 42501 拒绝，数据保持完整', async () => {
    const writes = [
      sql`INSERT INTO admin_regions VALUES ('990000', NULL, 1, '合成省')`,
      sql`UPDATE admin_regions SET name = '合成修改' WHERE code = '659012'`,
      sql`DELETE FROM admin_regions WHERE code = '659012'`,
    ];
    for (const statement of writes) {
      const error = await withTenant(testDb().db, tenants[0]!, (tx) => tx.execute(statement)).then(
        () => undefined,
        (e: unknown) => pgErrorCode(e),
      );
      expect(error).toBe('42501');
    }
    const count = sql`SELECT count(*)::int AS n FROM admin_regions WHERE name = '白杨市'`;
    expect(await read(tenants[0]!, count)).toEqual([{ n: 1 }]);
  });
});
