/**
 * CI 守卫（AGENTS.md §1 迁移规则）：手写迁移不能让 drizzle 元数据与真实库结构脱节。
 * 1. 用 drizzle-kit 按最新快照在临时 schema 里建一套表，与跑完全部迁移的 public 逐项比对
 *    列（类型、可空、默认值）、主键 / 唯一 / 外键 / 检查约束定义、索引定义——两边都由 PostgreSQL
 *    规范化输出，名字相同但定义不同也能查出；否则下次 db:generate 会重复建、错改或删不存在的对象；
 * 2. journal 的 when 必须严格递增，否则 drizzle 迁移器会跳过时间戳倒挂的迁移。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsFolder, sql, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { type DrizzleSnapshotJSON, generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();
const metaDir = join(migrationsFolder, 'meta');
const SNAPSHOT_SCHEMA = 'guard_snapshot';

/**
 * 历史遗留：0013 的 when 早于 0012。改写历史 when 会让停在 0013 的库重跑非幂等迁移，
 * 而已跳过 0013 的库照样补不上（PR #36 Codex 复审），故保持原值；其余迁移不得再倒挂。
 */
const KNOWN_INVERTED = ['0013_employment_rls_timeline'];

function rowsOf<T>(result: unknown): T[] {
  // postgres-js 直接返回数组，PGlite 返回 { rows }
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function latestSnapshot(): DrizzleSnapshotJSON {
  const files = readdirSync(metaDir)
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  return JSON.parse(readFileSync(join(metaDir, files.at(-1) as string), 'utf8'));
}

/** 某个 schema 下全部表的结构，按 PostgreSQL 规范化文本输出；EXCLUDE 约束及其索引 drizzle 不建模，不计入。 */
async function structureOf(tx: Tx, schema: string): Promise<string[]> {
  // public 留在路径里，函数引用两边才都输出为不带 schema 的形式
  await tx.execute(sql.raw(`SET LOCAL search_path = ${schema}, public`));
  const rows = rowsOf<{ o: string }>(
    await tx.execute(sql`
      SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
             || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') AS "o"
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint ' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema} AND k.contype IN ('p', 'u', 'f', 'c')
      UNION ALL
      SELECT 'index ' || i.tablename || ' ' || i.indexname || ' '
             || regexp_replace(i.indexdef, ' INDEX \\S+ ON \\S+ USING ', ' USING ')
        FROM pg_indexes i
       WHERE i.schemaname = ${schema}
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint x JOIN pg_namespace n ON n.oid = x.connamespace
            WHERE n.nspname = ${schema} AND x.contype = 'x' AND x.conname = i.indexname
         )`),
  );
  return rows.map((r) => r.o).sort();
}

/** 在一个事务里比对后整体回滚；mutate 用于证明守卫本身有效。 */
async function structureDiff(mutate?: (tx: Tx) => Promise<void>) {
  const statements = await generateMigration(generateDrizzleJson({}), latestSnapshot());
  return testDb()
    .db.transaction(async (tx) => {
      await mutate?.(tx);
      await tx.execute(sql.raw(`CREATE SCHEMA ${SNAPSHOT_SCHEMA}`));
      // 快照建表引用的函数（如 is_valid_iana_timezone）仍在 public，按 search_path 解析
      await tx.execute(sql.raw(`SET LOCAL search_path = ${SNAPSHOT_SCHEMA}, public`));
      for (const statement of statements) {
        await tx.execute(sql.raw(statement.replaceAll('"public".', `"${SNAPSHOT_SCHEMA}".`)));
      }
      const database = await structureOf(tx, 'public');
      const snapshot = await structureOf(tx, SNAPSHOT_SCHEMA);
      throw Object.assign(new Error('rollback'), {
        diff: {
          onlyInDatabase: database.filter((o) => !snapshot.includes(o)),
          onlyInSnapshot: snapshot.filter((o) => !database.includes(o)),
        },
      });
    })
    .catch((e: { diff?: { onlyInDatabase: string[]; onlyInSnapshot: string[] } }) => {
      if (!e.diff) throw e;
      return e.diff;
    });
}

describe('守卫：迁移后的库结构与 drizzle 最新快照一致', () => {
  it('列、约束、索引的定义逐项一致', async () => {
    expect(await structureDiff()).toEqual({ onlyInDatabase: [], onlyInSnapshot: [] });
  });

  it('守卫本身有效：名字不变、只改定义也会被查出来', async () => {
    const diff = await structureDiff(async (tx) => {
      await tx.execute(sql`ALTER TABLE tenants ALTER COLUMN name DROP NOT NULL`);
      await tx.execute(sql`CREATE INDEX guard_canary ON tenants (name)`);
    });
    expect(diff.onlyInDatabase).toEqual([
      'column tenants.name text',
      'index tenants guard_canary CREATE USING btree (name)',
    ]);
    expect(diff.onlyInSnapshot).toEqual(['column tenants.name text NOT NULL']);
  });

  it('journal 的 when 严格递增（已知历史例外除外）', () => {
    const { entries } = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const inverted = entries.filter((e, i) => i > 0 && e.when <= (entries[i - 1] as { when: number }).when);
    expect(inverted.map((e) => e.tag)).toEqual(KNOWN_INVERTED);
  });
});
