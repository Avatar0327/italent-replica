/** F-474-8b §3.1 / AC-INS-16：公开行政区划只读字典，首片父级优先（读取只取首片 1900 条，第二片见 8c1）。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();
const tenants = [randomUUID(), randomUUID()];
const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const read = (tenantId: string) =>
  withTenant(testDb().db, tenantId, async (tx) =>
    rows(
      await tx.execute(sql`SELECT code, parent_code, level, name FROM admin_regions ORDER BY level, code LIMIT 1900`),
    ),
  );

describe('AC-F474-8c0 字典迁移与数据库只读契约', () => {
  it('AC-F474-8c0-01 两个租户经 app_user 读取相同的 1900 条公开首片', async () => {
    const a = await read(tenants[0]!);
    expect(a).toHaveLength(1900);
    expect(await read(tenants[1]!)).toEqual(a);
    expect(a).toEqual(
      expect.arrayContaining([
        { code: '110000', parent_code: null, level: 1, name: '北京市' },
        { code: '130100', parent_code: '130000', level: 2, name: '石家庄市' },
        { code: '110108', parent_code: '110000', level: 3, name: '海淀区' },
        { code: '130102', parent_code: '130100', level: 3, name: '长安区' },
        { code: '419001', parent_code: '410000', level: 3, name: '济源市' },
      ]),
    );
    const roles = await withTenant(testDb().db, tenants[0]!, (tx) => tx.execute(sql`SELECT current_user AS role`));
    expect(rows(roles)).toEqual([{ role: 'app_user' }]);
  });

  it('AC-F474-8c0-02 首片含全部省市，所有父级已存在且层级在先', async () => {
    const result = await withTenant(testDb().db, tenants[0]!, (tx) =>
      tx.execute(sql`
      SELECT level, count(*)::int AS count
      FROM (SELECT level FROM admin_regions ORDER BY level, code LIMIT 1900) f GROUP BY level ORDER BY level`),
    );
    expect(rows(result)).toEqual([
      { level: 1, count: 34 },
      { level: 2, count: 333 },
      { level: 3, count: 1533 },
    ]);
    const invalid = await withTenant(testDb().db, tenants[0]!, (tx) =>
      tx.execute(sql`
      SELECT c.code FROM admin_regions c LEFT JOIN admin_regions p ON p.code = c.parent_code
      WHERE c.level > 1 AND (p.code IS NULL OR p.level >= c.level)`),
    );
    expect(rows(invalid)).toEqual([]);
  });

  it('AC-F474-8c0-03 表结构遵循四列及公开只读注释，无租户 RLS', async () => {
    const columns = await testDb().db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'admin_regions' ORDER BY ordinal_position`);
    expect(rows<{ column_name: string }>(columns).map((r) => r.column_name)).toEqual([
      'code',
      'parent_code',
      'level',
      'name',
    ]);
    const table = await testDb().db.execute(sql`
      SELECT relrowsecurity AS rls, obj_description(oid) AS comment FROM pg_class
      WHERE oid = 'admin_regions'::regclass`);
    expect(rows(table)).toEqual([{ rls: false, comment: '公开行政区划、无租户数据、仅 SELECT' }]);
  });

  it.each([
    ['INSERT', sql`INSERT INTO admin_regions VALUES ('990000', NULL, 1, '合成省')`],
    ['UPDATE', sql`UPDATE admin_regions SET name = '合成修改' WHERE code = '110000'`],
    ['DELETE', sql`DELETE FROM admin_regions WHERE code = '110108'`],
    ['TRUNCATE', sql`TRUNCATE admin_regions`],
  ])('AC-F474-8c0-04 app_user 的 %s 被 42501 拒绝，两租户数据保持完整', async (_operation, statement) => {
    const before = await read(tenants[0]!);
    for (const tenantId of tenants) {
      const error = await withTenant(testDb().db, tenantId, (tx) => tx.execute(statement)).then(
        () => undefined,
        (e: unknown) => pgErrorCode(e),
      );
      expect(error).toBe('42501');
      expect(await read(tenantId)).toEqual(before);
    }
  });

  it.each([
    ["('990000', NULL, 0, '合成省')", '23514'],
    ["('990000', NULL, 4, '合成省')", '23514'],
    ["('990000', '110000', 1, '合成省')", '23514'],
    ["('990001', NULL, 3, '合成县')", '23514'],
    ["('990001', '990000', 3, '合成县')", '23503'],
    ["('110000', NULL, 1, '合成省')", '23505'],
  ])('AC-F474-8c0-05 迁移约束拒绝 %s', async (values, expected) => {
    const before = await read(tenants[0]!);
    const error = await testDb()
      .db.transaction(async (tx) => {
        await tx.execute(sql.raw(`INSERT INTO admin_regions VALUES ${values}`));
        throw new Error('无效数据被接受');
      })
      .catch((e: unknown) => pgErrorCode(e));
    expect(error).toBe(expected);
    expect(await read(tenants[0]!)).toEqual(before);
  });
});
