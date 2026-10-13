/**
 * CI 守卫（F-122，#305 完整 CI 偶发 409“身份编码已存在”）：
 * 测试里给带唯一约束的编码 / 邮箱 / 名称加后缀，不得再用 `randomUUID().slice(0, 6)` 一类短后缀——
 * 24 位随机数在全量并行跑数千个对象时会撞码。统一改用 tests/acceptance/support/unique.ts 的 uniqueSuffix()
 * （≥12 位十六进制）。本守卫扫描源码，后缀有效随机位数 < 12 的写法一律报错。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIN_HEX = 12;
const SELF = 'tests/guard-unique-suffix.test.ts';

/** 白名单：「文件:命中的原文」→ 理由。当前没有需要豁免的写法，新增必须逐条写明理由。 */
const ALLOWED: Record<string, string> = {
  'tests/acceptance/AC-360-F088-support.ts:randomUUID().slice(0, 8)':
    '拼 UUID 首段：格式固定为 8 位十六进制，不是唯一约束后缀；每个场景在全新库里只取一次前缀，不会撞码',
};

function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listSources(full, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** 范围：tests/ 全部源码，以及 apps / packages 各包 src 下的测试文件（业务代码不在本守卫范围）。 */
function scanTargets(): string[] {
  const targets = listSources(join(ROOT, 'tests'));
  for (const group of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, pkg, 'src');
      if (!statSync(join(ROOT, group, pkg)).isDirectory()) continue;
      try {
        targets.push(...listSources(src).filter((file) => /\.test\.(ts|tsx)$/.test(file)));
      } catch {
        // 该包没有 src 目录
      }
    }
  }
  return targets.map((file) => relative(ROOT, file).split(sep).join('/')).filter((file) => file !== SELF);
}

// UUID 字符串 8-4-4-4-12 的连字符位置：未去连字符时，这些位置不贡献随机位
const UUID_DASHES = new Set([8, 13, 18, 23]);

/** randomUUID() 取子串后的有效十六进制位数；取到末尾（单参数 slice）视为不截短。 */
function uuidHexCount(stripped: boolean, method: string, a: number, b: number | undefined): number {
  if (method === 'substr') return b ?? 36;
  if (method === 'slice' && b === undefined && a < 0) return -a;
  if (b === undefined) return 36 - a;
  const [from, to] = method === 'substring' && a > b ? [b, a] : [a, b];
  let count = 0;
  for (let i = from; i < Math.min(to, 36); i++) if (stripped || !UUID_DASHES.has(i)) count++;
  return count;
}

const UUID_SLICE =
  /randomUUID\(\)(\s*\.replace(?:All)?\(\s*(?:'-'|\/-\/g)\s*,\s*''\s*\))?\s*\.(slice|substring|substr)\(\s*(-?\d+)\s*(?:,\s*(\d+)\s*)?\)/g;
const RANDOM_SLICE = /Math\.random\(\)\.toString\(36\)\.(slice|substring)\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;

function findShortSuffixes(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(UUID_SLICE)) {
    const b = m[4] === undefined ? undefined : Number(m[4]);
    if (uuidHexCount(m[1] !== undefined, m[2]!, Number(m[3]), b) < MIN_HEX) hits.push(m[0].replace(/\s+/g, ' '));
  }
  for (const m of source.matchAll(RANDOM_SLICE)) {
    // toString(36) 每位约 5.17 bit，12 位十六进制 = 48 bit，至少取 10 位
    if (Number(m[3]) - Number(m[2]) < 10) hits.push(m[0]);
  }
  return hits;
}

describe('F-122 测试唯一后缀守卫', () => {
  it('识别器自检：短后缀被抓，足够长的写法放行', () => {
    expect(findShortSuffixes('randomUUID().slice(0, 6)')).toHaveLength(1);
    expect(findShortSuffixes('randomUUID().substring(0, 8)')).toHaveLength(1);
    expect(findShortSuffixes("randomUUID().replaceAll('-', '').slice(0, 10)")).toHaveLength(1);
    expect(findShortSuffixes('randomUUID().slice(0, 12)')).toHaveLength(1); // 含连字符，只有 11 位随机
    expect(findShortSuffixes('Math.random().toString(36).slice(2, 8)')).toHaveLength(1);
    expect(findShortSuffixes("randomUUID().replaceAll('-', '').slice(0, 12)")).toHaveLength(0);
    expect(findShortSuffixes('randomUUID().slice(-12)')).toHaveLength(0);
    expect(findShortSuffixes('randomUUID()')).toHaveLength(0);
    expect(findShortSuffixes('Math.random().toString(36).slice(2)')).toHaveLength(0);
  });

  it('tests/ 及各包测试文件里没有 < 12 位随机的 UUID / Math.random 短后缀', () => {
    const offenders: string[] = [];
    for (const file of scanTargets()) {
      for (const hit of findShortSuffixes(readFileSync(join(ROOT, file), 'utf8'))) {
        if (ALLOWED[`${file}:${hit}`] === undefined) offenders.push(`${file}: ${hit}`);
      }
    }
    expect(offenders, '请改用 tests/acceptance/support/unique.ts 的 uniqueSuffix()').toEqual([]);
  });

  it('白名单每条都有理由', () => {
    for (const [key, reason] of Object.entries(ALLOWED)) expect(reason.length, key).toBeGreaterThan(5);
  });
});
