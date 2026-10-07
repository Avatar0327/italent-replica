/**
 * F-030（DEC-254 / DEC-282）：AC 覆盖统计改为 Vitest 运行时采集。
 * 夹具覆盖 #91 第 4、5 轮与 #102 各轮审查报过的写法变体；每个结论都由 Vitest 实际注册的结果决定，
 * 并与同一夹具真实运行（JSON reporter，allowOnly: false）得到的用例与状态、以及用例体写下的执行 marker 逐条比对。
 * DEC-282 补充（第 4 轮）：身份无法确认的注册不计入覆盖，只在 identity 问题里逐条列出；比对真值时两者合起来算。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  project: string;
  names: string[];
  location: string | null;
  ancestors: string[];
  modes: Partial<Record<string, Mode>>;
  only: boolean;
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
/** identity 问题里列出的一条注册（不计入覆盖）。 */
interface Registration {
  profile: string;
  project: string;
  file: string;
  names: string[];
  location: string | null;
  ancestors: (string | null)[];
  mode: Mode;
}
interface Problem {
  kind: string;
  message: string;
  registrations?: Registration[];
}
interface Report {
  stages: string[];
  profiles: Record<string, Record<string, unknown>>;
  tests: ReportTest[];
  groups: { name: string; ids: string[] }[];
  entries: Record<string, ReportEntry>;
  summary: Record<string, number>;
  unknownReferences: { id: string }[];
  ignoredReferences: { id: string }[];
  duplicateDefinitions: { id: string }[];
  problems: Problem[];
  gaps: string[];
  ok: boolean;
}

/** 子进程环境：去掉外层 Vitest 与真 PG 的变量，避免影响夹具的两档收集。 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST') || key.startsWith('AC_') || key === 'TEST_DATABASE_URL') delete env[key];
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

interface Truth {
  /** 真实运行的退出码 */
  status: number | null;
  /** 真实运行中整个文件失败（含收集失败）的夹具文件 */
  failedFiles: string[];
  /** 每个用例：文件|标题层级|状态（run / skip / todo） */
  tests: string[];
  /** 用例体实际执行时写下的 marker，按夹具文件归组 */
  markers: Record<string, string[]>;
}

const TRUTH_MODE: Record<string, Mode> = {
  passed: 'run',
  failed: 'run',
  skipped: 'skip',
  pending: 'skip',
  todo: 'todo',
};

/**
 * 真值：按与工具相同的 allowOnly: false 真实运行夹具，取 JSON reporter 里每个用例的标题层级与状态，
 * 并收集用例体写下的执行 marker。被 Vitest 以“Unexpected .only”拒绝的用例从未执行，记为 skip。
 */
function vitestTruth(dir: string, env: Record<string, string>, out: string, label: string): Truth {
  const outputFile = join(out, `${dir}-${label}.json`);
  const markerFile = join(out, `${dir}-${label}.markers`);
  const config = `${FIXTURES}/${dir}/vitest.fixture.config.mjs`;
  const args = [
    VITEST_BIN,
    'run',
    '--config',
    config,
    '--reporter=json',
    `--outputFile=${outputFile}`,
    '--allowOnly=false',
  ];
  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv({ ...env, AC_MARKER_FILE: markerFile }),
  });
  const json = JSON.parse(readFileSync(outputFile, 'utf8')) as {
    testResults: {
      name: string;
      status: string;
      assertionResults: { ancestorTitles: string[]; title: string; status: string; failureMessages: string[] }[];
    }[];
  };
  const tests = json.testResults.flatMap((file) =>
    file.assertionResults.map((test) => {
      const names = [...test.ancestorTitles, test.title];
      const rejectedOnly = test.failureMessages.some((m) => m.includes('Unexpected .only'));
      const mode = rejectedOnly ? 'skip' : (TRUTH_MODE[test.status] ?? test.status);
      return `${basename(file.name)}|${JSON.stringify(names)}|${mode}`;
    }),
  );
  const markers: Record<string, string[]> = {};
  const lines = existsSync(markerFile) ? readFileSync(markerFile, 'utf8').split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const [file, value] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
    (markers[file] ??= []).push(value);
  }
  const failedFiles = json.testResults.filter((file) => file.status === 'failed').map((file) => basename(file.name));
  return { status: run.status, failedFiles: failedFiles.sort(), tests: tests.sort(), markers };
}

/**
 * 工具看到的全部注册，逐档展开：计入覆盖的用例（report.tests）加上身份无法确认、只在 identity 问题里列出的注册。
 * counted 标出是否计入覆盖。
 */
