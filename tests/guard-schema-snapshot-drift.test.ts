/**
 * CI 守卫（F-497）：代码里的 Drizzle schema 与最新迁移快照必须一致，
 * 否则 `pnpm db:generate` 会在无关 PR 里多生成一条迁移（c195 在 F-476 分支撞到过：
 * employment_cycles_trainee_start 的 CHECK 表达式换行与快照不同，语义相同）。
 * 与 guard-migration-snapshot 互补：那个守卫比对“快照 ↔ 真实库”，本守卫比对“代码 schema ↔ 快照”。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsFolder, schema } from '@italent/db';
import { type DrizzleSnapshotJSON, generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';

function latestSnapshot(): DrizzleSnapshotJSON {
  const files = readdirSync(join(migrationsFolder, 'meta'))
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  return JSON.parse(readFileSync(join(migrationsFolder, 'meta', files.at(-1) as string), 'utf8'));
}

describe('守卫：代码 schema 与最新迁移快照一致（db:generate 无差异）', () => {
  it('以最新快照为基线，按代码 schema 生成迁移应为空', async () => {
    const statements = await generateMigration(latestSnapshot(), generateDrizzleJson(schema));
    expect(statements).toEqual([]);
  });
});
