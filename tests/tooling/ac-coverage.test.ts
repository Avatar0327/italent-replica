/**
 * F-030（DEC-254）：AC 覆盖统计改为 Vitest 运行时采集。
 * 夹具覆盖 #91 第 4、5 轮审查报过的写法变体；每个结论都由 Vitest 实际注册的结果决定，
 * 并与同一夹具真实运行（JSON reporter）得到的用例与状态逐条比对。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = 'tests/tooling/fixtures/ac-coverage';
const VITEST_BIN = join(ROOT, 'node_modules/vitest/vitest.mjs');
const TIMEOUT = 180_000;

type Mode = 'run' | 'skip' | 'todo' | 'only';
interface ReportTest {
  file: string;
  names: string[];
  modes: Partial<Record<string, Mode>>;
  ids: string[];
}
interface ReportEntry {
  id: string;
  runtimeStatus: string;
  status: string;
  category?: string;
  conditional: string[];
  conditionalTests: number;
  tests: number;
  skippedOrTodo: number;
  mapped: number;
}
interface Report {
  stages: string[];
  tests: ReportTest[];
  groups: { name: string; ids: string[] }[];
  entries: Record<string, ReportEntry>;
  summary: Record<string, number>;
  unknownReferences: { id: string }[];
  ignoredReferences: { id: string }[];
  duplicateDefinitions: { id: string }[];
  problems: { kind: string; message: string }[];
  gaps: string[];
  ok: boolean;
}

/** 子进程环境：去掉外层 Vitest 与真 PG 的变量，避免影响夹具的两档收集。 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST') || key === 'TEST_DATABASE_URL' || key === 'AC_FIXTURE_PG') delete env[key];
  }
  return { ...env, ...extra };
}

function runTool(args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/ac-coverage.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function toolJson(dir: string, stage: string): Report {
  const result = runTool(['--config-dir', `${FIXTURES}/${dir}`, '--stage', stage, '--format', 'json']);
  if (result.status !== 0) throw new Error(`工具退出码 ${result.status}：${result.stderr}`);
  return JSON.parse(result.stdout) as Report;
}

/** 真值：真实运行夹具，取 JSON reporter 里每个用例的标题层级与状态。 */
function vitestTruth(dir: string, env: Record<string, string>, out: string): string[] {
  const outputFile = join(out, `${dir}-${Object.keys(env).length}.json`);
  const config = `${FIXTURES}/${dir}/vitest.fixture.config.mjs`;
  spawnSync(
    process.execPath,
    [VITEST_BIN, 'run', '--config', config, '--reporter=json', `--outputFile=${outputFile}`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: cleanEnv(env),
    },
  );
  const json = JSON.parse(readFileSync(outputFile, 'utf8')) as {
    testResults: { name: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[];
  };
  const mode: Record<string, Mode> = { passed: 'run', failed: 'run', skipped: 'skip', pending: 'skip', todo: 'todo' };
  return json.testResults
    .flatMap((file) =>
      file.assertionResults.map((test) => {
        const names = [...test.ancestorTitles, test.title];
        return `${basename(file.name)}|${JSON.stringify(names)}|${mode[test.status] ?? test.status}`;
      }),
    )
    .sort();
}

/** 工具在某一档的结果：只取该档注册了的用例（只在另一档注册的不计入）。 */
function toolTests(report: Report, profile: string): string[] {
  return report.tests
    .filter((t) => t.modes[profile] !== undefined)
    .map((t) => `${basename(t.file)}|${JSON.stringify(t.names)}|${t.modes[profile]}`)
    .sort();
}

const ids = (...nums: (string | number)[]) =>
  nums.map((n) => (typeof n === 'string' ? n : `AC-DEMO-${String(n).padStart(2, '0')}`));

describe('F-030 AC 覆盖运行时采集：写法变体（夹具 variants）', () => {
  let report: Report;
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-coverage-'));
    report = toolJson('variants', 'DEMO');
  }, TIMEOUT);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const statusOf = (id: string) => report.entries[id]?.status;
  const expectStatus = (status: string, list: string[]) => {
    expect(Object.fromEntries(list.map((id) => [id, statusOf(id)]))).toEqual(
      Object.fromEntries(list.map((id) => [id, status])),
    );
  };

  it(
    '收集到的用例与状态与真实运行逐条一致（PGlite 档、PG 档）',
    () => {
      expect(toolTests(report, 'pglite')).toEqual(vitestTruth('variants', {}, tmp));
      expect(toolTests(report, 'pg')).toEqual(vitestTruth('variants', { AC_FIXTURE_PG: '1' }, tmp));
    },
    TIMEOUT,
  );

  it('标题格式化：%s / $ac / $0 / %# / %$ / $a.b / AC-%s-%s 按真实标题计，%d / %i 得 NaN、截断、跨行不合成', () => {
    expectStatus('已覆盖', ids(1, 3, 4, 6, 10, 11, 12, 14, 101));
    expectStatus('未覆盖', ids(2, 5, 7, 8, 13, 15));
  });

  it('describe.each / describe.for / 嵌套 describe 的编号覆盖其下用例；describe.todo、skip 选项、describe.skip 只算 skip / todo', () => {
    expectStatus('已覆盖', ids(20, 21, 22, 23));
    expectStatus('仅 skip / todo', ids(24, 25, 26));
    expect(report.entries['AC-DEMO-24']?.runtimeStatus).toBe('仅 skip / todo');
  });

  it('it.concurrent、别名、concurrent.each、test.describe、test.suite、对象属性、动态 import、回调注册都按实际注册计', () => {
    expectStatus('已覆盖', ids(30, 31, 32, 33, 34, 35, 36, 37));
    expectStatus('仅 skip / todo', ids(38));
  });

  it('skip / todo 各种写法不计覆盖；同一编号另有运行用例时计覆盖', () => {
    expectStatus('仅 skip / todo', ids(40, 41, 42, 43, 44, 45));
    expectStatus('已覆盖', ids(46));
  });

  it('空 each 表、空 describe.each、从未执行的回调不注册用例，判未覆盖', () => {
    expectStatus('未覆盖', ids(50, 51, 52, 53));
    expect(report.tests.some((t) => t.names.includes('empty 控制用例'))).toBe(true);
  });

  it('循环、函数返回的表、展开、拼接、带标签模板表生成的用例都计入', () => {
    expectStatus('已覆盖', ids(60, 61, 62, 63, 64, 65, 66));
  });

  it('被修改的常量表、对象覆盖、getter、原型属性、undefined 遮蔽按运行时最终值计', () => {
    expectStatus('已覆盖', ids(71, 73, 74, 76, 78, 80, 82, 84, 85, 86, 88));
    expectStatus('未覆盖', ids(70, 72, 75, 77, 79, 81, 83, 87));
  });

  it('区间与斜杠简写展开、数字开头的模块', () => {
    expectStatus('已覆盖', ids(102, 103, 104, 105, 107, 108, 109, 'AC-360-01'));
    expectStatus('未覆盖', ids(106));
  });

  it('条件执行：只在一档运行的用例计覆盖并标出所在档；部分用例条件执行时计数', () => {
    expectStatus('已覆盖', ids(90, 91, 92));
    expect(report.entries['AC-DEMO-90']?.conditional).toEqual(['pg']);
    expect(report.entries['AC-DEMO-91']?.conditional).toEqual(['pglite']);
    expect(report.entries['AC-DEMO-92']).toMatchObject({ conditional: [], conditionalTests: 1, tests: 2 });
  });

  it('多层 skip / todo：任一祖先 suite 为 skip / todo 时用例不执行，不计覆盖（P2-1）', () => {
    expectStatus('仅 skip / todo', ids(110, 111, 112, 113, 114));
    expectStatus('已覆盖', ids(115));
    const nested = report.tests.filter((t) => t.ids.some((id) => ids(110, 111, 112, 113).includes(id)));
    expect(nested.map((t) => t.modes)).toEqual(Array(4).fill({ pglite: 'skip', pg: 'skip' }));
  });

  it('跨档按注册位置配对：只在一档注册的同名用例不与另一档错配（P2-2）', () => {
    expect(report.entries['AC-DEMO-116']).toMatchObject({
      status: '已覆盖',
      tests: 1,
      skippedOrTodo: 1,
      conditional: [],
      conditionalTests: 0,
    });
    expect(report.entries['AC-DEMO-117']).toMatchObject({
      status: '已覆盖',
      tests: 1,
      skippedOrTodo: 1,
      conditional: ['pg'],
      conditionalTests: 1,
    });
    const same = report.tests.filter((t) => t.names[0] === 'AC-DEMO-116 同名用例').map((t) => t.modes);
    expect(same).toEqual(expect.arrayContaining([{ pg: 'skip' }, { pglite: 'run', pg: 'run' }]));
    expect(same).toHaveLength(2);
  });

  it('人工层：备注改状态、人工映射校验用例存在，映射失效列为问题', () => {
    expect(report.entries['AC-DEMO-93']).toMatchObject({
      runtimeStatus: '未覆盖',
      status: '未覆盖',
      category: '已有 DEC',
    });
    expect(report.entries['AC-DEMO-95']).toMatchObject({ runtimeStatus: '未覆盖', status: '已覆盖', mapped: 1 });
    expect(report.entries['AC-DEMO-96']).toMatchObject({ status: '未覆盖', mapped: 0 });
    const evidence = report.problems.filter((p) => p.kind === 'evidence').map((p) => p.message);
    expect(evidence).toHaveLength(3);
    expect(evidence.find((m) => m.includes('AC-DEMO-96'))).toContain('找不到');
  });

  it('人工映射按完整标题层级精确匹配；拼接后相同、末级同名都不能替代（P2-4）', () => {
    expect(report.entries['AC-DEMO-118']).toMatchObject({ status: '未覆盖', mapped: 0 });
    expect(report.entries['AC-DEMO-119']).toMatchObject({ status: '未覆盖', mapped: 0 });
    expect(report.entries['AC-DEMO-120']).toMatchObject({ status: '已覆盖', mapped: 1 });
    const evidence = report.problems.filter((p) => p.kind === 'evidence').map((p) => p.message);
    expect(evidence.find((m) => m.includes('AC-DEMO-118'))).toContain('未运行');
    expect(evidence.find((m) => m.includes('AC-DEMO-119'))).toContain('命中 2 个');
  });

  it('标题里的逆序区间列为问题，不静默只取端点（P2-3）', () => {
    const titles = report.problems.filter((p) => p.kind === 'title').map((p) => p.message);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain('AC-DEMO-104~102');
    expect(report.problems.map((p) => p.kind).sort()).toEqual(['evidence', 'evidence', 'evidence', 'title']);
  });

  it('范围内未定义、测试引用但未定义、已登记的非业务编号、重复定义分别列出', () => {
    expect(statusOf('AC-DEMO-98')).toBe('未定义');
    expect(report.unknownReferences.map((r) => r.id)).toEqual(['AC-DEMO-072', 'AC-DEMO-99']);
    expect(report.ignoredReferences.map((r) => r.id)).toEqual(['AC-DEMO-97']);
    expect(report.duplicateDefinitions.map((d) => d.id)).toEqual(['AC-DEMO-01']);
  });

  it('缺口 = 范围内无人工备注的未覆盖 / 仅 skip 或 todo / 未定义；有备注的不算', () => {
    const expected = ids(2, 5, 7, 8, 13, 15, 24, 25, 26, 38, 40, 41, 42, 43, 44, 45, 50, 51, 52, 53);
    expected.push(...ids(70, 72, 75, 77, 79, 81, 83, 87, 94, 96, 98, 106, 110, 111, 112, 113, 114, 118, 119));
    expect([...report.gaps].sort()).toEqual(expected.sort());
    expect(report.gaps).not.toContain('AC-DEMO-93');
    expect(report.ok).toBe(false);
  });

  it('汇总计数与逐条状态一致', () => {
    const counted: Record<string, number> = {};
    for (const entry of Object.values(report.entries)) counted[entry.status] = (counted[entry.status] ?? 0) + 1;
    expect(report.summary).toMatchObject({ ...counted, total: Object.keys(report.entries).length });
  });
});

