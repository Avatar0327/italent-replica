/** D1a：手写迁移的批次外键必须同时登记到 schema 和最新快照。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsFolder, schema } from '@italent/db';
import { generateDrizzleJson, type DrizzleSnapshotJSON } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';

const metaDir = join(migrationsFolder, 'meta');
const latest = readdirSync(metaDir)
  .filter((file) => file.endsWith('_snapshot.json'))
  .sort()
  .at(-1)!;
const snapshots = [
  ['代码 schema', generateDrizzleJson(schema)],
  ['最新迁移快照', JSON.parse(readFileSync(join(metaDir, latest), 'utf8')) as DrizzleSnapshotJSON],
] as const;

describe.each(snapshots)('AC-SC-sync-schema-metadata：%s', (_source, snapshot) => {
  it.each([
    ['succession_records', 'source_batch_id', 'succession_records_source_batch_fk'],
    ['succession_notifications', 'batch_id', 'succession_notifications_batch_fk'],
  ])('%s 的批次引用保留同租户复合键与 RESTRICT', (table, column, name) => {
    expect(snapshot.tables[`public.${table}`]?.foreignKeys[name]).toEqual({
      name,
      tableFrom: table,
      tableTo: 'succession_sync_batches',
      columnsFrom: ['tenant_id', column],
      columnsTo: ['tenant_id', 'id'],
      onDelete: 'restrict',
      onUpdate: 'no action',
    });
  });
});
