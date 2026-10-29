import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DbHandle, m0DemoValidity, migrationsFolder, platformMeta, withTenant } from '@italent/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { pgErrorCode } from './pg-error.js';
import { useTestDb } from './vitest.js';
import { PRE_UPGRADE_TABLE_SHIMS } from './pre-upgrade-shims.js';
import { createTestDb } from './test-db.js';

const testDb = useTestDb();
const tenantId = '00000000-0000-4000-8000-000000000001';
const subjectId = '00000000-0000-4000-8000-0000000000a1';

const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
const tableName = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);

/** 比较真实目录元数据，避免只证明表存在，却漏掉垫片残留、约束、默认值、RLS 或权限。 */
async function tableShape(handle: DbHandle, name: string) {
  const queries = {
    columns: sql`SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull,
      pg_get_expr(d.adbin, d.adrelid) AS default_value
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=${name}::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY attnum`,
    constraints: sql`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid=${name}::regclass ORDER BY conname`,
    indexes: sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'
      AND tablename=${name} ORDER BY indexname`,
    triggers: sql`SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid=${name}::regclass AND NOT tgisinternal ORDER BY tgname`,
    isolation: sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid=${name}::regclass`,
    policies: sql`SELECT policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
      WHERE schemaname='public' AND tablename=${name} ORDER BY policyname`,
    grants: sql`SELECT grantee, privilege_type, is_grantable FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name=${name} ORDER BY grantee, privilege_type`,
  };
  const shape: Record<string, unknown[]> = {};
  for (const [key, query] of Object.entries(queries)) shape[key] = rowsOf(await handle.db.execute(query));
  return shape;
}

async function tableOid(handle: DbHandle, name: string) {
  return rowsOf<{ oid: number }>(await handle.db.execute(sql`SELECT ${name}::regclass::oid AS oid`))[0]!.oid;
}

describe('测试库：全新库 + 迁移 + PG 16 基线特性', () => {
  it('F-306：临时整表可供租户读写且隔离，升级时移除；正式结构与完整迁移一致', async () => {
    const handle = await createTestDb({ migrateBefore: '_approval_subjects' });
    try {
      const oids = new Map<string, number>();
      for (const shim of PRE_UPGRADE_TABLE_SHIMS) {
        oids.set(shim.table, await tableOid(handle, shim.table));
        await handle.db.execute(sql`ALTER TABLE ${tableName(shim.table)} ADD COLUMN f306_shim_marker text`);
      }
      await withTenant(handle.db, tenantId, (tx) =>
        tx.execute(sql`INSERT INTO employment_probation_versions
          (id, tenant_id, employee_id, business_id, version_no, previous_version_id,
            has_probation, start_date, months, expected_end_date, source, command_id, created_at)
          VALUES (${subjectId}::uuid, ${tenantId}::uuid, ${subjectId}::uuid, ${subjectId}::uuid, 1, NULL,
            true, '2026-10-01', 2, '2026-12-01', 'entry', 'f306-shim-fixture', now())`),
      );
      const read = (id: string) =>
        withTenant(handle.db, id, async (tx) =>
          rowsOf(await tx.execute(sql`SELECT * FROM employment_probation_versions`)),
        );
      expect(await read(tenantId)).toHaveLength(1);
      expect(await read('00000000-0000-4000-8000-000000000002')).toEqual([]);
      await handle.migrate();
      await handle.migrate();
      expect(await read(tenantId)).toEqual([]);
      for (const shim of PRE_UPGRADE_TABLE_SHIMS) {
        expect(await tableOid(handle, shim.table)).not.toBe(oids.get(shim.table));
        expect(await tableShape(handle, shim.table)).toEqual(await tableShape(testDb(), shim.table));
      }
    } finally {
      await handle.close();
    }
  });

  it('F-306：切点已包含建表迁移时保留原表，后续 migrate 不撤除正式表', async () => {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    for (const shim of PRE_UPGRADE_TABLE_SHIMS) {
      const index = journal.entries.findIndex((e) => e.tag.endsWith(`_${shim.migration}`));
      expect(index).toBeGreaterThanOrEqual(0);
      const next = journal.entries[index + 1];
      expect(next, '切在建表迁移之后').toBeDefined();
      const handle = await createTestDb({ migrateBefore: next!.tag });
      try {
        const oid = await tableOid(handle, shim.table);
        await handle.migrate();
        await handle.migrate();
        expect(await tableOid(handle, shim.table)).toBe(oid);
        expect(await tableShape(handle, shim.table)).toEqual(await tableShape(testDb(), shim.table));
      } finally {
        await handle.close();
      }
    }
  });

  it('迁移已执行，可读写 platform_meta', async () => {
    const { db } = testDb();
    await db.insert(platformMeta).values({ key: 'schema', value: 'm0' });
    const rows = await db.select().from(platformMeta).where(eq(platformMeta.key, 'schema'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('m0');
  });

  it('btree_gist 扩展已启用', async () => {
    const { db } = testDb();
    const result = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(JSON.stringify(result)).toContain('btree_gist');
  });

  it('同租户同对象的有效期首尾相接可以插入', async () => {
    // m0_demo_validity 带 tenant_id，已纳入 RLS（迁移 0003），须在租户上下文中写入
    await withTenant(testDb().db, tenantId, (tx) =>
      tx.insert(m0DemoValidity).values([
        { tenantId, subjectId, validDuring: '[2026-01-01,2026-07-01)' },
        { tenantId, subjectId, validDuring: '[2026-07-01,)' },
      ]),
    );
  });

  it('同租户同对象的有效期重叠被排除约束拒绝（23P01）', async () => {
    const insert = withTenant(testDb().db, tenantId, (tx) =>
      tx.insert(m0DemoValidity).values({ tenantId, subjectId, validDuring: '[2026-03-01,2026-04-01)' }),
    );
    const error = await insert.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgErrorCode(error)).toBe('23P01');
  });

  it('不同租户的相同对象与区间互不影响', async () => {
    const otherTenant = '00000000-0000-4000-8000-000000000002';
    await withTenant(testDb().db, otherTenant, (tx) =>
      tx.insert(m0DemoValidity).values({ tenantId: otherTenant, subjectId, validDuring: '[2026-03-01,)' }),
    );
  });
});