describe('F-030 AC 覆盖运行时采集：命令行', () => {
  it(
    '--check：有缺口、未定义引用或问题时退出码 1，并在输出中说明',
    () => {
      const result = runTool(['--config-dir', `${FIXTURES}/variants`, '--stage', 'DEMO', '--check']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('AC-DEMO-94');
      expect(result.stderr).toContain('AC-DEMO-99');
      expect(result.stdout).toContain('| AC-DEMO-90 |');
    },
    TIMEOUT,
  );

  it(
    '--check：没有缺口与问题时退出码 0（有备注的未覆盖放行）',
    () => {
      const result = runTool(['--config-dir', `${FIXTURES}/clean`, '--stage', 'CLEAN', '--check']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const report = toolJson('clean', 'CLEAN');
      expect(report.summary).toMatchObject({ total: 2, 已覆盖: 1, 未覆盖: 1 });
      expect(report.ok).toBe(true);
    },
    TIMEOUT,
  );

  it(
    '--stage 只统计该阶段范围；all 合并各阶段；未知阶段报错',
    () => {
      const other = toolJson('variants', 'OTHER');
      expect(Object.keys(other.entries)).toEqual(['AC-DEMO-01', 'AC-DEMO-02']);
      expect(other.groups.map((g) => g.name)).toEqual(['另一阶段']);
      const all = toolJson('variants', 'all');
      expect(all.stages).toEqual(['DEMO', 'OTHER', 'REVERSE']);
      expect(all.groups.map((g) => g.name)).toEqual([
        'DEMO · 变体',
        'DEMO · 数字模块',
        'OTHER · 另一阶段',
        'REVERSE · 逆序',
      ]);
      const missing = runTool(['--config-dir', `${FIXTURES}/variants`, '--stage', 'R9']);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('R9');
    },
    TIMEOUT,
  );

  it(
    '配置里的逆序区间报配置错误，--check 失败，不静默缩小范围（P2-3）',
    () => {
      const report = toolJson('variants', 'REVERSE');
      expect(report.problems.filter((p) => p.kind === 'config').map((p) => p.message)).toEqual([
        expect.stringContaining('AC-DEMO-04~01'),
      ]);
      expect(report.summary.total).toBe(0);
      expect(report.ok).toBe(false);
      const result = runTool(['--config-dir', `${FIXTURES}/variants`, '--stage', 'REVERSE', '--check']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('AC-DEMO-04~01');
    },
    TIMEOUT,
  );

  it(
    '收集错误、.only、备注不在范围内或缺分类都列为问题',
    () => {
      const report = toolJson('problems', 'PROBLEMS');
      expect(report.problems.map((p) => p.kind).sort()).toEqual(['collect', 'note', 'note', 'only']);
      expect(report.ok).toBe(false);
    },
    TIMEOUT,
  );

  it(
    '--out 写出 <阶段>.json 与 <阶段>.md',
    () => {
      const out = mkdtempSync(join(tmpdir(), 'ac-coverage-out-'));
      try {
        const result = runTool(['--config-dir', `${FIXTURES}/clean`, '--stage', 'CLEAN', '--out', out]);
        expect(result.status).toBe(0);
        const json = JSON.parse(readFileSync(join(out, 'CLEAN.json'), 'utf8')) as Report;
        expect(json.summary.total).toBe(2);
        const markdown = readFileSync(join(out, 'CLEAN.md'), 'utf8');
        expect(markdown).toContain('| AC-DEMO-01 | 已覆盖 | 已覆盖 |');
        expect(markdown).toContain('| **合计** | **2** |');
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
