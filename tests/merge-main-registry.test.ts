/**
 * F-133（DEC-491④）：pnpm merge:main 登记类冲突自动合并的纯函数与仓库守卫（scripts/merge-main-registry-lib.mjs）。
 * - 逐行登记文件：纯新增取并集（本分支在前、去重），改了 / 删了已有条目、夹有其他代码则不处理；
 * - 声明文件 required/declared/<模块>.ts：结构化三方并集，有序则排序，写法超出已知形状则不处理；
 * - 守卫：登记文件的登记区只含已知形状的行；所有真实声明文件原样往返（合并后写法与仓库逐字一致）；
 *   证据登记 / 冻结基准目录里的文件，不是“生成物白名单”就必须是明确登记的人工账本（新增生成文件类型时这里报红，提醒更新白名单）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isGeneratedPath } from '../scripts/merge-main-lib.mjs';
import {
  DECLARED_DIR,
  DECLARED_INDEX_PATH,
  declaredProblems,
  isDeclaredModulePath,
  isRegistryPath,
  loadTools,
  mergeDeclared,
  parseDeclared,
  REGISTRY_LINE_FILES,
  registryProblems,
  resolveLineRegistry,
  resolveRegistryFile,
  roundTripDeclared,
  type RegistryTools,
  unionLineHunk,
} from '../scripts/merge-main-registry-lib.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(REPO, file), 'utf8');
const FILE = `${DECLARED_DIR}/talent.ts`;

let tools: RegistryTools;
beforeAll(async () => {
  const loaded = await loadTools();
  if (!loaded) throw new Error('缺少 typescript / prettier');
  tools = loaded;
});

const declared = (sections: Record<string, (string | string[])[]>, comments: Record<string, string> = {}) => {
  const show = (item: string | string[]) =>
    Array.isArray(item) ? `[${item.map((s) => `'${s}'`).join(', ')}]` : `'${item}'`;
  const body = Object.entries(sections)
    .map(([key, items]) => {
      const lines = items.map((i) => `    ${show(i)},`).join('\n');
      return `  /** ${comments[key] ?? `${key} 说明`} */\n  ${key}: [\n${lines}\n  ],\n`;
    })
    .join('');
  return [
    "import type { ModuleDeclared } from '../../module-declared.js';",
    '',
    '/** talent 模块的声明 */',
    `export const TALENT_DECLARED: ModuleDeclared = {${body ? `\n${body}` : ''}};`,
    '',
  ].join('\n');
};

describe('逐行登记：unionLineHunk / resolveLineRegistry', () => {
  const patterns = REGISTRY_LINE_FILES['packages/db/src/schema/index.ts']!;
  const exportLine = (n: string) => `export * from './${n}.js';\n`;

  it('两边都是纯新增：本分支在前、main 在后，去重', () => {
    expect(unionLineHunk(patterns, { ours: exportLine('a'), base: '', theirs: exportLine('b') })).toBe(
      `${exportLine('a')}${exportLine('b')}`,
    );
    expect(unionLineHunk(patterns, { ours: exportLine('a'), base: '', theirs: exportLine('a') })).toBe(exportLine('a'));
    const base = exportLine('x');
    expect(unionLineHunk(patterns, { ours: base + exportLine('a'), base, theirs: base + exportLine('b') })).toBe(
      `${base}${exportLine('a')}${exportLine('b')}`,
    );
  });

  it('一侧改了或删了已有条目、夹有其他代码、含空行：不处理', () => {
    const base = exportLine('x');
    expect(unionLineHunk(patterns, { ours: exportLine('y'), base, theirs: base + exportLine('b') })).toBeNull();
    expect(unionLineHunk(patterns, { ours: '', base, theirs: base + exportLine('b') })).toBeNull();
    expect(unionLineHunk(patterns, { ours: 'const a = 1;\n', base: '', theirs: exportLine('b') })).toBeNull();
    expect(
      unionLineHunk(patterns, { ours: `${exportLine('a')}\n${exportLine('c')}`, base: '', theirs: exportLine('b') }),
    ).toBeNull();
  });

  it('diff3 文本：全部冲突处满足才算解决，否则保留标记并计数', () => {
    const diff3 = [
      "export * from './x.js';",
      '<<<<<<< HEAD',
      "export * from './a.js';",
      '||||||| merge-base',
      '=======',
      "export * from './b.js';",
      '>>>>>>> origin/main',
      '',
    ].join('\n');
    const resolved = resolveLineRegistry('packages/db/src/schema/index.ts', diff3)!;
    expect(resolved.remaining).toBe(0);
    expect(resolved.text).toBe("export * from './x.js';\nexport * from './a.js';\nexport * from './b.js';\n");
    expect(resolveLineRegistry('apps/api/src/modules/org/service.ts', diff3)).toBeNull();
  });
});

describe('声明文件结构化合并：mergeDeclared', () => {
  const A = 'POST /api/tenant/talent/a';
  const B = 'POST /api/tenant/talent/b';
  const C = 'POST /api/tenant/talent/c';
  const D = 'GET /api/tenant/talent/d';
  const merge = (ours: string, base: string, theirs: string) => mergeDeclared(tools, FILE, { ours, base, theirs });

  it('同一数组两边各加：并集、有序则按码点排序，不丢任何一方', async () => {
    const result = await merge(
      declared({ sameStatusInvalidId: [A, C] }),
      declared({ sameStatusInvalidId: [A] }),
      declared({ sameStatusInvalidId: [D, A, B] }),
    );
    expect(result.error).toBeUndefined();
    expect(parseDeclared(tools.ts, result.text!).keys[0]!.items).toEqual([D, A, B, C]);
  });

  it('两边都加同一条：只留一条；一侧删除、另一侧没动：删除', async () => {
    const dup = await merge(
      declared({ sameStatusInvalidId: [A, B] }),
      declared({ sameStatusInvalidId: [A] }),
      declared({ sameStatusInvalidId: [A, B] }),
    );
    expect(parseDeclared(tools.ts, dup.text!).keys[0]!.items).toEqual([A, B]);
    const removed = await merge(
      declared({ sameStatusInvalidId: [A, B, C] }),
      declared({ sameStatusInvalidId: [A, B] }),
      declared({ sameStatusInvalidId: [B] }),
    );
    expect(parseDeclared(tools.ts, removed.text!).keys[0]!.items).toEqual([B, C]);
  });

  it('不同种类各加、元组条目、新种类追加在后；本分支种类顺序在前', async () => {
    const result = await merge(
      declared({ multiCarrierAdmission: [A], selectorSites: [[A, 'of[0].object']] }),
      declared({}),
      declared({ branchInputEndpoints: [B], selectorSites: [[B, 'of[0].button']] }),
    );
    expect(result.error).toBeUndefined();
    const keys = parseDeclared(tools.ts, result.text!).keys;
    expect(keys.map((k) => k.name)).toEqual(['multiCarrierAdmission', 'selectorSites', 'branchInputEndpoints']);
    expect(keys[1]!.items).toEqual([
      [A, 'of[0].object'],
      [B, 'of[0].button'],
    ]);
    expect(
      declaredProblems(tools, result.text!, {
        ours: declared({ multiCarrierAdmission: [A], selectorSites: [[A, 'of[0].object']] }),
        base: declared({}),
        theirs: declared({ branchInputEndpoints: [B], selectorSites: [[B, 'of[0].button']] }),
      }),
    ).toEqual([]);
  });

  it('原先无序的数组：不排序，本分支顺序在前、main 新增在后', async () => {
    const result = await merge(
      declared({ sameStatusInvalidId: [C, A, B] }),
      declared({ sameStatusInvalidId: [C, A] }),
      declared({ sameStatusInvalidId: [C, A, D] }),
    );
    expect(parseDeclared(tools.ts, result.text!).keys[0]!.items).toEqual([C, A, B, D]);
  });

  it('结果就是仓库的 prettier 写法（长元组换行、单引号、尾逗号）', async () => {
    const long = 'GET /api/tenant/talent/' + 'x'.repeat(70);
    const result = await merge(
      declared({ selectorSites: [[long, 'btn:Talent.Activity#viewAll@list']] }),
      declared({}),
      declared({ selectorSites: [[B, 'of[0].button']] }),
    );
    expect(result.text).toBe(await roundTripDeclared(tools, FILE, result.text!));
    expect(result.text).toContain(`    [\n      '${long}',`);
  });

  it('两边都改了同一种类的说明且不同、写法超出已知形状：不自动处理', async () => {
    const comment = await merge(
      declared({ sameStatusInvalidId: [A, B] }, { sameStatusInvalidId: '甲' }),
      declared({ sameStatusInvalidId: [A] }, { sameStatusInvalidId: '原' }),
      declared({ sameStatusInvalidId: [A, C] }, { sameStatusInvalidId: '乙' }),
    );
    expect(comment.error).toContain('sameStatusInvalidId 的说明两边都改了且不同');
    const spread = declared({ sameStatusInvalidId: [A] }).replace("    'POST /api/tenant/talent/a',", '    ...OTHER,');
    expect(
      (await merge(spread, declared({ sameStatusInvalidId: [A] }), declared({ sameStatusInvalidId: [A, B] }))).error,
    ).toContain('不是字符串或字符串元组');
    const inline = declared({ sameStatusInvalidId: [A] }).replace(
      "'POST /api/tenant/talent/a',",
      "// 注释\n    'POST /api/tenant/talent/a',",
    );
    expect(
      (await merge(inline, declared({ sameStatusInvalidId: [A] }), declared({ sameStatusInvalidId: [A, B] }))).error,
    ).toContain('带注释');
  });

  it('并集校验：结果丢了任一侧的新增项、或出现重复，都报问题', () => {
    const versions = {
      ours: declared({ sameStatusInvalidId: [A, C] }),
      base: declared({ sameStatusInvalidId: [A] }),
      theirs: declared({ sameStatusInvalidId: [A, B] }),
    };
    expect(declaredProblems(tools, declared({ sameStatusInvalidId: [A, B] }), versions)).toEqual([
      `本分支新增的登记项丢失：sameStatusInvalidId ${JSON.stringify(C)}`,
    ]);
    expect(declaredProblems(tools, declared({ sameStatusInvalidId: [A, B, C, C] }), versions)).toEqual([
      `登记项重复：sameStatusInvalidId ${JSON.stringify(C)}`,
    ]);
    expect(registryProblems(tools, FILE, declared({ sameStatusInvalidId: [A, B, C] }), versions)).toEqual([]);
  });

  it('resolveRegistryFile：一侧缺文件 / 非登记文件 / 缺工具时返回 error 留给人工', async () => {
    const versions = { ours: undefined, base: declared({}), theirs: declared({}) };
    expect((await resolveRegistryFile(tools, FILE, { versions, diff3: undefined })).error).toContain('一侧缺少');
    expect((await resolveRegistryFile(tools, 'apps/api/src/x.ts', { versions, diff3: '' })).error).toContain(
      '不是登记类',
    );
    expect(
      (await resolveRegistryFile(undefined, FILE, { versions: { ours: '', base: '', theirs: '' }, diff3: '' })).error,
    ).toContain('缺少 typescript');
  });
});

describe('守卫：登记文件的写法没有漂出脚本认识的形状', () => {
  it('逐行登记文件都存在，登记区的每一行都符合已登记的形状', () => {
    const regionOf = (file: string, text: string) => {
      const lines = text.split('\n');
      if (file === 'apps/api/src/app.ts') {
        const start = lines.findIndex((l) => l.startsWith('const TENANT_MODULES'));
        const end = lines.findIndex((l, i) => i > start && l.startsWith(']'));
        return [
          ...lines.slice(0, start).filter((l) => /^import .*register\w+/.test(l)),
          ...lines.slice(start + 1, end),
        ];
      }
      if (file.endsWith('index.ts') && file.includes('route-policy')) {
        const objectStart = lines.findIndex((l) => /^export const \w+.*= \{$/.test(l));
        const end = lines.findIndex((l, i) => i > objectStart && l.startsWith('}'));
        return [
          ...lines.filter((l) => l.startsWith('import { ') && !l.includes('import type')),
          ...lines.slice(objectStart + 1, end),
        ];
      }
      return lines.filter((l) => l.trim());
    };
    for (const [file, patterns] of Object.entries(REGISTRY_LINE_FILES)) {
      const text = read(file);
      const region = regionOf(file, text).filter((l) => l.trim());
      expect(region.length, `${file} 登记区为空`).toBeGreaterThan(5);
      const odd = region.filter((line) => !patterns.some((re) => re.test(line)));
      expect(
        odd,
        `${file} 里这些行不符合 merge:main 认识的登记行形状（改了写法要同步 scripts/merge-main-registry-lib.mjs）`,
      ).toEqual([]);
    }
  });

  it('每个 required/declared/<模块>.ts 都能解析并原样往返，且都登记在 declared/index.ts', async () => {
    const dir = path.join(REPO, DECLARED_DIR);
    const modules = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
    expect(modules.length).toBeGreaterThan(10);
    const index = read(DECLARED_INDEX_PATH);
    for (const name of modules) {
      const file = `${DECLARED_DIR}/${name}`;
      expect(isDeclaredModulePath(file) && isRegistryPath(file), file).toBe(true);
      expect(await roundTripDeclared(tools, file, read(file)), `${file} 往返后与仓库写法不同`).toBe(read(file));
      expect(index, `${file} 没登记到 declared/index.ts`).toContain(`from './${name.replace(/\.ts$/, '.js')}'`);
    }
  });

  it('证据登记 / 冻结基准目录里的每个文件：要么是生成物白名单，要么是明确登记的人工账本', () => {
    const MANUAL_LEDGERS = new Set([
      'tests/acceptance/support/route-policy/baseline/probe-known-gaps.json',
      'tests/acceptance/support/route-policy/baseline/probe-redundant-observations.json',
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(path.join(REPO, dir)).flatMap((name) => {
        const rel = `${dir}/${name}`;
        return statSync(path.join(REPO, rel)).isDirectory() ? walk(rel) : [rel];
      });
    const files = [
      ...walk('tests/acceptance/support/route-policy/required/digests'),
      ...walk('tests/acceptance/support/route-policy/baseline'),
    ];
    expect(files.length).toBeGreaterThan(10);
    const unclassified = files.filter((f) => !isGeneratedPath(f) && !MANUAL_LEDGERS.has(f));
    expect(
      unclassified,
      '这些文件既不在 merge:main 的生成物白名单（scripts/merge-main-lib.mjs GENERATED_PATHS）也不是登记的人工账本',
    ).toEqual([]);
  });
});
