/**
 * AC-PLAT-F491-lock-key-guard · 咨询锁键统一经公共函数构造（F-491；F-078 / F-479 S1 同类排查的收口）。
 * 外部传入的租户 / 用户 UUID 按原样保留大小写，若自己拼进锁键文本，同一对象的大小写变体会拿到不同的锁、等于没有锁。
 * 所以 apps/、packages/ 里的咨询锁一律走 `apps/api/src/advisory-lock.ts`（asUuid 在数据库里转规范文本）：
 * 1. 公共键函数：大小写混用得到同一键，不同 UUID 得到不同键，非法 UUID 报错（不悄悄用原文），与改造前的键文本一致；
 * 2. 静态守卫：除公共文件外，源码里出现 pg_*advisory* / hashtext* 的地方，要么把公共函数产出的键交给 pg_* 调用，
 *    要么登记在白名单里（常量键 / 数字键 / 数据库内 uuid 类型变量），并写明理由，防回退。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { asUuid, lockKey, lockKey32 } from '../../apps/api/src/advisory-lock.js';

const ROOT = join(import.meta.dirname, '..', '..');
const COMMON = 'apps/api/src/advisory-lock.ts';

/**
 * 白名单：键里没有（可大小写变化的）UUID，或 UUID 在数据库里已是 uuid 类型。
 * 按文件登记允许出现的命中行（去首尾空白后的原文，重复出现就登记多次）；多出、改写或少了都报红，防登记过期或被夹带。
 */
const ALLOWED: Readonly<Record<string, { reason: string; lines: readonly string[] }>> = {
  'apps/api/src/modules/survey360/credential-key-registry.ts': {
    reason: '常量键 LOCK_KEY，键里没有 UUID',
    lines: [
      'await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${LOCK_KEY}, 0))`);',
      'await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`);',
    ],
  },
  'apps/api/src/modules/survey360/credential-ops.ts': {
    reason: '键 = 固定前缀 + 密钥版本号（整数），没有 UUID',
    lines: [
      'await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`survey360:key_rotated:${to}`}, 0))`);',
    ],
  },
  'packages/db/migrations/0027_personnel_sort_rank_refresh.sql': {
    reason: '键里的租户是 plpgsql 的 uuid 类型变量，target::text 即数据库规范小写文本',
    lines: ["PERFORM pg_advisory_xact_lock(hashtextextended('personnel_sort_ranks:' || target::text, 0));"],
  },
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.vite']);
const SOURCE_FILE = /\.(ts|tsx|mts|mjs|js|sql)$/;
const RAW_LOCK = /pg_(try_)?advisory\w*|\bhashtext(extended)?\s*\(/;
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*|--)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(join(dir, entry.name));
    return SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts') ? [join(dir, entry.name)] : [];
  });
}

