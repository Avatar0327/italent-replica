/**
 * scripts/ac-coverage.mjs 的自测（派发规则 §6）：编号展开、标题与 it.each 参数表识别、todo / skip 不计覆盖、
 * 条件执行标记、人工备注改状态、人工映射校验与失效报告、报告标记块改写与 --check 过期检测。
 * 夹具全部写在临时目录，不读取真实的 docs / tests。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/ac-coverage.mjs');
const root = mkdtempSync(join(tmpdir(), 'ac-coverage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}

write(
  'docs/trace.md',
  [
    '| 编号 | 场景 |',
    '|---|---|',
    ...['01', '02', '03', '04', '05', '06', '07', '08'].map((n) => `| AC-DEMO-${n} | 合成场景 ${n} |`),
    '| AC-DEMO-09（段一） | 带括号说明的定义 |',
    '| AC-OTHER-01~03 | 追溯关系中的范围行不算定义 |',
  ].join('\n'),
);
write(
  'tests/demo.test.ts',
  `import { describe, it } from 'vitest';
const rows = [{ ac: 'AC-DEMO-05' }, { ac: 'AC-DEMO-06' }];
describe('AC-DEMO-01/02 合成分组', () => {
  it('普通用例', () => {});
  it.todo('AC-DEMO-03 待办不计');
  it.each(rows)('参数化 $ac', () => {});
});
describe.runIf(false)('真 PG 专用', () => {
  it('AC-DEMO-07~08 条件执行', () => {});
});
it('标题没写编号的证据用例', () => {});
`,
);
const config = {
  title: '合成',
  root: '.',
  tests: ['tests'],
  definitions: ['docs'],
  groups: [
    { name: '甲组', include: ['AC-DEMO-01~05'] },
    { name: '乙组', include: ['AC-DEMO-04~10'] },
  ],
  notes: {
    'AC-DEMO-02': { status: '部分覆盖', category: '待取证', note: '合成备注' },
    'AC-DEMO-04': { evidence: [{ file: 'demo.test.ts', title: '标题没写编号的证据用例' }] },
    'AC-DEMO-09': { evidence: [{ file: 'demo.test.ts', title: '不存在的用例' }] },
  },
};
write('config.json', JSON.stringify(config));

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--config', join(root, 'config.json'), ...args], { encoding: 'utf8' });
}

function rowsOf() {
  const result = JSON.parse(
    execFileSync(process.execPath, [SCRIPT, '--config', join(root, 'config.json'), '--format', 'json'], {
      encoding: 'utf8',
    }),
  ) as {
    groups: { name: string; rows: { id: string; status: string; cases: number; mappedCases: number }[] }[];
    problems: string[];
    totals: Record<string, unknown>;
  };
  return { ...result, byId: new Map(result.groups.flatMap((g) => g.rows).map((r) => [r.id, r])) };
}

describe('ac-coverage 统计规则', () => {
  it('展开 / 与 ~ 写法；分组去重；首列单编号才算定义，范围行不算', () => {
    const { groups, byId } = rowsOf();
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([
      ['AC-DEMO-01', 'AC-DEMO-02', 'AC-DEMO-03', 'AC-DEMO-04', 'AC-DEMO-05'],
      ['AC-DEMO-06', 'AC-DEMO-07', 'AC-DEMO-08', 'AC-DEMO-09', 'AC-DEMO-10'],
    ]);
    expect(byId.get('AC-DEMO-10')).toMatchObject({ status: '未定义' });
  });

  it('describe 标题编号计入其下用例；it.each 参数表编号计入；todo 不计覆盖', () => {
    const { byId } = rowsOf();
    expect(byId.get('AC-DEMO-01')).toMatchObject({ status: '已覆盖', cases: 2 });
    expect(byId.get('AC-DEMO-03')).toMatchObject({ status: '未覆盖', cases: 0 });
    expect(byId.get('AC-DEMO-05')).toMatchObject({ status: '已覆盖', cases: 1 });
    expect(byId.get('AC-DEMO-06')).toMatchObject({ status: '已覆盖', cases: 1 });
  });

  it('runIf 等条件执行仍计覆盖并标注；人工备注可改状态', () => {
    const { byId } = rowsOf();
    expect(byId.get('AC-DEMO-07')).toMatchObject({ status: '已覆盖', conditional: true });
    expect(byId.get('AC-DEMO-02')).toMatchObject({ status: '部分覆盖', category: '待取证' });
  });

  it('人工映射命中存在的用例计入；找不到的映射报“映射失效”', () => {
    const { byId, problems } = rowsOf();
    expect(byId.get('AC-DEMO-04')).toMatchObject({ status: '已覆盖', cases: 0, mappedCases: 1 });
    expect(problems).toEqual([expect.stringContaining('AC-DEMO-09：人工映射失效')]);
  });

  it('--write 只改写标记块；--check 在报告过期或有映射失效时退出 1', () => {
    write('report.md', '# 报告\n\n<!-- ac-coverage:begin -->\n旧内容\n<!-- ac-coverage:end -->\n\n## 尾部\n');
    const report = join(root, 'report.md');
    expect(run('--check', report).status).toBe(1);
    run('--write', report);
    const text = readFileSync(report, 'utf8');
    expect(text).toContain('| **合计** | **10** | **6** | **1** | **2** | **1** |');
    expect(text.startsWith('# 报告')).toBe(true);
    expect(text.endsWith('## 尾部\n')).toBe(true);
    expect(text).not.toContain('旧内容');
    // 报告已是最新，但仍有映射失效 → 1；去掉失效映射后 → 0。
    expect(run('--check', report).status).toBe(1);
    const fixed = { ...config, notes: { ...config.notes, 'AC-DEMO-09': {} } };
    write('config.json', JSON.stringify(fixed));
    run('--write', report);
    expect(run('--check', report).status).toBe(0);
    write('config.json', JSON.stringify(config));
  });

  it('未知参数或缺少配置时退出 2 并给出原因', () => {
    const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('--config');
    expect(run('--unknown', 'x').status).toBe(2);
  });
});

/**
 * DEC-245（PR #91 第五轮）：参数表只认白名单写法——标题直接写编号、.each / .for 的内联数组字面量、
 * 同文件顶层 const 数组字面量（全文无重赋值、无同名遮蔽）。其他写法一律进 problems、--check 失败，且不计入覆盖。
 */
