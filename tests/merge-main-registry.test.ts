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
  compareEntries,
  parseEntries,
  isDeclaredModulePath,
  isRegistryPath,
  loadTools,
  mergeDeclared,
  parseDeclared,
  REGISTRY_LINE_FILES,
  REGISTRY_REGIONS,
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

  it('两边都加同一条：只留一条；一侧删除分叉点已有条目：转人工', async () => {
    const dup = await merge(
      declared({ sameStatusInvalidId: [A, B] }),
      declared({ sameStatusInvalidId: [A] }),
      declared({ sameStatusInvalidId: [A, B] }),
    );
    expect(parseDeclared(tools.ts, dup.text!).keys[0]!.items).toEqual([A, B]);
    // 一侧删除分叉点已有的条目：不是纯新增，转人工（第 2 轮 P2-1）
    const removed = await merge(
      declared({ sameStatusInvalidId: [A, B, C] }),
      declared({ sameStatusInvalidId: [A, B] }),
      declared({ sameStatusInvalidId: [B] }),
    );
    expect(removed.error).toContain('分叉点已有登记项被一侧删除或改动');
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
      registryProblems(
        tools,
        FILE,
        result.text,
        {
          ours: declared({ multiCarrierAdmission: [A], selectorSites: [[A, 'of[0].object']] }),
          base: declared({}),
          theirs: declared({ branchInputEndpoints: [B], selectorSites: [[B, 'of[0].button']] }),
        },
        { strict: true },
      ),
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

  it('核对：结果丢了任一侧的新增项、出现重复、多出条目都报问题；正确的结果通过', () => {
    const versions = {
      ours: declared({ sameStatusInvalidId: [A, C] }),
      base: declared({ sameStatusInvalidId: [A] }),
      theirs: declared({ sameStatusInvalidId: [A, B] }),
    };
    const check = (items: string[], strict = false) =>
      registryProblems(tools, FILE, declared({ sameStatusInvalidId: items }), versions, { strict });
    expect(check([A, B])).toEqual([`登记项丢失：declared:sameStatusInvalidId:${JSON.stringify(C)}（应为 1）`]);
    expect(check([A, B, C, C])).toEqual([
      `登记项重复：declared:sameStatusInvalidId:${JSON.stringify(C)}（需要只留一份；同一身份的值两边不一致时由人选择）`,
    ]);
    expect(check([A, B, C, D])).toEqual([`多出的登记项：declared:sameStatusInvalidId:${JSON.stringify(D)}（值 1）`]);
    expect(check([A, B, C])).toEqual([]);
    expect(check([A, B, C], true)).toEqual([]);
    expect(registryProblems(undefined, FILE, '', versions)).toEqual(['缺少 typescript / prettier，无法核对登记项']);
    // 文件缺失：应有身份非空 → 失败；四侧都没有 → 无可核对，通过（不需要工具）
    expect(registryProblems(tools, FILE, undefined, versions)[0]).toContain('登记文件缺失');
    const none = { ours: undefined, base: undefined, theirs: undefined };
    expect(registryProblems(tools, FILE, undefined, none)).toEqual([]);
    expect(registryProblems(undefined, FILE, undefined, none)).toEqual([]);
    // 两边新增相同的新文件（分叉点没有）：结果必须保留全部登记项
    const same = declared({ sameStatusInvalidId: [A, B] });
    const added = { ours: same, base: undefined, theirs: same };
    expect(registryProblems(tools, FILE, same, added)).toEqual([]);
    expect(registryProblems(tools, FILE, declared({}), added)).toHaveLength(2);
    expect(registryProblems(tools, FILE, undefined, added)[0]).toContain('登记文件缺失');
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

  it('登记区解析器能解析每个真实登记文件（改了写法导致解析不了会在这里报红，而不是合并时静默漏检）', () => {
    expect(Object.keys(REGISTRY_REGIONS).sort()).toEqual(Object.keys(REGISTRY_LINE_FILES).sort());
    for (const file of Object.keys(REGISTRY_REGIONS)) {
      const entries = parseEntries(tools, file, read(file));
      expect(entries.length, `${file} 解析出的条目太少`).toBeGreaterThan(5);
      const ids = entries.map((e) => e.id);
      expect(new Set(ids).size, `${file} 里有重复的登记身份`).toBe(ids.length);
    }
    const mounts = parseEntries(tools, 'apps/api/src/app.ts', read('apps/api/src/app.ts')).filter((e) =>
      e.id.startsWith('array:TENANT_MODULES:'),
    );
    expect(mounts.length).toBeGreaterThan(15);
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

describe('登记区解析器与按条目身份的比较（第 2 轮，DEC-431① 单一入口）', () => {
  const APP = 'apps/api/src/app.ts';
  const SCHEMA = 'packages/db/src/schema/index.ts';
  const REQUIRED = 'tests/acceptance/support/route-policy/required/index.ts';
  const ids = (file: string, text: string) => parseEntries(tools, file, text).map((e) => `${e.id}=${e.value}`);

  it('app.ts：导入按绑定、挂载按元素文本，尾注释与空白不影响身份', () => {
    const text = [
      "import { registerA, registerB as b } from './a.js';",
      "import type { T } from './t.js';",
      "import def from './d.js';",
      "import './side.js';",
      'const TENANT_MODULES: readonly X[] = [',
      '  registerA, // 注释甲',
      '  b,',
      '] as const;',
    ].join('\n');
    expect(ids(APP, text)).toEqual([
      'import:registerA=./a.js#registerA',
      'import:b=./a.js#registerB',
      'import:T=type ./t.js#T',
      'import:def=./d.js#default',
      'import-side-effect:./side.js=./side.js',
      'array:TENANT_MODULES:registerA=registerA',
      'array:TENANT_MODULES:b=b',
    ]);
    expect(ids(APP, text.replace('// 注释甲', '// 注释乙'))).toEqual(ids(APP, text));
  });

  it('schema/index.ts：单行、多行、命名空间导出都按导出名取条目', () => {
    const text = [
      "export * from './a.js';",
      'export {',
      '  one,',
      '  two as second,',
      "} from './b.js';",
      "export * as ns from './c.js';",
    ].join('\n');
    expect(ids(SCHEMA, text)).toEqual([
      'export*:./a.js=./a.js',
      'export:one=./b.js#one',
      'export:second=./b.js#two',
      'export:ns=./c.js#*',
    ]);
  });

  it('required/index.ts：对象属性按键（标识符或字符串键），同键多次出现就是重复', () => {
    const text = [
      "import { A } from './a.js';",
      'export const REQUIRED_BY_MODULE = {',
      '  root: A,',
      "  'tenant-settings': B,",
      '  other,',
      '};',
    ].join('\n');
    expect(ids(REQUIRED, text)).toEqual([
      'import:A=./a.js#A',
      'object:REQUIRED_BY_MODULE:root=A',
      'object:REQUIRED_BY_MODULE:tenant-settings=B',
      'object:REQUIRED_BY_MODULE:other=other',
    ]);
  });

  it('无法识别的形状一律抛出（不静默忽略）：登记区里的其他语句、找不到变量、不是字面量、属性不是键值', () => {
    expect(() => parseEntries(tools, SCHEMA, "export * from './a.js';\nconst x = 1;\n")).toThrow(
      '登记区里只许有 export',
    );
    expect(() => parseEntries(tools, SCHEMA, 'export const x = 1;\n')).toThrow('登记区里只许有 export');
    expect(() => parseEntries(tools, APP, 'const OTHER = [];\n')).toThrow('找不到 TENANT_MODULES');
    expect(() => parseEntries(tools, APP, 'const TENANT_MODULES = make();\n')).toThrow('不是数组字面量');
    expect(() => parseEntries(tools, APP, 'const TENANT_MODULES = [mount(c)];\n')).toThrow('不是直接标识符');
    expect(() => parseEntries(tools, APP, 'const TENANT_MODULES = [...more];\n')).toThrow('不是直接标识符');
    expect(() => parseEntries(tools, REQUIRED, 'const REQUIRED_BY_MODULE = { ...X };\n')).toThrow('无法识别的属性');
    expect(() => parseEntries(tools, 'apps/api/src/x.ts', '')).toThrow('不是登记类文件');
    const unknown = registryProblems(tools, SCHEMA, 'const x = 1;\n', { ours: '', base: '', theirs: '' });
    expect(unknown[0]).toContain('无法识别的形状');
  });

  const e = (id: string, value = '1') => ({ id, value });
  const compare = (r: string[], o: string[], b: string[], t: string[], strict: boolean) =>
    compareEntries(
      { result: r.map((x) => e(x)), ours: o.map((x) => e(x)), base: b.map((x) => e(x)), theirs: t.map((x) => e(x)) },
      { strict },
    );

  it('strict：分叉点已有条目被任一边删除或改动 → 须人工；两边纯新增的并集通过', () => {
    expect(compare(['A', 'C', 'D'], ['B', 'C'], ['A', 'B'], ['A', 'B', 'D'], true)[0]).toContain(
      '分叉点已有登记项被一侧删除或改动',
    );
    expect(compare(['B', 'C'], ['B'], ['A'], ['C'], true)).toHaveLength(1);
    expect(compare(['A', 'B', 'C'], ['A', 'B'], ['A'], ['A', 'C'], true)).toEqual([]);
  });

  it('strict：同一身份两边都新增但值不同 → 冲突；值相同 → 通过且只留一份', () => {
    const both = (ours: string, theirs: string, result: string[]) =>
      compareEntries(
        {
          result: result.map((v) => ({ id: 'k', value: v })),
          ours: [{ id: 'k', value: ours }],
          base: [],
          theirs: [{ id: 'k', value: theirs }],
        },
        { strict: true },
      );
    expect(both('甲', '乙', ['甲'])[0]).toContain('同一登记项两边值不同');
    expect(both('甲', '甲', ['甲'])).toEqual([]);
    expect(both('甲', '甲', ['甲', '甲'])[0]).toContain('登记项重复');
  });

  it('非 strict（提交前核对）：谁改了听谁的；两边改成不同的值由人决定；重复、丢失、多出都报', () => {
    const one = (r: (string | undefined)[], o?: string, b?: string, t?: string) => {
      const list = (v?: string) => (v === undefined ? [] : [{ id: 'k', value: v }]);
      return compareEntries({
        result: r.filter((v): v is string => v !== undefined).map((v) => ({ id: 'k', value: v })),
        ours: list(o),
        base: list(b),
        theirs: list(t),
      });
    };
    expect(one(['新'], '新', '旧', '旧')).toEqual([]); // 只有本分支改
    expect(one(['旧'], '新', '旧', '旧')[0]).toContain('登记项的值不符');
    expect(one([], undefined, '旧', '旧')).toEqual([]); // 本分支删，main 没动
    expect(one(['旧'], undefined, '旧', '旧')[0]).toContain('多出的登记项');
    expect(one([], '旧', '旧', '旧')[0]).toContain('登记项丢失'); // 都没动却丢了
    expect(one(['乙'], '甲', '旧', '乙')).toEqual([]);
    expect(one(['丙'], '甲', '旧', '乙')).toEqual([]); // 两边改成不同的值：人决定
    expect(one([], '甲', undefined, '乙')[0]).toContain('不能删除'); // 两边新增不同的值：人决定值，但必须保留一份
    expect(one(['丙'], '甲', undefined, '乙')).toEqual([]);
    expect(one([], undefined, '旧', '乙')).toEqual([]); // 一边删、一边改：人可以决定删掉
    expect(one(['甲', '甲'], '甲', undefined, '甲')[0]).toContain('登记项重复');
  });
});