/** 把键交给 pg_* 调用的形式：`pg_xxx_advisory_xxx(${name(` ，且 name 在同文件里定义为 lockKey / lockKey32 的返回值。 */
function keyHandedFromCommon(text: string, line: string): boolean {
  const call = /pg_(?:try_)?advisory\w*\(\s*\$\{\s*(\w+)\(/.exec(line);
  if (!call) return false;
  return new RegExp(`\\b${call[1]}\\s*=\\s*\\([^)]*\\)(?::\\s*\\w+)?\\s*=>\\s*lockKey(32)?\\(`).test(text);
}

/** 找出自己拼锁键、没经公共函数的行（行号从 1 起）。 */
export function findBypasses(text: string): number[] {
  return text.split('\n').flatMap((line, index) => {
    if (COMMENT_LINE.test(line) || !RAW_LOCK.test(line)) return [];
    return keyHandedFromCommon(text, line) ? [] : [index + 1];
  });
}

/** 去掉白名单登记的命中行（每条登记只抵消一次）后剩下的自拼锁键行号。 */
export function unlistedBypasses(text: string, allowed: readonly string[] = []): number[] {
  const lines = text.split('\n');
  const quota = [...allowed];
  return findBypasses(text).filter((n) => {
    const at = quota.indexOf(lines[n - 1]!.trim());
    if (at < 0) return true;
    quota.splice(at, 1);
    return false;
  });
}

describe('F-491 静态守卫：锁键不得绕过公共函数', () => {
  const files = ['apps', 'packages']
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .map((file) => relative(ROOT, file))
    .filter((file) => file !== COMMON);

  it('apps/、packages/ 里没有未登记的自拼锁键（附件登记锁键也走公共函数）', () => {
    const bypasses = files.flatMap((file) =>
      unlistedBypasses(readFileSync(join(ROOT, file), 'utf8'), ALLOWED[file]?.lines).map((line) => `${file}:${line}`),
    );
    expect(bypasses, '这些位置自己拼了咨询锁键：改用 advisory-lock.ts 的 advisoryLock / lockKey + asUuid').toEqual([]);
  });

  it('白名单没有过期：登记的文件仍存在，命中行与登记逐条一致、数量相同', () => {
    for (const [file, { lines: allowed }] of Object.entries(ALLOWED)) {
      expect(files, `${file} 已不存在，请从白名单删除`).toContain(file);
      const text = readFileSync(join(ROOT, file), 'utf8');
      const hits = findBypasses(text).map((n) => text.split('\n')[n - 1]!.trim());
      expect(hits.sort(), `${file} 的咨询锁调用与白名单登记不一致`).toEqual([...allowed].sort());
    }
  });

  it('扫描器自检：手写 toLowerCase 拼键、裸 hashtext 会被抓到；经公共函数产出的键放行', () => {
    const handRolled = [
      'const key = `${ctx.tenantId.toLowerCase()}:${ctx.userId.toLowerCase()}:attachments`;',
      'await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);',
    ].join('\n');
    expect(findBypasses(handRolled)).toEqual([2]);
    expect(findBypasses('x = sql`SELECT pg_advisory_xact_lock(hashtext(${k}))`')).toEqual([1]);
    const fromCommon = [
      'const gate = (t: string, u: string) =>',
      "  lockKey('gate:', asUuid(t), ':', asUuid(u));",
      'await tx.execute(sql`SELECT pg_advisory_xact_lock(${gate(t, u)})`);',
    ].join('\n');
    expect(findBypasses(fromCommon)).toEqual([]);
    // 参数来自别处、不是公共函数产出的函数，不放行
    const foreign = [
      'const gate = (t: string) => t;',
      'await tx.execute(sql`SELECT pg_advisory_xact_lock(${gate(t)})`);',
    ];
    expect(findBypasses(foreign.join('\n'))).toEqual([2]);
    expect(findBypasses('// pg_advisory_xact_lock 说明\n/** hashtext(…) */\n * pg_try_advisory_lock')).toEqual([]);
  });

  it('白名单自检：登记文件里追加未规范化的裸锁调用会被抓到，登记行只抵消一次', () => {
    const file = 'apps/api/src/modules/survey360/credential-key-registry.ts';
    const { lines: allowed } = ALLOWED[file]!;
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(unlistedBypasses(text, allowed)).toEqual([]);
    const raw = 'await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`);';
    const injected = `${text}\n${raw}`;
    expect(unlistedBypasses(injected, allowed)).toEqual([injected.split('\n').length]);
    const duplicated = `${text}\n${allowed[1]}`;
    expect(unlistedBypasses(duplicated, allowed)).toEqual([duplicated.split('\n').length]);
  });
});

describe('F-491 公共键函数', () => {
  const testDb = useTestDb();
  const keyOf = async (key: ReturnType<typeof lockKey>) => {
    const result = await testDb().db.execute(sql`SELECT ${key}::text AS k`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { k: string }[];
    return rows[0]!.k;
  };
  const tenant = 'aaaaaaaa-1111-4222-8333-abcdefabcdef';
  const user = 'bbbbbbbb-1111-4222-8333-abcdefabcdef';

  it('租户 / 用户 UUID 大小写混用得到同一键', async () => {
    const lower = await keyOf(lockKey(asUuid(tenant), ':', asUuid(user), ':attachments'));
    expect(await keyOf(lockKey(asUuid(tenant.toUpperCase()), ':', asUuid(user), ':attachments'))).toBe(lower);
    expect(await keyOf(lockKey(asUuid(tenant), ':', asUuid(user.toUpperCase()), ':attachments'))).toBe(lower);
    expect(await keyOf(lockKey(asUuid(tenant.toUpperCase()), ':', asUuid(user.toUpperCase()), ':attachments'))).toBe(
      lower,
    );
    const lower32 = await keyOf(lockKey32('ql_levels:', asUuid(tenant)));
    expect(await keyOf(lockKey32('ql_levels:', asUuid(tenant.toUpperCase())))).toBe(lower32);
  });

  it('不同 UUID、不同位置、不同后缀得到不同键', async () => {
    const base = await keyOf(lockKey(asUuid(tenant), ':', asUuid(user), ':attachments'));
    const otherUser = 'bbbbbbbb-1111-4222-8333-abcdefabcde0';
    expect(await keyOf(lockKey(asUuid(tenant), ':', asUuid(otherUser), ':attachments'))).not.toBe(base);
    expect(await keyOf(lockKey(asUuid(user), ':', asUuid(tenant), ':attachments'))).not.toBe(base);
    expect(await keyOf(lockKey(asUuid(tenant), ':', asUuid(user), ':other'))).not.toBe(base);
  });

  it('非法 UUID 由数据库报错，不会悄悄用原文拼键', async () => {
    await expect(keyOf(lockKey(asUuid('not-a-uuid'), ':attachments'))).rejects.toThrow();
  });

  it('全小写输入下键与改造前的键文本哈希一致（新旧进程混跑仍是同一把锁）', async () => {
    const legacy = await testDb().db.execute(
      sql`SELECT hashtextextended(${`${tenant}:${user}:attachments`}, 0)::text AS k`,
    );
    const rows = (Array.isArray(legacy) ? legacy : (legacy as { rows: unknown[] }).rows) as { k: string }[];
    expect(await keyOf(lockKey(asUuid(tenant), ':', asUuid(user), ':attachments'))).toBe(rows[0]!.k);
  });
});