function registrationsOf(report: Report): (Registration & { counted: boolean })[] {
  const counted = report.tests.flatMap((t) =>
    Object.entries(t.modes).map(([profile, mode]) => ({ ...t, profile, mode: mode as Mode, counted: true })),
  );
  const listed = report.problems.flatMap((p) => (p.registrations ?? []).map((r) => ({ ...r, counted: false })));
  return [...counted, ...listed];
}

/** 工具在某一档的结果（含不计入覆盖的注册），与真实运行逐条比对。 */
function toolTests(report: Report, profile: string): string[] {
  return registrationsOf(report)
    .filter((r) => r.profile === profile)
    .map((r) => `${basename(r.file)}|${JSON.stringify(r.names)}|${r.mode}`)
    .sort();
}

/** 某个夹具文件的 identity 问题。 */
const identityOf = (report: Report, file: string) =>
  report.problems.filter((p) => p.kind === 'identity' && p.message.includes(file));

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
      expect(toolTests(report, 'pglite')).toEqual(vitestTruth('variants', {}, tmp, 'pglite').tests);
      expect(toolTests(report, 'pg')).toEqual(vitestTruth('variants', { AC_FIXTURE_PG: '1' }, tmp, 'pg').tests);
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

  it('只在一档注册的同名用例不与另一档错配：报“各档对不上”并列出该注册，不计入覆盖（DEC-282 补充）', () => {
    // AC-DEMO-116：两档都注册的那条照常合并计覆盖；只在 PG 档注册的 skip 不计入
    expect(report.entries['AC-DEMO-116']).toMatchObject({
      status: '已覆盖',
      tests: 1,
      skippedOrTodo: 0,
      conditional: [],
      conditionalTests: 0,
    });
    // AC-DEMO-117：只在 PG 档注册的那条运行用例不计入，剩下两档都 skip 的那条
    expect(report.entries['AC-DEMO-117']).toMatchObject({ status: '仅 skip / todo', tests: 0, skippedOrTodo: 1 });
    const counted = (title: string) => report.tests.filter((t) => t.names[0] === title).map((t) => t.modes);
    expect(counted('AC-DEMO-116 同名用例')).toEqual([{ pglite: 'run', pg: 'run' }]);
    expect(counted('AC-DEMO-117 反向同名')).toEqual([{ pglite: 'skip', pg: 'skip' }]);
    const identity = report.problems.filter((p) => p.kind === 'identity');
    expect(identity.map((p) => p.message)).toEqual([
      expect.stringContaining('AC-DEMO-116'),
      expect.stringContaining('AC-DEMO-117'),
    ]);
    expect(identity.every((p) => p.message.includes('对不上'))).toBe(true);
    expect(identity.map((p) => p.registrations?.map((r) => [r.profile, r.mode]))).toEqual([
      [['pg', 'skip']],
      [['pg', 'run']],
    ]);
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
    const kinds = report.problems.map((p) => p.kind).sort();
    expect(kinds).toEqual(['evidence', 'evidence', 'evidence', 'identity', 'identity', 'title']);
  });

  it('范围内未定义、测试引用但未定义、已登记的非业务编号、重复定义分别列出', () => {
    expect(statusOf('AC-DEMO-98')).toBe('未定义');
    expect(report.unknownReferences.map((r) => r.id)).toEqual(['AC-DEMO-072', 'AC-DEMO-99']);
    expect(report.ignoredReferences.map((r) => r.id)).toEqual(['AC-DEMO-97']);
    expect(report.duplicateDefinitions.map((d) => d.id)).toEqual(['AC-DEMO-01']);
  });

  it('缺口 = 范围内无人工备注的未覆盖 / 仅 skip 或 todo / 未定义；有备注的不算', () => {
    const expected = ids(2, 5, 7, 8, 13, 15, 24, 25, 26, 38, 40, 41, 42, 43, 44, 45, 50, 51, 52, 53);
    expected.push(...ids(70, 72, 75, 77, 79, 81, 83, 87, 94, 96, 98, 106, 110, 111, 112, 113, 114, 117, 118, 119));
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
    '配置里的逆序区间、匹配不到定义的模块通配报配置错误，--check 失败，不静默缩小范围（P2-3）',
    () => {
      const report = toolJson('variants', 'REVERSE');
      expect(report.problems.filter((p) => p.kind === 'config').map((p) => p.message)).toEqual([
        expect.stringContaining('AC-DEMO-04~01'),
        expect.stringContaining('AC-NOPE-*'),
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
    '收集错误、生效的 .only（Vitest 拒绝，原样报收集错误）、备注不在范围内或缺分类都列为问题',
    () => {
      const report = toolJson('problems', 'PROBLEMS');
      expect(report.problems.map((p) => p.kind).sort()).toEqual(['collect', 'collect', 'note', 'note']);
      const collect = report.problems.filter((p) => p.kind === 'collect').map((p) => p.message);
      expect(collect.find((m) => m.includes('throws.fixture.js'))).toContain('夹具：收集失败');
      // DEC-282 补充：不按报错文本分辨 only，Vitest 的拒绝原样报出（带用例标题与位置）
      expect(collect.find((m) => m.includes('only.fixture.js'))).toContain('AC-DEMO-01 只跑这条');
      expect(collect.find((m) => m.includes('only.fixture.js'))).toContain('Unexpected .only');
      expect(report.ok).toBe(false);
    },
    TIMEOUT,
  );

  it(
    '--save-collected / --from-collected：同一格式版本可复用；旧格式或版本不符时拒绝并提示重新采集（第 3 轮 P3）',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ac-collected-'));
      const args = ['--config-dir', `${FIXTURES}/clean`, '--stage', 'CLEAN', '--format', 'json'];
      try {
        const saved = join(dir, 'collected.json');
        const first = runTool([...args, '--save-collected', saved]);
        expect(first.status).toBe(0);
        const data = JSON.parse(readFileSync(saved, 'utf8')) as Record<string, unknown>;
        expect(Number.isInteger(data.formatVersion)).toBe(true);
        const reused = runTool([...args, '--from-collected', saved]);
        expect(reused.status).toBe(0);
        expect(JSON.parse(reused.stdout)).toEqual(JSON.parse(first.stdout));
        // 旧格式缓存：没有版本号，问题记在旧的 pairing 字段里；不能被当成“没有问题”放行
        const legacy = join(dir, 'legacy.json');
        const { formatVersion: _version, identity: _identity, ...rest } = data;
        writeFileSync(legacy, JSON.stringify({ ...rest, pairing: [{ file: 'x.fixture.js', message: '旧配对问题' }] }));
        const old = runTool([...args, '--check', '--from-collected', legacy]);
        expect(old.status).toBe(2);
        expect(old.stderr).toContain('格式版本');
        expect(old.stderr).toContain('重新采集');
        writeFileSync(legacy, JSON.stringify({ ...data, formatVersion: Number(data.formatVersion) + 1 }));
        expect(runTool([...args, '--from-collected', legacy]).status).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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

const TWO_PROFILES: Record<string, Record<string, string>> = { pglite: {}, pg: { AC_FIXTURE_PG: '1' } };

/** 夹具源码里带标记注释那一行的行号（1 起），用于核对工具记录的注册位置。 */
const lineOf = (dir: string, file: string, tag: string) =>
  readFileSync(join(ROOT, FIXTURES, dir, file), 'utf8')
    .split('\n')
    .findIndex((line) => line.includes(tag)) + 1;

describe('F-030 AC 覆盖运行时采集：跨档用例身份（夹具 identity，DEC-282 ①）', () => {
  let report: Report;
  let tmp: string;
  const truth: Record<string, Truth> = {};

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-identity-'));
    report = toolJson('identity', 'IDENT');
    for (const [profile, env] of Object.entries(TWO_PROFILES))
      truth[profile] = vitestTruth('identity', env, tmp, profile);
  }, TIMEOUT);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const recordsOf = (file: string) => report.tests.filter((t) => basename(t.file) === file);
  const registrations = (file: string) => registrationsOf(report).filter((r) => basename(r.file) === file);
  const identityProblems = (file: string) => identityOf(report, file).map((p) => p.message);
  const runCount = (file: string, profile: string) =>
    registrations(file).filter((r) => r.profile === profile && r.mode === 'run').length;

  it('每档收集到的用例与状态与真实运行逐条一致', () => {
    for (const profile of Object.keys(TWO_PROFILES)) expect(toolTests(report, profile)).toEqual(truth[profile]?.tests);
  });

  it.each([
    'loop.fixture.js',
    'inline-helper.fixture.js',
    'describe-each.fixture.js',
    'describe-each-split.fixture.js',
    'each-constant.fixture.js',
    'imported-helper.fixture.js',
    'same-name-parents.fixture.js',
  ])(
    '同一档内身份相同的重复注册报“身份冲突”，逐条列出、不跨档合并、不计入覆盖；每档运行条数与执行 marker 一致：%s',
    (file) => {
      expect(identityProblems(file).some((m) => m.includes('身份冲突'))).toBe(true);
      expect(recordsOf(file)).toEqual([]);
      expect(registrations(file).every((r) => !r.counted)).toBe(true);
      for (const profile of Object.keys(TWO_PROFILES)) {
        expect(runCount(file, profile)).toBe(truth[profile]?.markers[file]?.length ?? 0);
      }
    },
  );

  it('夹具 17：各档实际运行的那条注册来自哪个父套件，与执行 marker 一致（A 只在 PGlite、B 只在 PG）', () => {
    const file = 'same-name-parents.fixture.js';
    const parentLine = (tag: string) => new RegExp(`^${lineOf('identity', file, tag)}:`);
    const ran = (profile: string) => registrations(file).find((r) => r.profile === profile && r.mode === 'run');
    expect(ran('pglite')?.ancestors[0]).toMatch(parentLine('@parent-A'));
    expect(ran('pg')?.ancestors[0]).toMatch(parentLine('@parent-B'));
    expect(truth.pglite?.markers[file]).toEqual(['A']);
    expect(truth.pg?.markers[file]).toEqual(['B']);
  });

  it('夹具 18：每档只有一个叶子但父套件注册位置不同，报“各档对不上”，两条注册逐条列出、不合并、不计入覆盖', () => {
    const file = 'parent-per-profile.fixture.js';
    expect(identityProblems(file).some((m) => m.includes('对不上'))).toBe(true);
    expect(recordsOf(file)).toEqual([]);
    const listed = registrations(file);
    expect(listed.map((r) => [r.profile, r.mode]).sort()).toEqual([
      ['pg', 'run'],
      ['pglite', 'run'],
    ]);
    expect(report.entries['AC-ID-18']).toMatchObject({ runtimeStatus: '未覆盖', tests: 0 });
    const parentOf = (profile: string) => listed.find((r) => r.profile === profile)?.ancestors[0];
    expect(parentOf('pglite')).toMatch(new RegExp(`^${lineOf('identity', file, '@pglite-parent')}:`));
    expect(parentOf('pg')).toMatch(new RegExp(`^${lineOf('identity', file, '@pg-parent')}:`));
    expect(truth.pglite?.markers[file]).toEqual(['pglite-parent']);
    expect(truth.pg?.markers[file]).toEqual(['pg-parent']);
  });

  it('身份稳定的用例照常跨档合并，状态与执行 marker 一致（含被导入 helper 在不同调用行注册，夹具 14）', () => {
    const file = 'stable.fixture.js';
    expect(identityProblems(file)).toEqual([]);
    const byTitle = (title: string) => recordsOf(file).filter((t) => t.names.at(-1) === title);
    expect(byTitle('AC-ID-20 仅真 PG').map((t) => t.modes)).toEqual([{ pglite: 'skip', pg: 'run' }]);
    expect(byTitle('AC-ID-21 两档都跑').map((t) => t.modes)).toEqual([{ pglite: 'run', pg: 'run' }]);
    const helper = byTitle('AC-ID-22 helper 同名用例');
    expect(helper.map((t) => t.modes)).toEqual([
      { pglite: 'run', pg: 'run' },
      { pglite: 'run', pg: 'run' },
    ]);
    const callLines = ['@call-first', '@call-second'].map((tag) => lineOf('identity', file, tag));
    expect(helper.map((t) => Number(t.location?.split(':')[0]))).toEqual(callLines);
    expect(truth.pglite?.markers[file]?.sort()).toEqual(['21', '22-first', '22-second']);
    expect(truth.pg?.markers[file]?.sort()).toEqual(['20', '21', '22-first', '22-second']);
    expect(report.entries['AC-ID-20']).toMatchObject({ status: '已覆盖', conditional: ['pg'] });
  });

  it(
    '--check：身份冲突、各档对不上时退出码 1',
    () => {
      const result = runTool(['--config-dir', `${FIXTURES}/identity`, '--stage', 'IDENT', '--check']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('身份冲突');
      expect(result.stderr).toContain('对不上');
    },
    TIMEOUT,
  );
});

describe('F-030 AC 覆盖运行时采集：三档同点同名换序（夹具 identity3，附录 C 夹具 12）', () => {
  it(
    '三档各自只运行排在第一的行：报身份冲突，逐条列出、不跨档合并、不计入覆盖；每档运行条数与执行 marker 一致',
    () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ac-identity3-'));
      try {
        const report = toolJson('identity3', 'IDENT3');
        const file = 'three-way.fixture.js';
        expect(report.problems.some((p) => p.kind === 'identity' && p.message.includes('身份冲突'))).toBe(true);
        expect(report.tests.filter((t) => basename(t.file) === file)).toEqual([]);
        const listed = registrationsOf(report).filter((r) => basename(r.file) === file);
        expect(listed.every((r) => !r.counted)).toBe(true);
        const expected: Record<string, string> = { a: 'A', b: 'B', c: 'C' };
        for (const [profile, row] of Object.entries(expected)) {
          const truth = vitestTruth('identity3', { AC_FIXTURE_PROFILE: profile }, tmp, profile);
          expect(toolTests(report, profile)).toEqual(truth.tests);
          expect(truth.markers[file]).toEqual([row]);
          expect(listed.filter((r) => r.profile === profile && r.mode === 'run')).toHaveLength(1);
        }
        expect(report.ok).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

const ONLY_FILES = Array.from({ length: 10 }, (_, i) => `o${String(i + 1).padStart(2, '0')}.fixture.js`);

describe('F-030 AC 覆盖运行时采集：.only 门禁（夹具 only，DEC-282 ②③）', () => {
  let report: Report;
  let tmp: string;
  const truth: Record<string, Truth> = {};

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-only-'));
    report = toolJson('only', 'ONLY');
    for (const [profile, env] of Object.entries(TWO_PROFILES)) truth[profile] = vitestTruth('only', env, tmp, profile);
  }, TIMEOUT);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('每档收集到的用例与状态与真实运行（allowOnly: false）逐条一致', () => {
    for (const profile of Object.keys(TWO_PROFILES)) expect(toolTests(report, profile)).toEqual(truth[profile]?.tests);
  });

  it.each(ONLY_FILES)('已注册的 only 一律报问题、--check 失败（含挂在 skip / todo 祖先下面的）：%s', (file) => {
    expect(report.problems.some((p) => ['only', 'collect'].includes(p.kind) && p.message.includes(file))).toBe(true);
  });

  it('DEC-282 补充：mode 仍为 only 的报 only；生效的 only 被 Vitest 拒绝，原样报收集错误，不按报错文本改判', () => {
    const kindsOf = (file: string) => [
      ...new Set(report.problems.filter((p) => p.message.includes(file)).map((p) => p.kind)),
    ];
    for (const file of ONLY_FILES.filter((f) => !['o09.fixture.js', 'o10.fixture.js'].includes(f))) {
      expect(kindsOf(file)).toEqual(['only']);
    }
    expect(kindsOf('o10.fixture.js')).toEqual(['collect']);
    const rejected = report.problems.find((p) => p.message.includes('o10.fixture.js'))?.message;
    expect(rejected).toContain('AC-ONLY-10');
    expect(rejected).toContain('Unexpected .only');
    // o09：PGlite 档外层被跳过、only 残留；PG 档 only 生效被拒绝
    const o09 = report.problems.filter((p) => p.message.includes('o09.fixture.js'));
    expect(o09.find((p) => p.kind === 'only')?.message).toMatch(/（档：pglite）/);
    expect(o09.find((p) => p.kind === 'collect')?.message).toMatch(/（档：pg）/);
  });

  it('人工改判不能放行 only：AC-ONLY-01 有合法的“未覆盖”改判，仍单独报 only 问题', () => {
    const only = report.problems.filter((p) => p.kind === 'only').map((p) => p.message);
    expect(only.some((m) => m.includes('AC-ONLY-01') && m.includes('人工改判'))).toBe(true);
    expect(report.gaps).not.toContain('AC-ONLY-01');
    expect(report.ok).toBe(false);
  });

  it('被跳过或被 Vitest 拒绝的 only 用例不计覆盖，用例体从未执行', () => {
    for (let n = 1; n <= 10; n++) {
      expect(report.entries[`AC-ONLY-${String(n).padStart(2, '0')}`]?.status).not.toBe('已覆盖');
    }
    expect(truth.pglite?.markers).toEqual({});
    expect(truth.pg?.markers).toEqual({});
  });

  it('收集统计只有整数计数，不出现 null 或 NaN', () => {
    for (const stats of Object.values(report.profiles)) {
      for (const value of Object.values(stats)) expect(Number.isInteger(value)).toBe(true);
    }
    expect(report.profiles.pglite).toMatchObject({ files: 10, run: 0 });
    expect(Number(report.profiles.pglite?.only)).toBeGreaterThan(0);
  });

  it(
    '--check：出现 only 时退出码 1',
    () => {
      const result = runTool(['--config-dir', `${FIXTURES}/only`, '--stage', 'ONLY', '--check']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('[only]');
    },
    TIMEOUT,
  );
});

describe('F-030 AC 覆盖运行时采集：多段编号（夹具 multiseg，DEC-291②）', () => {
  let report: Report;

  beforeAll(() => {
    report = toolJson('multiseg', 'MULTI');
  }, TIMEOUT);

  const idsOf = (title: string) => report.tests.find((t) => t.names.at(-1) === title)?.ids;
  const titleProblems = () => report.problems.filter((p) => p.kind === 'title').map((p) => p.message);

  it('多段单号、多段区间、与单段混写、数字开头的模块加多段都按完整编号提取', () => {
    expect(idsOf('AC-PRM-FW-01 多段单号')).toEqual(['AC-PRM-FW-01']);
    expect(idsOf('AC-PRM-FW-02～04 多段区间')).toEqual(['AC-PRM-FW-02', 'AC-PRM-FW-03', 'AC-PRM-FW-04']);
    expect(idsOf('AC-PRM-01～02 与 AC-PRM-FW-05 / 06 混写')).toEqual([
      'AC-PRM-01',
      'AC-PRM-02',
      'AC-PRM-FW-05',
      'AC-PRM-FW-06',
    ]);
    expect(idsOf('AC-360-FW-01 数字模块加多段')).toEqual(['AC-360-FW-01']);
  });

  it('统计按完整编号聚合：多段区间展开；AC-PRM-* 只含单段模块 PRM，不把 AC-PRM-FW-* 截成 AC-PRM 前缀', () => {
    const group = (name: string) => report.groups.find((g) => g.name === name)?.ids;
    const fw = Array.from({ length: 7 }, (_, i) => `AC-PRM-FW-0${i + 1}`);
    expect(group('多段区间')).toEqual(fw);
    expect(group('多段通配')).toEqual(fw);
    expect(group('单段通配')).toEqual(Array.from({ length: 7 }, (_, i) => `AC-PRM-0${i + 1}`));
    expect(group('数字模块多段')).toEqual(['AC-360-FW-01']);
    const covered = ['AC-PRM-FW-01', 'AC-PRM-FW-02', 'AC-PRM-FW-03', 'AC-PRM-FW-04', 'AC-PRM-FW-05', 'AC-PRM-FW-06'];
    for (const id of covered) expect(report.entries[id]?.status).toBe('已覆盖');
    expect(report.entries['AC-PRM-FW-07']?.status).toBe('未覆盖');
    expect(report.entries['AC-360-FW-01']?.status).toBe('已覆盖');
    expect(report.unknownReferences).toEqual([]);
  });

  it('非法写法报 title 问题、不吞掉；模块统称（AC-PRM）不算编号也不报错', () => {
    const problems = titleProblems();
    expect(problems).toHaveLength(4);
    for (const text of ['AC-PRM-FW-1', 'AC-PRM--03', 'AC-EMP-16-SUB-05', 'AC-PRM-03～AC-PRM-05']) {
      expect(problems.some((m) => m.includes(text))).toBe(true);
    }
    expect(problems.some((m) => m.includes('模块统称'))).toBe(false);
    expect(report.entries['AC-PRM-04']?.status).toBe('未覆盖');
    expect(report.ok).toBe(false);
  });

  it(
    '配置里的非法多段写法与匹配不到定义的多段通配报配置错误，--check 失败',
    () => {
      const bad = toolJson('multiseg', 'BAD');
      expect(bad.problems.filter((p) => p.kind === 'config').map((p) => p.message)).toEqual([
        expect.stringContaining('AC-PRM-FW-1'),
        expect.stringContaining('AC-PRM-FW-01～AC-PRM-FW-03'),
        expect.stringContaining('AC-NOPE-FW-*'),
      ]);
      const result = runTool(['--config-dir', `${FIXTURES}/multiseg`, '--stage', 'BAD', '--check']);
      expect(result.status).toBe(1);
    },
    TIMEOUT,
  );
});

/** 真实运行与工具结果按档逐条比对，并取每档的执行 marker（各 describe 的 beforeAll 共用）。 */
function collectTruth(dir: string, tmp: string, truth: Record<string, Truth>) {
  for (const [profile, env] of Object.entries(TWO_PROFILES)) truth[profile] = vitestTruth(dir, env, tmp, profile);
}

describe('F-030 AC 覆盖运行时采集：模块收集错误不被 only 判定吞掉（夹具 module-errors，第 3 轮 P2-1）', () => {
  let report: Report;
  let tmp: string;
  const truth: Record<string, Truth> = {};

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-module-errors-'));
    report = toolJson('module-errors', 'ERR');
    collectTruth('module-errors', tmp, truth);
  }, TIMEOUT);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const BROKEN = ['describe-only-text.fixture.js', 'top-level-only-text.fixture.js'];

  it('真实运行：两个抛错文件整体失败、Vitest 非零退出；正常文件的用例照常执行', () => {
    for (const profile of Object.keys(TWO_PROFILES)) {
      expect(truth[profile]?.status).not.toBe(0);
      expect(truth[profile]?.failedFiles).toEqual(BROKEN);
      expect(truth[profile]?.markers['covered.fixture.js']).toEqual(['01']);
      expect(toolTests(report, profile)).toEqual(truth[profile]?.tests);
    }
  });

  it('模块收集错误一律报 collect（消息含 “.only”、与 Vitest 拒绝 only 逐字相同的也不例外），不报 only', () => {
    expect(report.problems.map((p) => p.kind)).toEqual(['collect', 'collect']);
    const messageOf = (file: string) => report.problems.find((p) => p.message.includes(file))?.message;
    expect(messageOf('top-level-only-text.fixture.js')).toContain('configuration for .only failed');
    expect(messageOf('describe-only-text.fixture.js')).toContain('[Vitest] Unexpected .only modifier');
    for (const file of BROKEN) expect(messageOf(file)).toContain('档：pglite / pg');
    expect(report.entries['AC-ERR-01']).toMatchObject({ status: '已覆盖', tests: 1 });
    expect(report.gaps).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it(
    '--check：范围内全部覆盖、只有模块收集错误时也退出码 1',
    () => {
      const result = runTool(['--config-dir', `${FIXTURES}/module-errors`, '--stage', 'ERR', '--check']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('configuration for .only failed');
      for (const file of BROKEN) expect(result.stderr).toContain(file);
    },
    TIMEOUT,
  );
});

const UNKNOWN_FILES = [
  'u19-async-parent.fixture.js',
  'u22-async-parent-per-profile.fixture.js',
  'u29-async-leaf.fixture.js',
  'u31-async-middle.fixture.js',
];

describe('F-030 AC 覆盖运行时采集：注册位置未知（夹具 unknown-location，第 3 轮 P2-2）', () => {
  let report: Report;
  let tmp: string;
  const truth: Record<string, Truth> = {};

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-unknown-location-'));
    report = toolJson('unknown-location', 'UNKNOWN');
    collectTruth('unknown-location', tmp, truth);
  }, TIMEOUT);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const listed = (file: string) => identityOf(report, file).flatMap((p) => p.registrations ?? []);

  it('每档注册（计入覆盖的 + 身份无法确认而列出的）与真实运行逐条一致', () => {
    for (const profile of Object.keys(TWO_PROFILES)) expect(toolTests(report, profile)).toEqual(truth[profile]?.tests);
  });

  it.each(UNKNOWN_FILES)(
    '用例或任一祖先 suite 位置未知：报 identity、逐条列出各档注册，不合并、不计入覆盖：%s',
    (file) => {
      const problems = identityOf(report, file);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.message).toContain('位置未知');
      expect(
        listed(file)
          .map((r) => r.profile)
          .sort(),
      ).toEqual(['pg', 'pglite']);
      expect(report.tests.filter((t) => basename(t.file) === file)).toEqual([]);
    },
  );

  it('只由位置未知的注册覆盖的编号不计覆盖（两档真实都注册、PGlite 档真实运行也不算）', () => {
    for (const id of ['AC-UL-19', 'AC-UL-22', 'AC-UL-29', 'AC-UL-31']) {
      expect(report.entries[id]).toMatchObject({ runtimeStatus: '未覆盖', tests: 0, skippedOrTodo: 0 });
    }
    expect(truth.pglite?.markers['u19-async-parent.fixture.js']).toEqual(['19']);
    expect(truth.pglite?.markers['u29-async-leaf.fixture.js']).toEqual(['29']);
  });

  it('夹具 22 / 31：列出的注册与执行 marker 一致（PGlite 运行、PG 跳过），未知的祖先位置记为 null', () => {
    const outer = `${lineOf('unknown-location', 'u31-async-middle.fixture.js', '@outer')}:1`;
    const expected: [string, (string | null)[]][] = [
      ['u22-async-parent-per-profile.fixture.js', [null]],
      ['u31-async-middle.fixture.js', [outer, null]],
    ];
    for (const [file, ancestors] of expected) {
      expect(
        listed(file)
          .map((r) => [r.profile, r.mode])
          .sort(),
      ).toEqual([
        ['pg', 'skip'],
        ['pglite', 'run'],
      ]);
      for (const registration of listed(file)) expect(registration.ancestors).toEqual(ancestors);
      expect(truth.pglite?.markers[file]).toEqual(['pglite']);
      expect(truth.pg?.markers[file]).toBeUndefined();
    }
  });

  it('对照：顶层用例（祖先为空）与位置已知的父套件下的用例身份可确认，照常合并计覆盖', () => {
    expect(identityOf(report, 'control.fixture.js')).toEqual([]);
    const control = report.tests.filter((t) => basename(t.file) === 'control.fixture.js');
    expect(control.map((t) => [t.names.at(-1), t.ancestors.length, t.modes])).toEqual([
      ['AC-UL-01 顶层对照', 0, { pglite: 'run', pg: 'run' }],
      ['AC-UL-02 嵌套对照', 1, { pglite: 'run', pg: 'run' }],
    ]);
    expect(report.entries['AC-UL-01']?.status).toBe('已覆盖');
    expect(report.entries['AC-UL-02']?.status).toBe('已覆盖');
  });

  it(
    '--check：位置未知时退出码 1，并列出具体用例（文件、名称路径、档）',
    () => {
      const result = runTool(['--config-dir', `${FIXTURES}/unknown-location`, '--stage', 'UNKNOWN', '--check']);
      expect(result.status).toBe(1);
      for (const file of UNKNOWN_FILES) expect(result.stderr).toContain(file);
      expect(result.stderr).toContain('异步注册的中间层');
      expect(result.stderr).toContain('pglite 档');
    },
    TIMEOUT,
  );
});

describe('F-030 AC 覆盖运行时采集：多个 Vitest project 收集同一文件（夹具 projects，第 3 轮 P2-3）', () => {
  let report: Report;
  let tmp: string;
  const truth: Record<string, Truth> = {};
  const FILE = 'same-file.fixture.js';

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-projects-'));
    report = toolJson('projects', 'PROJECTS');
    collectTruth('projects', tmp, truth);
  }, TIMEOUT);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('每档注册与真实运行逐条一致：同一文件两个 project 各一条，第二条不丢', () => {
    for (const profile of Object.keys(TWO_PROFILES)) {
      expect(toolTests(report, profile)).toEqual(truth[profile]?.tests);
      expect(truth[profile]?.markers[FILE]?.sort()).toEqual(['33-A', '33-B', '34-A', '34-B']);
    }
  });

  it('同一档跨 project 的同名注册报 identity，逐条列出档与 project，不合并、不计入覆盖', () => {
    const problems = identityOf(report, FILE);
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem.message).toContain('跨 project');
      expect(problem.message).toContain('身份冲突');
      const where = problem.registrations?.map((r) => `${r.profile}/${r.project}/${r.mode}`).sort();
      expect(where).toEqual(['pg/A/run', 'pg/B/run', 'pglite/A/run', 'pglite/B/run']);
    }
    expect(report.tests.filter((t) => basename(t.file) === FILE)).toEqual([]);
    expect(report.entries['AC-PJ-33']).toMatchObject({ runtimeStatus: '未覆盖', tests: 0 });
    expect(report.entries['AC-PJ-34']).toMatchObject({ runtimeStatus: '未覆盖', tests: 0 });
  });

  it('对照：只属于一个 project 的文件照常统计，并记下所属 project', () => {
    expect(identityOf(report, 'only-a.fixture.js')).toEqual([]);
    const only = report.tests.filter((t) => basename(t.file) === 'only-a.fixture.js');
    expect(only.map((t) => [t.project, t.modes])).toEqual([['A', { pglite: 'run', pg: 'run' }]]);
    expect(report.entries['AC-PJ-01']).toMatchObject({ status: '已覆盖', tests: 1, conditional: [] });
  });

  it(
    '--check：跨 project 同名时退出码 1',
    () => {
      const result = runTool(['--config-dir', `${FIXTURES}/projects`, '--stage', 'PROJECTS', '--check']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('跨 project');
      expect(result.stderr).toContain(FILE);
    },
    TIMEOUT,
  );
});
