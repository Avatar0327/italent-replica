import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DbHandle, migrationsFolder, sql, withTenant } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { PRE_UPGRADE_SHIMS, PRE_UPGRADE_TABLE_SHIMS } from './pre-upgrade-shims.js';
import { createTestDb } from './test-db.js';

const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
  entries: { tag: string }[];
};
const migrationSql = (name: string) => {
  const entry = journal.entries.find((e) => e.tag.endsWith(`_${name}`));
  if (!entry) throw new Error(`没有迁移 ${name}`);
  return readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
};

async function columnTypes(handle: DbHandle): Promise<Map<string, string>> {
  const result = await handle.db.execute(
    sql`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    table_name: string;
    column_name: string;
    data_type: string;
  }[];
  return new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));
}

describe('升级前兼容垫片（migrateBefore 夹具）', () => {
  it('F-306：0140 之前的旧库也能执行当前申请详情读取的试用期查询', async () => {
    const handle = await createTestDb({ migrateBefore: '_approval_subjects' });
    try {
      const result = await withTenant(handle.db, '00000000-0000-4000-8000-000000000001', (tx) =>
        tx.execute(sql`SELECT has_probation, months, expected_end_date
          FROM employment_probation_versions
          WHERE tenant_id='00000000-0000-4000-8000-000000000001'::uuid
          ORDER BY version_no DESC LIMIT 1`),
      );
      expect(Array.isArray(result) ? result : (result as { rows: unknown[] }).rows).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('F-306：每张登记表对应唯一真实建表迁移，全部列名和类型与正式表一致', async () => {
    const full = await createTestDb();
    try {
      const types = await columnTypes(full);
      expect(new Set(PRE_UPGRADE_TABLE_SHIMS.map((s) => s.table)).size).toBe(PRE_UPGRADE_TABLE_SHIMS.length);
      for (const shim of PRE_UPGRADE_TABLE_SHIMS) {
        expect(journal.entries.filter((e) => e.tag.endsWith(`_${shim.migration}`))).toHaveLength(1);
        const statement = migrationSql(shim.migration)
          .split('--> statement-breakpoint')
          .find((s) => s.trimStart().startsWith(`CREATE TABLE "${shim.table}" (`));
        expect(statement, shim.table).toBeDefined();
        const names = [...types.keys()].filter((name) => name.startsWith(`${shim.table}.`)).sort();
        expect(shim.columns.map((c) => `${shim.table}.${c.name}`).sort()).toEqual(names);
        for (const column of shim.columns) {
          expect(statement).toContain(`"${column.name}" ${column.type}`);
          expect(types.get(`${shim.table}.${column.name}`)).toBe(column.type);
        }
      }
    } finally {
      await full.close();
    }
  });

  it('每一行都对应一条真实迁移里的 ADD COLUMN，且类型与完整迁移后的列一致', async () => {
    const full = await createTestDb();
    try {
      const types = await columnTypes(full);
      for (const shim of PRE_UPGRADE_SHIMS) {
        const sqlText = migrationSql(shim.migration);
        expect(sqlText, `${shim.migration} 应不带 IF NOT EXISTS 地加 ${shim.column}`).toContain(
          `ALTER TABLE "${shim.table}" ADD COLUMN "${shim.column}" ${shim.type};`.replace(/;$/, ''),
        );
        expect(sqlText).not.toMatch(/IF NOT EXISTS/i);
        const dataType = types.get(`${shim.table}.${shim.column}`);
        expect(dataType, `${shim.table}.${shim.column}`).toBeDefined();
        const expected = { uuid: 'uuid', text: 'text', integer: 'integer', date: 'date' }[shim.type];
        expect(dataType).toBe(expected);
      }
    } finally {
      await full.close();
    }
  });

  it('升级前阶段补列，第一次 migrate 前撤掉，由正式迁移加回；重复 migrate 不报错', async () => {
    const handle = await createTestDb({ migrateBefore: '_command_ledger_actor' });
    try {
      const before = await columnTypes(handle);
      for (const shim of PRE_UPGRADE_SHIMS) expect(before.has(`${shim.table}.${shim.column}`)).toBe(true);
      await handle.migrate();
      await handle.migrate();
      const after = await columnTypes(handle);
      for (const shim of PRE_UPGRADE_SHIMS) expect(after.has(`${shim.table}.${shim.column}`)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('切点在某条迁移之后：已由迁移加的列不动，只补还没有的列，升级后不丢列', async () => {
    const handle = await createTestDb({ migrateBefore: '_command_failure_http_status' });
    try {
      const before = await columnTypes(handle);
      // 0127 已执行：台账两列是真迁移加的，http_status 才是垫片
      expect(before.has('command_ledger.actor_user_id')).toBe(true);
      expect(before.has('audit_command_failures.http_status')).toBe(true);
      await handle.migrate();
      const after = await columnTypes(handle);
      expect(after.has('command_ledger.actor_user_id')).toBe(true);
      expect(after.has('audit_command_failures.http_status')).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
