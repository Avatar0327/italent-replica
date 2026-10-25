import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DbHandle, migrationsFolder, sql } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { PRE_UPGRADE_SHIMS } from './pre-upgrade-shims.js';
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
        const expected = { uuid: 'uuid', text: 'text', integer: 'integer', date: 'date', boolean: 'boolean' }[
          shim.type
        ];
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
      for (const shim of PRE_UPGRADE_SHIMS) {
        // 切点早于建表迁移时只补列的垫片不造整张业务表；已有表则必须补齐列。
        const tableExists = [...before.keys()].some((key) => key.startsWith(`${shim.table}.`));
        expect(before.has(`${shim.table}.${shim.column}`), `${shim.table}.${shim.column}`).toBe(tableExists);
      }
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
