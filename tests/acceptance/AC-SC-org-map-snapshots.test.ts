/** 第 2 轮 P2-2：中间快照也必须可追溯，最新快照结构守卫不能代替链完整性。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsFolder } from '@italent/db';
import { expect, it } from 'vitest';

it('AC-SC-org-map 全部迁移快照的 prevId 均指向前一份快照', () => {
  const meta = join(migrationsFolder, 'meta');
  const files = readdirSync(meta)
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .sort();
  let previous = '00000000-0000-0000-0000-000000000000';
  const failures = [];
  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(join(meta, file), 'utf8')) as { id: string; prevId: string };
    if (snapshot.prevId !== previous) failures.push({ file, prevId: snapshot.prevId, expected: previous });
    previous = snapshot.id;
  }
  expect(failures).toEqual([]);
});
