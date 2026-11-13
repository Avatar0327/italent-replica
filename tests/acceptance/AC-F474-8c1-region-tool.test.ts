/** F-474-8b §6 / 8c-1：多片播种的摘要、总数、重叠与父子完整性校验（离线，不依赖来源文件）。 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedBlock, verifySlices, type SlicePlan } from '../../scripts/admin-regions.mjs';

const root = new URL('../../', import.meta.url).pathname;
const dir = join(root, 'packages/db/migrations');
const files = readdirSync(dir)
  .filter((name) => /^\d{4}_f474_admin_regions.*\.sql$/.test(name))
  .sort()
  .map((name) => join(dir, name));
const run = (...paths: string[]) =>
  spawnSync('node', ['scripts/admin-regions.mjs', 'check-files', ...paths], { cwd: root, encoding: 'utf8' });

describe('AC-F474-8c1 CLI：对真实迁移文件整体校验', () => {
  it('AC-F474-8c1-04 两片迁移合计 3209 条，分级 34 / 333 / 2842，通过', () => {
    expect(files).toHaveLength(2);
    const result = run(...files);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ total: 3209, levels: [34, 333, 2842], parts: 2 });
  });

  it('AC-F474-8c1-05 缺第二片、两片颠倒、第二片被改或少一行时拒绝', () => {
    const second = readFileSync(files[1]!, 'utf8');
    const temp = (text: string) => {
      const file = join(mkdtempSync(join(tmpdir(), 'regions-')), 'part2.sql');
      writeFileSync(file, text);
      return file;
    };
    expect(run(files[0]!).stderr).toMatch(/片数/);
    expect(run(files[1]!, files[0]!).stderr).toMatch(/SHA-256/);
    expect(run(files[0]!, temp(second.replace('鄂城区', '鄂城县'))).stderr).toMatch(/SHA-256/);
    expect(run(files[0]!, temp(second.replace(/\n\('420704'[^\n]*/, ''))).stderr).toMatch(/SHA-256/);
  });
});

const region = (code: string, parentCode: string | null, level: number) => ({ code, parentCode, level, name: '合成' });
const p = region('130000', null, 1);
const c = region('130100', '130000', 2);
const d1 = region('130102', '130100', 3);
const d2 = region('130103', '130100', 3);
const planOf = (blocks: string[], total: number, levels: number[], counts = [2, 2]): SlicePlan => ({
  total,
  levels,
  slices: blocks.map((block, i) => ({ count: counts[i]!, sha256: createHash('sha256').update(block).digest('hex') })),
});
const split = (parts: ReturnType<typeof region>[][]) => parts.map((part) => seedBlock(part, 1, 2));

describe('AC-F474-8c1 分片校验函数（合成小来源，每片两条）', () => {
  it('AC-F474-8c1-06 合法两片通过', () => {
    const blocks = split([
      [p, c],
      [d1, d2],
    ]);
    expect(verifySlices(blocks, planOf(blocks, 4, [1, 1, 2]))).toEqual({ total: 4, levels: [1, 1, 2], parts: 2 });
  });

  it.each([
    [
      '第二片 SHA 不符',
      split([
        [p, c],
        [d1, d2],
      ]),
      (x: SlicePlan) => (x.slices[1]!.sha256 = '0'),
      /第 2 片.*SHA-256/,
    ],
    [
      '第二片条数不符',
      split([
        [p, c],
        [d1, d2],
      ]),
      (x: SlicePlan) => (x.slices[1]!.count = 3),
      /第 2 片.*条数/,
    ],
    [
      '总数不符',
      split([
        [p, c],
        [d1, d2],
      ]),
      (x: SlicePlan) => (x.total = 5),
      /总数/,
    ],
    [
      '分级不符',
      split([
        [p, c],
        [d1, d2],
      ]),
      (x: SlicePlan) => (x.levels = [1, 2, 1]),
      /分级/,
    ],
    [
      '第二片与首片重叠',
      split([
        [p, c],
        [c, d1],
      ]),
      () => undefined,
      /第 2 片.*重叠/,
    ],
    [
      '父级缺失',
      split([
        [p, c],
        [region('140102', '140100', 3), d2],
      ]),
      () => undefined,
      /第 2 片.*父级/,
    ],
    [
      '首片引用尚未播种的父级',
      split([
        [d1, d2],
        [p, c],
      ]),
      () => undefined,
      /第 1 片.*父级/,
    ],
  ])('AC-F474-8c1-07 %s时拒绝', (_name, blocks, tweak, message) => {
    const plan = planOf(blocks, 4, [1, 1, 2]);
    tweak(plan);
    expect(() => verifySlices(blocks, plan)).toThrow(message);
  });
});
