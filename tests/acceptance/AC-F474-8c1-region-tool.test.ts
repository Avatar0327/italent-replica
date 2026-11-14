/** F-474-8b §6 / 8c-1：多片播种的摘要、总数、重叠与父子完整性校验（离线，不依赖来源文件）。 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedBlock, verifySlices, type Region, type SlicePlan } from '../../scripts/admin-regions.mjs';

const root = new URL('../../', import.meta.url).pathname;
const dir = join(root, 'packages/db/migrations');
const files = readdirSync(dir)
  .filter((name) => /^\d{4}_f474_admin_regions.*\.sql$/.test(name))
  .sort()
  .map((name) => join(dir, name));
const run = (...paths: string[]) =>
  spawnSync('node', ['scripts/admin-regions.mjs', 'check-files', ...paths], { cwd: root, encoding: 'utf8' });

describe('AC-F474-8c1 区划迁移整体校验', () => {
  it('AC-F474-8c1-04 真实两片迁移合计 3209 条，分级 34 / 333 / 2842；缺片或颠倒时拒绝', () => {
    expect(files).toHaveLength(2);
    expect(JSON.parse(run(...files).stdout)).toMatchObject({ total: 3209, levels: [34, 333, 2842], parts: 2 });
    expect(run(files[0]!).stderr).toMatch(/片数/);
    expect(run(files[1]!, files[0]!).stderr).toMatch(/SHA-256/);
  });

  // 合成小来源，每片两条：省、市在首片，两个县在第二片
  type Seed = [string, string | null, number];
  const seeds: Seed[] = [
    ['130000', null, 1],
    ['130100', '130000', 2],
    ['130102', '130100', 3],
    ['130103', '130100', 3],
  ];
  const [p, c, d1, d2] = seeds.map(([code, parentCode, level]) => ({ code, parentCode, level, name: '合成' })) as [
    Region,
    Region,
    Region,
    Region,
  ];
  const check =
    (parts: Region[][], edit: (plan: SlicePlan) => void = () => undefined) =>
    () => {
      const blocks = parts.map((part) => seedBlock(part, 1, 2));
      const slices = blocks.map((block) => ({ count: 2, sha256: createHash('sha256').update(block).digest('hex') }));
      const plan = { total: 4, levels: [1, 1, 2], slices };
      edit(plan);
      return verifySlices(blocks, plan);
    };
  const ok = [
    [p, c],
    [d1, d2],
  ];

  it('AC-F474-8c1-05 合法两片通过', () => {
    expect(check(ok)()).toEqual({ total: 4, levels: [1, 1, 2], parts: 2 });
  });

  it.each([
    ['第二片 SHA 不符', ok, (x: SlicePlan) => (x.slices[1]!.sha256 = '0'), /第 2 片.*SHA-256/],
    ['第二片条数不符', ok, (x: SlicePlan) => (x.slices[1]!.count = 3), /第 2 片.*条数/],
    ['总数不符', ok, (x: SlicePlan) => (x.total = 5), /总数/],
    ['分级不符', ok, (x: SlicePlan) => (x.levels = [1, 2, 1]), /分级/],
    [
      '第二片与首片重叠',
      [
        [p, c],
        [c, d1],
      ],
      undefined,
      /第 2 片.*重叠/,
    ],
    [
      '父级缺失',
      [
        [p, c],
        [{ ...d1, code: '140102', parentCode: '140100' }, d2],
      ],
      undefined,
      /第 2 片.*父级/,
    ],
    [
      '首片引用尚未播种的父级',
      [
        [d1, d2],
        [p, c],
      ],
      undefined,
      /第 1 片.*父级/,
    ],
  ])('AC-F474-8c1-06 %s时拒绝', (_name, parts, edit, message) => {
    expect(check(parts, edit)).toThrow(message);
  });
});