describe('ac-coverage 白名单（DEC-245）', () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-coverage-whitelist-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const put = (path: string, lines: string[]) => {
    mkdirSync(join(base, path, '..'), { recursive: true });
    writeFileSync(join(base, path), `${lines.join('\n')}\n`);
  };
  const ids = Array.from({ length: 29 }, (_, i) => `AC-DEMO-${String(i + 1).padStart(2, '0')}`);
  put('docs/trace.md', ['| 编号 | 场景 |', '|---|---|', ...ids.map((id) => `| ${id} | 合成 |`)]);

  function check(name: string, tests: string[]) {
    put(`${name}.json`, [
      JSON.stringify({
        title: name,
        root: '.',
        tests,
        definitions: ['docs'],
        groups: [{ name, include: ['AC-DEMO-01~29'] }],
      }),
    ]);
    const args = [SCRIPT, '--config', join(base, `${name}.json`)];
    const json = spawnSync(process.execPath, [...args, '--format', 'json'], { encoding: 'utf8' });
    const result = JSON.parse(json.stdout) as {
      groups: { rows: { id: string; status: string; cases: number }[] }[];
      problems: string[];
    };
    put(`${name}.md`, ['<!-- ac-coverage:begin -->', '<!-- ac-coverage:end -->']);
    spawnSync(process.execPath, [...args, '--write', join(base, `${name}.md`)], { encoding: 'utf8' });
    const verdict = spawnSync(process.execPath, [...args, '--check', join(base, `${name}.md`)], { encoding: 'utf8' });
    const byId = new Map(result.groups[0]!.rows.map((r) => [r.id, r]));
    return { problems: result.problems, byId, status: verdict.status, stderr: verdict.stderr };
  }

  // 每个反例单独成文件：[文件名, 源码行, 期望的 problems（行号与原因）]。
  const REJECTED = [
    [
      'catch-shadow',
      [
        "import { it } from 'vitest';",
        "const rows = [{ ac: 'AC-DEMO-01' }];",
        'try {',
        "  throw [{ ac: 'AC-DEMO-02' }];",
        '} catch (rows) {',
        "  it.each(rows)('$ac', () => {});",
        '}',
      ],
      [/:6：.*“rows”.*第 5 行有同名声明/],
    ],
    [
      'destructure-let',
      [
        "import { it } from 'vitest';",
        "let rows = [{ ac: 'AC-DEMO-01' }];",
        "[rows] = [[{ ac: 'AC-DEMO-02' }]];",
        "it.each(rows)('$ac', () => {});",
      ],
      [/:4：.*“rows”.*不是同文件顶层 const/],
    ],
    [
      'destructure-const',
      [
        "import { it } from 'vitest';",
        "const rows = [{ ac: 'AC-DEMO-01' }];",
        "const other = { rows: [{ ac: 'AC-DEMO-02' }] };",
        '({ rows } = other);',
        "it.each(rows)('$ac', () => {});",
      ],
      [/:5：.*“rows”.*第 4 行被重新赋值/],
    ],
    [
      'imported',
      ["import { it } from 'vitest';", "import { rows } from './tables.js';", "it.each(rows)('$ac', () => {});"],
      [/:3：.*“rows”.*不是同文件顶层 const/],
    ],
    [
      'function-param',
      [
        "import { it } from 'vitest';",
        "[[{ ac: 'AC-DEMO-01' }]].forEach((rows) => {",
        "  it.each(rows)('$ac', () => {});",
        '});',
      ],
      [/:3：.*“rows”.*不是同文件顶层 const/],
    ],
    [
      'let-table',
      ["import { it } from 'vitest';", "let rows = [{ ac: 'AC-DEMO-01' }];", "it.each(rows)('$ac', () => {});"],
      [/:3：.*“rows”.*不是同文件顶层 const/],
    ],
    [
      'nested-const',
      [
        "import { describe, it } from 'vitest';",
        "describe('d', () => {",
        "  const rows = [{ ac: 'AC-DEMO-01' }];",
        "  it.each(rows)('$ac', () => {});",
        '});',
      ],
      [/:4：.*“rows”.*不是同文件顶层 const/],
    ],
    [
      'spread',
      ["import { it } from 'vitest';", "const base = [{ ac: 'AC-DEMO-01' }];", "it.each([...base])('$ac', () => {});"],
      [/:3：参数表含非字面量（展开）/],
    ],
    // 第三轮回归：两个 describe 各自声明同名 rows——按 DEC-245 属非顶层声明，两处都报。
    [
      'same-name',
      [
        "import { describe, it } from 'vitest';",
        "describe('one', () => {",
        "  const rows = [{ ac: 'AC-DEMO-01' }];",
        "  it.each(rows)('$ac', () => {});",
        '});',
        "describe('two', () => {",
        "  const rows = [{ ac: 'AC-DEMO-02' }];",
        "  it.each(rows)('$ac', () => {});",
        '});',
      ],
      [/:4：.*“rows”.*不是同文件顶层 const/, /:8：.*“rows”.*不是同文件顶层 const/],
    ],
    [
      'call-table',
      ["import { it } from 'vitest';", "it.each(['AC-DEMO-01'].map((ac) => ({ ac })))('$ac', () => {});"],
      [/:2：参数表不是数组字面量/],
    ],
    [
      'identifier-leaf',
      ["import { it } from 'vitest';", "const ac = 'AC-DEMO-01';", "it.each([{ ac }])('$ac', () => {});"],
      [/:3：参数表含非字面量（简写属性）/],
    ],
    [
      'template-title',
      ["import { it } from 'vitest';", "const id = 'AC-DEMO-01';", 'it(`${id} 标题`, () => {});'],
      [/:3：用例标题含模板插值/],
    ],
    [
      'identifier-title',
      ["import { it } from 'vitest';", "for (const title of ['AC-DEMO-01']) it(title, () => {});"],
      [/:2：用例标题不是字符串字面量/],
    ],
    [
      'helper-function',
      [
        "import { describe, it } from 'vitest';",
        'function cases() {',
        "  it('AC-DEMO-01 定义在函数里', () => {});",
        '}',
        "describe('AC-DEMO-02 外层', () => cases());",
      ],
      [/:3：用例定义在函数“cases”中/],
    ],
    [
      'tagged-each',
      ["import { it } from 'vitest';", "it.each`ac\n${'AC-DEMO-01'}`('$ac', () => {});"],
      [/:2：参数表不是数组字面量/],
    ],
    [
      'alias-import',
      ["import { it as check } from 'vitest';", "check('AC-DEMO-01', () => {});"],
      [/:1：从 vitest 以别名导入“it”/],
    ],
    [
      'extended-test',
      ["import { it } from 'vitest';", 'const custom = it.extend({});', "custom('AC-DEMO-01', () => {});"],
      [/:2：自定义用例函数（it\.extend）/],
    ],
  ] as const;

  put('rejected/tables.js', ["export const rows = [{ ac: 'AC-DEMO-02' }];"]);
  for (const [name, lines] of REJECTED) put(`rejected/${name}.test.ts`, [...lines]);

  it.each(REJECTED)('反例 %s：进入 problems、--check 失败、不计入覆盖', (name, _lines, expected) => {
    const { problems, byId, status, stderr } = check(name, [`rejected/${name}.test.ts`]);
    expect(problems).toHaveLength(expected.length);
    expected.forEach((pattern, i) => expect(problems[i]).toMatch(new RegExp(`${name}\\.test\\.ts${pattern.source}`)));
    expect(status).toBe(1);
    expect(stderr).toContain(problems[0]);
    expect(byId.get('AC-DEMO-02')).toMatchObject({ status: '未覆盖', cases: 0 });
    if (name !== 'helper-function') expect(byId.get('AC-DEMO-01')).toMatchObject({ status: '未覆盖', cases: 0 });
  });

  put('accepted/whitelist.test.ts', [
    "import { describe, it, test } from 'vitest';",
    "const rows = [{ ac: 'AC-DEMO-23' }] as const;",
    "it('AC-DEMO-20 标题直接写编号', () => {});",
    "it.each([{ ac: 'AC-DEMO-21' }, { ac: 'AC-DEMO-22' }])('$ac 内联数组字面量', () => {});",
    "describe('同文件顶层 const 数组字面量', () => {",
    "  it.each(rows)('$ac 第一次引用', () => {});",
    "  test.for(rows)('$ac 第二次引用', () => {});",
    "  it('读取不算重赋值', () => void rows.length);",
    '});',
    "it.each([{ ac: 'AC-DEMO-24', note: 'AC-DEMO-25', run: () => 1 }])('$ac 只计标题引用的字段', () => {});",
    "it.each([['AC-DEMO-26', 'AC-DEMO-27']])('%s 按位置只计第一个', () => {});",
    "it.each(Array.from({ length: 2 }))('AC-DEMO-28 标题无占位时不读参数表', () => {});",
  ]);
  put('accepted/other-file.test.ts', [
    "import { it } from 'vitest';",
    "const rows = [{ ac: 'AC-DEMO-29' }];",
    "it.each(rows)('$ac 另一文件的同名顶层 const 互不影响', () => {});",
  ]);

  it('白名单三种写法计入覆盖、problems 为空、--check 通过；只计标题实际引用的参数', () => {
    const { problems, byId, status } = check('accepted', ['accepted']);
    expect(problems).toEqual([]);
    expect(status).toBe(0);
    const covered = { 20: 1, 21: 1, 22: 1, 23: 2, 24: 1, 26: 1, 28: 1, 29: 1 };
    for (const [n, cases] of Object.entries(covered))
      expect(byId.get(`AC-DEMO-${n}`)).toMatchObject({ status: '已覆盖', cases });
    for (const n of ['25', '27']) expect(byId.get(`AC-DEMO-${n}`)).toMatchObject({ status: '未覆盖', cases: 0 });
  });
});
