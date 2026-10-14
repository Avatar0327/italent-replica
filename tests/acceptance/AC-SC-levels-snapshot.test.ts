import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsFolder } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { levelKinds } from './AC-SC-levels-support.js';

const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string }[];
};
const migration = journal.entries.find((entry) => entry.tag.endsWith('_succession_levels_rls'))!;
const filename = `${String(migration.idx).padStart(4, '0')}_snapshot.json`;
const snapshot = JSON.parse(readFileSync(join(migrationsFolder, 'meta', filename), 'utf8')) as {
  tables: Record<string, { uniqueConstraints: Record<string, unknown> }>;
};
describe('AC-SC B2b P3-1 手写排序约束登记进快照', () => {
  it.each(levelKinds)('AC-SC %s：快照包含排序唯一约束，建表时同时生成其唯一索引', (kind) => {
    const name = `succession_${kind}_levels_order`;
    expect(snapshot.tables[`public.succession_${kind}_levels`]!.uniqueConstraints[name]).toEqual({
      name,
      columns: ['tenant_id', 'display_order'],
      nullsNotDistinct: false,
    });
  });
});
