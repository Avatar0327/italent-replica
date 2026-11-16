import { randomUUID } from 'node:crypto';
import { type Db, orgObjects, orgVersions, pgErrorCode, sql, withPlatform, withTenant } from '@italent/db';
import { createTestDb, useTestDb, withCurrentWriteColumns } from '@italent/testkit';
import { expect, it, vi } from 'vitest';

const database = useTestDb({ migrateBefore: '_reflective_the_call' });
const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
const shape = async (db: Db) =>
  rowsOf(
    await db.execute(sql`SELECT table_name, column_name, data_type, udt_schema, udt_name,
    is_nullable, column_default, ordinal_position, character_maximum_length, numeric_precision, numeric_scale,
    datetime_precision FROM information_schema.columns WHERE table_schema='public'
    ORDER BY table_name, column_name`),
  );

async function writeCurrentOrg(db: Db) {
  const tenantId = randomUUID();
  await withPlatform(db, (tx) =>
    tx.execute(sql`INSERT INTO tenants (id, code, name)
    VALUES (${tenantId}, ${tenantId}, '合成升级租户')`),
  );
  return withTenant(db, tenantId, async (tx) => {
    const [org] = await tx.insert(orgObjects).values({ tenantId }).returning();
    await tx.insert(orgVersions).values({
      tenantId,
      orgId: org!.id,
      versionNo: 1,
      startDate: '2026-01-01',
      code: 'synthetic',
      name: '合成组织',
      fullName: '合成组织',
      customFields: { probe: '合成值' },
    });
    return tx.select({ customFields: orgVersions.customFields }).from(orgVersions);
  });
}

it('AC-F524-a：旧结构内当前 Drizzle 读写成功，退出后逐列恢复，再由正式迁移建列', async () => {
  const handle = database();
  const before = await shape(handle.db);
  const result = await withCurrentWriteColumns(handle.db, () => writeCurrentOrg(handle.db)).then(
    (rows) => ({ rows }),
    (error: unknown) => ({ code: pgErrorCode(error) }),
  );
  expect(result).toEqual({ rows: [{ customFields: { probe: '合成值' } }] });
  expect(await shape(handle.db)).toEqual(before);
  await handle.migrate();
  const columns = rowsOf(
    await handle.db.execute(sql`SELECT is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name='org_versions'
    AND column_name='custom_fields'`),
  );
  expect(columns).toEqual([{ is_nullable: 'NO', column_default: "'{}'::jsonb" }]);
});

it('AC-F524-b：整张表缺失仍报 42P01，不建表、不吞错', async () => {
  const handle = await createTestDb({ migrateBefore: '_org' });
  try {
    const before = await shape(handle.db);
    let entered = false;
    const failure = await withCurrentWriteColumns(handle.db, () => {
      entered = true;
      return withTenant(handle.db, randomUUID(), (tx) => tx.select().from(orgVersions));
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(entered).toBe(true);
    expect(pgErrorCode(failure)).toBe('42P01');
    expect(await shape(handle.db)).toEqual(before);
  } finally {
    await handle.close();
  }
});

it('AC-F524-c：回调成功读写后抛出的原错误透传，补列全部撤掉', async () => {
  const handle = await createTestDb({ migrateBefore: '_reflective_the_call' });
  try {
    const before = await shape(handle.db);
    const failure = new Error('合成回调异常');
    await expect(
      withCurrentWriteColumns(handle.db, async () => {
        expect(await writeCurrentOrg(handle.db)).toEqual([{ customFields: { probe: '合成值' } }]);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await shape(handle.db)).toEqual(before);
  } finally {
    await handle.close();
  }
});

it('AC-F524-d：最新结构进出夹具完全不变，保留当前列与回调结果', async () => {
  const handle = await createTestDb();
  try {
    const before = await shape(handle.db);
    await expect(withCurrentWriteColumns(handle.db, () => writeCurrentOrg(handle.db))).resolves.toEqual([
      { customFields: { probe: '合成值' } },
    ]);
    expect(await shape(handle.db)).toEqual(before);
  } finally {
    await handle.close();
  }
});

it('AC-F524-e：多表补列无默认或约束，嵌套夹具只撤自己的列，已有列与数据不动', async () => {
  const handle = await createTestDb({ migrateBefore: '_approval_subjects' });
  try {
    const before = await shape(handle.db);
    const constraints = async () =>
      rowsOf(
        await handle.db.execute(sql`SELECT conrelid::text, conname,
      pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace
      ORDER BY conrelid, conname`),
      );
    const initialConstraints = await constraints();
    await withCurrentWriteColumns(handle.db, async () => {
      const inside = await shape(handle.db);
      expect(inside).toEqual(expect.arrayContaining(before));
      const oldKeys = new Set(before.map((row) => JSON.stringify(row)));
      const added = inside.filter((row) => !oldKeys.has(JSON.stringify(row)));
      expect(added.length).toBeGreaterThan(3);
      for (const row of added) expect(row).toMatchObject({ is_nullable: 'YES', column_default: null });
      expect(await constraints()).toEqual(initialConstraints);
      const failure = new Error('合成嵌套异常');
      await expect(
        withCurrentWriteColumns(handle.db, async () => {
          expect(await shape(handle.db)).toEqual(inside);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await shape(handle.db)).toEqual(inside);
      expect(await writeCurrentOrg(handle.db)).toEqual([{ customFields: { probe: '合成值' } }]);
    });
    expect(await shape(handle.db)).toEqual(before);
    expect(await constraints()).toEqual(initialConstraints);
  } finally {
    await handle.close();
  }
});

it('AC-F524-f：schema 声明的类型在旧库不存在时退化 text，不创建类型', async () => {
  const handle = await createTestDb({ migrateBefore: '_reflective_the_call' });
  // 合成将来新增 enum / domain 的 schema 元数据；当前仓库没有此类缺失类型。
  const type = `"f524_${randomUUID()}"`;
  const typeName = vi.spyOn(orgVersions.customFields, 'getSQLType').mockReturnValue(type);
  try {
    const before = await shape(handle.db);
    await withCurrentWriteColumns(handle.db, async () => {
      const columns = rowsOf(
        await handle.db.execute(sql`SELECT data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema='public' AND table_name='org_versions'
        AND column_name='custom_fields'`),
      );
      expect(columns).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
      expect(rowsOf(await handle.db.execute(sql`SELECT to_regtype(${type})::text AS name`))).toEqual([{ name: null }]);
    });
    expect(await shape(handle.db)).toEqual(before);
  } finally {
    typeName.mockRestore();
    await handle.close();
  }
});
