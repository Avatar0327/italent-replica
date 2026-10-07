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

/** 第四轮 P2：参数表标识符按使用位置的词法作用域解析；无法静态确定时报 problems，不静默择一。 */
describe('ac-coverage 参数表按词法作用域解析', () => {
  const scoped = mkdtempSync(join(tmpdir(), 'ac-coverage-scope-'));
  afterAll(() => rmSync(scoped, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    mkdirSync(join(scoped, path, '..'), { recursive: true });
    writeFileSync(join(scoped, path), text);
  };
  const ids = ['01', '02', '03', '04', '05', '06', '07'].map((n) => `AC-DEMO-${n}`);
  put('docs/trace.md', ['| 编号 | 场景 |', '|---|---|', ...ids.map((id) => `| ${id} | 合成 |`)].join('\n'));
  // 审查原文夹具：两个 describe 各自声明同名 rows。
  put(
    'tests/same-name.test.ts',
    `import { describe, it } from 'vitest';
describe('one', () => {
  const rows = [{ ac: 'AC-DEMO-01' }];
  it.each(rows)('$ac', () => {});
});
describe('two', () => {
  const rows = [{ ac: 'AC-DEMO-02' }];
  it.each(rows)('$ac', () => {});
});
`,
  );
  // 嵌套遮蔽：内层 describe 用内层 rows，外层用外层 rows（就近优先）。
  put(
    'tests/shadow.test.ts',
    `import { describe, it } from 'vitest';
const rows = [{ ac: 'AC-DEMO-03' }];
describe('outer', () => {
  it.each(rows)('$ac', () => {});
  describe('inner', () => {
    const rows = [{ ac: 'AC-DEMO-04' }];
    for (const kind of ['a', 'b']) it.each(rows)(\`\${kind} $ac\`, () => {});
  });
});
`,
  );
  // 无法静态确定：let 被重新赋值、同一作用域重复 var 声明 → 报 problems，两份都不计。
  put(
    'tests/ambiguous.test.ts',
    `import { it } from 'vitest';
let reassigned = [{ ac: 'AC-DEMO-05' }];
reassigned = [{ ac: 'AC-DEMO-06' }];
it.each(reassigned)('$ac', () => {});
var twice = [{ ac: 'AC-DEMO-07' }];
var twice = [{ ac: 'AC-DEMO-07' }];
it.each(twice)('$ac', () => {});
`,
  );
  put(
    'config.json',
    JSON.stringify({
      title: '作用域',
      root: '.',
      tests: ['tests'],
      definitions: ['docs'],
      groups: [{ name: '全部', include: ['AC-DEMO-01~07'] }],
    }),
  );

  function scopedResult() {
    const output = execFileSync(
      process.execPath,
      [SCRIPT, '--config', join(scoped, 'config.json'), '--format', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const result = JSON.parse(output) as {
      groups: { rows: { id: string; status: string; cases: number }[] }[];
      problems: string[];
    };
    return { ...result, byId: new Map(result.groups[0]!.rows.map((r) => [r.id, r])) };
  }

  it('两个 describe 同名 rows：AC-DEMO-01、AC-DEMO-02 各 1 个用例且均已覆盖', () => {
    const { byId } = scopedResult();
    expect(byId.get('AC-DEMO-01')).toMatchObject({ status: '已覆盖', cases: 1 });
    expect(byId.get('AC-DEMO-02')).toMatchObject({ status: '已覆盖', cases: 1 });
  });

  it('内层同名声明遮蔽外层：外层用例只计 AC-DEMO-03，内层循环两次只计 AC-DEMO-04', () => {
    const { byId } = scopedResult();
    expect(byId.get('AC-DEMO-03')).toMatchObject({ status: '已覆盖', cases: 1 });
    expect(byId.get('AC-DEMO-04')).toMatchObject({ status: '已覆盖', cases: 1 });
  });

  it('被重新赋值或重复声明的参数表无法静态确定：报 problems，不计入任何一份', () => {
    const { byId, problems } = scopedResult();
    for (const id of ['AC-DEMO-05', 'AC-DEMO-06', 'AC-DEMO-07'])
      expect(byId.get(id)).toMatchObject({ status: '未覆盖', cases: 0 });
    expect(problems).toEqual([
      expect.stringMatching(/ambiguous\.test\.ts:4.*reassigned.*无法静态确定/),
      expect.stringMatching(/ambiguous\.test\.ts:7.*twice.*无法静态确定/),
    ]);
  });
});
