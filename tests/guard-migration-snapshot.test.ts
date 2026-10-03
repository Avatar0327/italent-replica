/**
 * CI 守卫（AGENTS.md §1 迁移规则）：手写迁移不能让 drizzle 元数据与真实库结构脱节。
 * 1. 跑完全部迁移后，public schema 的表、约束、索引名必须与最新快照一一对应，
 *    否则下次 db:generate 会重复建已有对象，或去改/删一个并不存在的名字；
 * 2. journal 的 when 必须严格递增，否则 drizzle 迁移器会跳过时间戳倒挂的迁移。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsFolder, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();

interface SnapshotTable {
  name: string;
  columns: Record<string, { name: string; primaryKey?: boolean; isUnique?: boolean; uniqueName?: string }>;
  compositePrimaryKeys?: Record<string, { name: string }>;
  foreignKeys?: Record<string, { name: string }>;
  uniqueConstraints?: Record<string, { name: string }>;
  checkConstraints?: Record<string, { name: string }>;
  indexes?: Record<string, { name: string }>;
}

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

const metaDir = join(migrationsFolder, 'meta');

function rowsOf<T>(result: unknown): T[] {
  // postgres-js 直接返回数组，PGlite 返回 { rows }
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** PostgreSQL 标识符最长 63 字节，drizzle 快照里记的是截断前的全名。 */
function pgName(name: string): string {
  return Buffer.from(name).subarray(0, 63).toString();
}

function latestSnapshot(): { tables: Record<string, SnapshotTable> } {
  const files = readdirSync(metaDir)
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  return JSON.parse(readFileSync(join(metaDir, files.at(-1) as string), 'utf8'));
}

function snapshotObjects(tables: SnapshotTable[]): string[] {
  const out: string[] = [];
  const add = (table: string, kind: string, name: string) => out.push(`${table} ${kind} ${pgName(name)}`);
  for (const t of tables) {
    const columns = Object.values(t.columns);
    if (columns.some((c) => c.primaryKey)) add(t.name, 'p', `${t.name}_pkey`);
    for (const c of columns) if (c.isUnique) add(t.name, 'u', c.uniqueName ?? `${t.name}_${c.name}_unique`);
    for (const k of Object.values(t.compositePrimaryKeys ?? {})) add(t.name, 'p', k.name);
    for (const k of Object.values(t.foreignKeys ?? {})) add(t.name, 'f', k.name);
    for (const k of Object.values(t.uniqueConstraints ?? {})) add(t.name, 'u', k.name);
    for (const k of Object.values(t.checkConstraints ?? {})) add(t.name, 'c', k.name);
    for (const k of Object.values(t.indexes ?? {})) add(t.name, 'i', k.name);
  }
  return out.sort();
}

// 排除：NOT NULL（PG18 起也记在 pg_constraint，drizzle 按列记录）、EXCLUDE 与约束触发器（drizzle 不建模）。
const dbObjectsQuery = sql`
  SELECT c.conrelid::regclass::text || ' ' || c.contype::text || ' ' || c.conname::text AS "o"
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname = 'public' AND c.conrelid <> 0 AND c.contype IN ('p', 'u', 'f', 'c')
  UNION ALL
  SELECT i.tablename::text || ' i ' || i.indexname::text
    FROM pg_indexes i
   WHERE i.schemaname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname AND c.contype IN ('p', 'u', 'x'))`;

const dbTablesQuery = sql`
  SELECT c.relname AS "t" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`;

describe('守卫：迁移后的库结构与 drizzle 最新快照一致', () => {
  it('表集合一致', async () => {
    const tables = rowsOf<{ t: string }>(await testDb().db.execute(dbTablesQuery)).map((r) => r.t);
    const snapshot = Object.values(latestSnapshot().tables).map((t) => t.name);
    expect(tables).toEqual([...snapshot].sort());
  });

  it('主键、唯一、外键、检查约束与索引名一一对应', async () => {
    const actual = rowsOf<{ o: string }>(await testDb().db.execute(dbObjectsQuery))
      .map((r) => r.o)
      .sort();
    const expected = snapshotObjects(Object.values(latestSnapshot().tables));
    expect({
      onlyInDatabase: actual.filter((o) => !expected.includes(o)),
      onlyInSnapshot: expected.filter((o) => !actual.includes(o)),
    }).toEqual({ onlyInDatabase: [], onlyInSnapshot: [] });
  });

  it('journal 的 when 严格递增', () => {
    const { entries } = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8')) as Journal;
    const inverted = entries.filter((e, i) => i > 0 && e.when <= (entries[i - 1] as { when: number }).when);
    expect(inverted.map((e) => e.tag)).toEqual([]);
  });
});
