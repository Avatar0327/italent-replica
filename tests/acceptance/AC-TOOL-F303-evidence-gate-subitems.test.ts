/** AC-TOOL-F303：✅ 开头也逐子项检查；用合成文档运行真实 CLI，验证阻塞与定位。 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decisionSettled, evidenceState, gateReport, parseEvidence } from '../../scripts/evidence-gate-lib.mjs';

const TARGET = 'R9-T01';
const OTHER_TARGET = 'R9-T02';
const EVIDENCE_MD = 'docs/07_M0/03_需取证清单.md';
const DECISION_MD = 'docs/00_状态/04_缺口冲突差异登记册.md';
const SEPARATORS = ['；', ';', '，', ',', '。', '. ', '、', '<br>', '<br/>', '<br />'];
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const evidenceRow = (status: string, blocks = `${TARGET}（开工前）`) =>
  `| Q-M0-901 | 合成来源 | 合成取证内容 | 合成方法 | ${blocks} | ${status} |`;
const decisionRow = (status: string, scope = `影响任务：${TARGET}`) =>
  `| **D-901** | 合成行为 | 合成差异；${scope} | 合成方案 | ${status} |`;
// 第一条数据在第 6 行；夹入标题、空行与表头，避免把过滤后的数组下标当源文件行号。
const markdown = (rows: string[]) => ['# F-303 合成夹具', '', '| 表头 |', '| --- |', '', ...rows, ''].join('\n');

function runCli(evidence: string[], decisions: string[], targets = [TARGET]) {
  const root = mkdtempSync(path.join(tmpdir(), 'f303-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'docs/07_M0'), { recursive: true });
  mkdirSync(path.join(root, 'docs/00_状态'), { recursive: true });
  writeFileSync(path.join(root, EVIDENCE_MD), markdown(evidence));
  writeFileSync(path.join(root, DECISION_MD), markdown(decisions));
  const script = fileURLToPath(new URL('../../scripts/evidence-gate.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, ...targets], {
    encoding: 'utf8',
    env: { ...process.env, EVIDENCE_GATE_ROOT: `${root}/` },
    timeout: 10_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.stderr).toBe('');
  return { code: run.status, out: run.stdout };
}

function expectItem(out: string, file: string, line: number, id: string, item: string) {
  expect(out.split('\n')).toContain(`    ${file}:${line}  ${id}  待决子项：${item}`);
}

const sources = [
  { name: '取证清单', file: EVIDENCE_MD, id: 'Q-M0-901', run: (status: string) => runCli([evidenceRow(status)], []) },
  { name: '差异登记册', file: DECISION_MD, id: 'D-901', run: (status: string) => runCli([], [decisionRow(status)]) },
];

describe.each(sources)('AC-TOOL-F303 $name：✅ 子项门禁', ({ file, id, run }) => {
  it.each(['待原站实测', '待实测', '待取证', '待定', '待用户决定', '待确认', '待复核'])(
    '✅ 已取证；②%s：退出 1，并指出文件、原始行号和子项',
    (pending) => {
      const { code, out } = run(`✅ 已取证；②${pending}`);
      expect(code).toBe(1);
      expectItem(out, file, 6, id, `②${pending}`);
    },
  );

  it.each([...SEPARATORS, ''])('分隔符 %j：逐项输出多个待决项，后面的完成标记不能覆盖前面的待决项', (separator) => {
    const pending = '②待原站实测';
    const undecided = '③待定';
    const status = ['✅ ①已取证', pending, undecided, '④✅ 已完成'].join(separator);
    const { code, out } = run(status);
    expect(code).toBe(1);
    expectItem(out, file, 6, id, pending);
    expectItem(out, file, 6, id, undecided);
    const details = out.split('\n').filter((line) => line.includes(`${file}:6`));
    expect(details).toHaveLength(2);
    expect(details.every((line) => !line.includes('已完成') && !line.includes('已取证'))).toBe(true);
  });

  it.each(SEPARATORS)('没有圈号时仍按 %j 分隔，并只报告待决子项', (separator) => {
    const { code, out } = run(['✅ 已取证', '待实测', '待定', '已完成'].join(separator));
    expect(code).toBe(1);
    expectItem(out, file, 6, id, '待实测');
    expectItem(out, file, 6, id, '待定');
    const details = out.split('\n').filter((line) => line.includes(`${file}:6`));
    expect(details).toHaveLength(2);
    expect(details.every((line) => !line.includes('已完成') && !line.includes('已取证'))).toBe(true);
  });

  it.each([
    ['首子项待决', '✅ 待取证；②已完成', '✅ 待取证'],
    ['括号内待决', '✅ 已取证（①已完成；②待原站实测）', '✅ 已取证（①已完成；②待原站实测）'],
    ['首部空白', '  ✅ 已取证；②待原站实测', '②待原站实测'],
    ['词间空白', '✅ 已取证；②待 原站 实测', '②待 原站 实测'],
    ['后补声明', '✅ 已取证；剩余可后补；②待取证', '②待取证'],
    ['长子项', `✅ 已取证；②${'合成检查内容'.repeat(15)}待原站实测`, `②${'合成检查内容'.repeat(15)}待原站实测`],
  ])('%s：待决文本完整保留', (_name, status, item) => {
    const { code, out } = run(status);
    expect(code).toBe(1);
    expectItem(out, file, 6, id, item);
  });

  it.each([
    '✅',
    '  ✅ 已确认',
    '✅ ①已取证；②已实测；③已定（DEC-901）',
    '✅ ①已取证;②已实测,③已定（DEC-901）',
    '✅ ①已取证，②已实测。③已定（DEC-901）',
    '✅ ①已取证. ②已实测<br />③已定（DEC-901）',
    '✅ 已取证（待办按评价者去重）；②已确认待入职字段',
    '✅ 已取证（入口(字段,回执)；错误提示）；②已完成',
    '✅ 已取证(入口（字段、回执）;错误提示)；②已完成',
    '✅ 已取证（入口、字段；②已完成',
    '✅ 已取证)；②已完成',
  ])('完成状态 %s：退出 0，不列为待决', (status) => {
    const { code, out } = run(status);
    expect(code).toBe(0);
    expect(out).not.toContain(id);
    expect(out).not.toContain(`${file}:`);
  });
});

describe.each(sources)('AC-TOOL-F303 $name：括号子项原文（P2-1）', ({ file, id, run }) => {
  function expectDetails(status: string, items: string[]) {
    const { code, out } = run(status);
    expect(code).toBe(1);
    expect(out.split('\n').filter((line) => line.includes('待决子项：'))).toEqual(
      items.map((item) => `    ${file}:6  ${id}  待决子项：${item}`),
    );
  }

  describe.each([
    ['中文', '（', '）'],
    ['英文', '(', ')'],
  ])('%s括号', (_name, open, close) => {
    it.each(SEPARATORS)('内部 %j 不切断原文，闭合后仍分别报告外部待决项', (separator) => {
      const item = `②待实测${open}${['入口', '字段', '错误提示'].join(separator)}${close}`;
      expectDetails(`✅ 已取证；${item}；③待定；④已完成`, [item, '③待定']);
    });
  });

  it.each([
    '②待实测（入口(字段, 错误提示；提示)、回执）',
    '②已取证(入口（字段、②待原站实测；③已完成）, 提示)',
    '②已取证（入口（字段、待实测）；回执）',
    '②已取证(入口(字段,待取证);回执)',
  ])('嵌套括号保留完整子项 %s，内部待决仍阻塞', (item) => {
    expectDetails(`✅ 已取证；${item}；③待定；④已完成`, [item, '③待定']);
  });

  it.each([
    '②待实测（入口、字段；③已完成',
    '②已取证(入口,字段;③待取证',
    '②待实测（入口(字段,错误提示)；③已完成',
    '②待实测（入口,字段)；③已完成',
    '②待实测(入口，字段）；③已完成',
    '②待实测（入口(字段）；③待定)；④已完成',
  ])('未闭合或错配括号保守保留到状态末尾：%s', (item) => {
    expectDetails(`✅ 已取证；${item}`, [item]);
  });

  it.each(['）', ')'])('孤立右括号 %s 保留原文，不影响后续分项', (close) => {
    const item = '②待实测（入口、字段）';
    const last = `③待定${close}`;
    expectDetails(`✅ 已取证${close}；${item}；${last}`, [item, last]);
  });
});

describe('AC-TOOL-F303 范围与兼容', () => {
  const pending = '✅ 已取证；②待原站实测';

  it('共享状态判定入口同样识别待决，不能只修 CLI 输出', () => {
    expect(decisionSettled(pending)).toBe(false);
    expect(evidenceState(`${TARGET}（开工前）`, pending).st).not.toBe('✅');
    expect(decisionSettled('✅')).toBe(true);
    expect(evidenceState(TARGET, '✅').st).toBe('✅');
  });

  it('取证任务列的“可后补”不能掩盖 ✅ 状态中的明确待决子项', () => {
    const { code, out } = runCli([evidenceRow(pending, `${TARGET}（可后补）`)], []);
    expect(code).toBe(1);
    expectItem(out, EVIDENCE_MD, 6, 'Q-M0-901', '②待原站实测');
  });

  it('多行文档按原始行号定位，已完成的第一条不进入报告', () => {
    const evidence = [evidenceRow('✅').replace('Q-M0-901', 'Q-M0-900'), evidenceRow(pending)];
    const decisions = [decisionRow('✅').replace('D-901', 'D-900'), decisionRow(pending)];
    const { code, out } = runCli(evidence, decisions);
    expect(code).toBe(1);
    expect(out).not.toContain('Q-M0-900');
    expect(out).not.toContain('D-900');
    expectItem(out, EVIDENCE_MD, 7, 'Q-M0-901', '②待原站实测');
    expectItem(out, DECISION_MD, 7, 'D-901', '②待原站实测');
  });

  it('显式影响其他任务的待决项仍只拦对应任务', () => {
    const evidence = [evidenceRow(pending, OTHER_TARGET)];
    const decisions = [decisionRow(pending, `影响任务：${OTHER_TARGET}`)];
    const unrelated = runCli(evidence, decisions);
    expect(unrelated.code).toBe(0);
    expect(unrelated.out).not.toContain('Q-M0-901');
    expect(unrelated.out).not.toContain('D-901');
    expect(runCli(evidence, decisions, [TARGET, OTHER_TARGET]).code).toBe(1);
  });

  it('没有显式任务范围的待决差异继续保守拦截任意目标', () => {
    const { code, out } = runCli([], [decisionRow(pending, '')], [OTHER_TARGET]);
    expect(code).toBe(1);
    expectItem(out, DECISION_MD, 6, 'D-901', '②待原站实测');
  });

  it('无参数保持摘要模式退出 0，但两类待决子项与来源都不能漏报', () => {
    const { code, out } = runCli([evidenceRow(pending)], [decisionRow(pending)], []);
    expect(code).toBe(0);
    expect(out).toContain('未完成取证 1 项（共 1 项）');
    expectItem(out, EVIDENCE_MD, 6, 'Q-M0-901', '②待原站实测');
    expectItem(out, DECISION_MD, 6, 'D-901', '②待原站实测');
  });
});

describe('AC-TOOL-F313 带前缀的取证状态', () => {
  const prefixes = ['#30 ', '取证记录：', '①', '  #30  '];
  const pendingWords = [
    '待原站实测',
    '待实测',
    '待取证',
    '待定',
    '待用户决定',
    '待确认',
    '待复核',
    '🟡 部分',
    '🔴 未定论',
  ];

  function expectBlocked(status: string, items: string[], blocks = `${TARGET}（开工前）`) {
    const { code, out } = runCli([evidenceRow(status, blocks)], []);
    expect(code).toBe(1);
    expect(out.split('\n')).toEqual([
      '',
      `== ${TARGET} ==`,
      '⛔ 开工前须完成的取证 1 项：',
      `  Q-M0-901  ${status.includes('🔴') ? '🔴 未定论' : '🟡 部分'}  合成取证内容`,
      ...items.map((item) => `    ${EVIDENCE_MD}:6  Q-M0-901  待决子项：${item}`),
      '',
    ]);
  }

  describe.each(prefixes)('前缀 %j', (prefix) => {
    it.each(pendingWords)('AC-TOOL-F313：%s 子项不能被前面的完成标记覆盖', (pending) => {
      expectBlocked(`${prefix}✅ 已取证；②${pending}；③✅ 已完成`, [`②${pending}`]);
    });

    it('AC-TOOL-F313：全部完成才放行，待办和待入职不是取证状态', () => {
      const { code, out } = runCli([evidenceRow(`${prefix}✅ 已取证（待办去重）；②已确认待入职字段`)], []);
      expect(code).toBe(0);
      expect(out.split('\n')).toEqual([
        '',
        `== ${TARGET} ==`,
        '✅ 清单中没有挂在该任务上的未完成取证（新任务仍须先做开工前取证扫描）',
        '',
      ]);
    });
  });

  it.each([...SEPARATORS, ''])('AC-TOOL-F313：分隔符 %j 复用原有分项入口，首尾待决均保留', (separator) => {
    const items = ['#30 待取证', '②待原站实测'];
    expectBlocked(['#30 待取证', '①✅ 已取证', '②待原站实测', '③✅ 已完成'].join(separator), items);
  });

  it.each([
    '②待实测（入口(字段,错误提示)；回执）',
    '②已取证(入口（字段、待原站实测）；回执)',
    '②已取证（入口,字段)；③待实测',
    '②待实测（入口、字段；③已完成',
    '②已取证（🟡 部分；入口）',
    `②${'合成检查内容'.repeat(15)}待 原站 实测`,
  ])('AC-TOOL-F313：括号及长子项保持完整诊断：%s', (item) => {
    expectBlocked(`#30 ✅ 已取证；${item}`, [item]);
  });

  it.each(['②待取证', '②🟡 部分', '②🔴 未定论'])(
    'AC-TOOL-F313：任务列后补声明不能掩盖带前缀完成状态里的 %s',
    (item) => {
      expectBlocked(`#30 ✅ 已取证；剩余可后补；${item}`, [item], `${TARGET}（可后补）`);
    },
  );

  it.each(['🟡 部分', '🔴 未定论'])('AC-TOOL-F313：无前缀的完成状态也必须检查 %s 子项', (item) => {
    expectBlocked(`✅ 已取证；②${item}`, [`②${item}`]);
    expect(decisionSettled(`✅ 已取证；②${item}`)).toBe(false);
  });

  it('AC-TOOL-F313：共享入口返回完整状态，差异行仍保持 F-290 开头检查契约', () => {
    expect(evidenceState(`${TARGET}（可后补）`, '#30 ✅ 已取证；②待原站实测')).toEqual({
      st: '🟡 部分',
      level: '开工前',
      pendingItems: ['②待原站实测'],
    });
    expect(decisionSettled('#30 ✅ 已取证；②已完成')).toBe(false);
  });

  it('AC-TOOL-F313：无参数完整报告前缀待决项，指定无关任务不误拦', () => {
    const row = evidenceRow('#30 ✅ 已取证；②待原站实测');
    const summary = runCli([row], [], []);
    expect(summary.code).toBe(0);
    expect(summary.out.split('\n')).toEqual([
      '未完成取证 1 项（共 1 项）',
      `  Q-M0-901  🟡 部分  [${TARGET}（开工前）]  合成取证内容`,
      `    ${EVIDENCE_MD}:6  Q-M0-901  待决子项：②待原站实测`,
      '',
    ]);
    const unrelated = runCli([row], [], [OTHER_TARGET]);
    expect(unrelated.code).toBe(0);
    expect(unrelated.out.split('\n')).toEqual([
      '',
      `== ${OTHER_TARGET} ==`,
      '✅ 清单中没有挂在该任务上的未完成取证（新任务仍须先做开工前取证扫描）',
      '',
    ]);
  });
});

describe('AC-TOOL-F313 DEC-684⑦ 真实文档对账', () => {
  const evidence = parseEvidence(readFileSync(new URL(`../../${EVIDENCE_MD}`, import.meta.url), 'utf8'));

  it.each([
    ['Q-M0-33', '✅', '可后补'],
    ['Q-M0-84', '✅', '可后补'],
    ['Q-M0-108', '🟡 部分', '可后补'],
    ['Q-M0-109', '🟡 部分', '可后补'],
  ])('AC-TOOL-F313：%s 区分已结案与未实测后补，均不再新增阻塞', (id, st, level) => {
    const row = evidence.find((entry) => entry.id === id);
    expect(row && { st: row.st, level: row.level, pendingItems: row.pendingItems }).toEqual({
      st,
      level,
      pendingItems: [],
    });
  });

  it('AC-TOOL-F313 / F367：仅解除对账记录，其他开工前阻塞集合保持不变', () => {
    expect(evidence.filter((row) => row.st !== '✅' && row.level === '开工前').map((row) => row.id)).toEqual([
      'Q-M0-31',
      'Q-M0-107',
      'Q-M0-112',
      'Q-M0-114',
      'Q-M0-117',
      'Q-M0-120',
      'Q-M0-134',
      'Q-M0-145',
      'Q-M0-148',
      'Q-M0-172',
      'Q-M0-173',
      'Q-M0-174',
      'Q-M0-175',
      'Q-M0-176',
    ]);
  });
});

describe('AC-TOOL-F367 阻塞列“不挡本任务”分段（合成夹具，真实 CLI）', () => {
  const run = (blocks: string, target: string) => runCli([evidenceRow('🟡 合成残项', blocks)], [], [target]);

  it('标“不挡本任务”的分段只对该任务列为可后补，同行其余任务仍开工前阻塞', () => {
    const blocks = `${OTHER_TARGET}（开工前：③）、${TARGET}（不挡本任务：①②）`;
    const other = run(blocks, OTHER_TARGET);
    expect(other.code).toBe(1);
    expect(other.out).toContain('⛔ 开工前须完成的取证 1 项：');
    const target = run(blocks, TARGET);
    expect(target.code).toBe(0);
    expect(target.out).toContain('⚠️ 可先按暂定口径开发、合并后补的取证 1 项：');
    expect(target.out).not.toContain('⛔');
  });

  it.each([
    ['同一任务另有开工前分段', `${TARGET}（开工前：③）、${TARGET}（不挡本任务：①②）`, TARGET],
    ['只写“不挡”不算本任务放行', `${TARGET}（写代码前清零；不挡设计修订）`, TARGET],
    ['“不挡本任务”须紧跟分段开头的任务号', `${OTHER_TARGET}（开工前：③，${TARGET} 不挡本任务）`, OTHER_TARGET],
    ['分段内另写开工前不放行', `${TARGET}（不挡本任务；③ 开工前）`, TARGET],
  ])('%s：仍退出 1', (_name, blocks, target) => {
    expect(run(blocks, target).code).toBe(1);
  });
});

describe('AC-TOOL-F367 已定口径与开工前已满足的整行拆分', () => {
  const evidence = parseEvidence(readFileSync(new URL(`../../${EVIDENCE_MD}`, import.meta.url), 'utf8'));
  const state = (id: string) => {
    const row = evidence.find((entry) => entry.id === id);
    return row && { st: row.st, level: row.level, pendingItems: row.pendingItems, tasks: [...row.tasks] };
  };
  const realRow = (id: string) => {
    const c = readFileSync(new URL(`../../${EVIDENCE_MD}`, import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`| ${id} `))!
      .split('|')
      .map((cell) => cell.trim());
    return { blocks: c[5]!, status: c[6]! };
  };

  it.each([
    ['Q-M0-105', ['F-032', 'F-033']],
    ['Q-M0-115', ['R3-T07']],
    ['Q-M0-118', ['R2-T04']],
    ['Q-M0-121', ['R2-T05']],
    ['Q-M0-122', ['R2-T07']],
    ['Q-M0-123', ['R2-T10']],
  ])('AC-TOOL-F367：%s 残项保留为 🟡 可后补，任务范围不变', (id, tasks) => {
    expect(state(id)).toEqual({ st: '🟡 部分', level: '可后补', pendingItems: [], tasks });
  });

  it.each(['Q-M0-162', 'Q-M0-165', 'Q-M0-166'])('AC-TOOL-F367：%s 已由 DEC 定口径，✅ 且无待决子项', (id) => {
    expect(state(id)).toMatchObject({ st: '✅', pendingItems: [], tasks: ['F-076'] });
  });

  it.each([
    ['Q-M0-112', ['R3-T03', 'F-040']],
    ['Q-M0-114', ['R3-T06']],
    ['Q-M0-120', ['R2-T09']],
  ])('AC-TOOL-F367：%s 残项仍需开工前取证，继续阻塞', (id, tasks) => {
    expect(state(id)).toEqual({ st: '🟡 部分', level: '开工前', pendingItems: [], tasks });
  });

  // 第 2 轮 P2-1：③ 指定日期挂起仍待实测（DEC-296② 不覆盖，规格 30 要求写入实测），阻塞列恢复基线写法。
  it('AC-TOOL-F367：Q-M0-120 阻塞列为基线“R2-T09（开工前：①②③）”，状态列写明 ③ 仍待实测与 DEC-726', () => {
    const row = realRow('Q-M0-120');
    expect(row.blocks).toBe('R2-T09（开工前：①②③）');
    expect(row.status).toContain('③ 指定日期挂起仍待实测（开工前）');
    expect(row.status).toContain('⑤ 可后补');
    expect(row.status).toContain('DEC-726：R2-T09 派发前先补测指定日期挂起形态（取证单 F-408）');
  });

  // 第 2 轮 P2-2：③ 套卷共享只挡 F-040；①② 属 R3-T03（DEC-289① 不挡），对 R3-T03 只列为后补提示。
  it('AC-TOOL-F367：Q-M0-112 只对 F-040 开工前阻塞，对 R3-T03 列为可后补', () => {
    const lines = (target: string) => gateReport(evidence, [], [target]).lines.join('\n');
    expect(gateReport(evidence, [], ['F-040']).exitCode).toBe(1);
    expect(lines('F-040')).toMatch(/⛔ 开工前须完成的取证[^⚠]*Q-M0-112/);
    expect(lines('R3-T03')).not.toMatch(/⛔[^⚠]*Q-M0-112/);
    expect(lines('R3-T03')).toMatch(/⚠️ 可先按暂定口径开发[\s\S]*Q-M0-112/);
  });

  it.each([
    ['F-032', 0],
    ['F-033', 0],
    ['F-076', 0],
    ['R3-T03', 0],
    ['F-040', 1],
    ['R2-T09', 1],
  ])('AC-TOOL-F367：真实 CLI node scripts/evidence-gate.mjs %s 退出 %i', (target, code) => {
    const script = fileURLToPath(new URL('../../scripts/evidence-gate.mjs', import.meta.url));
    const env = { ...process.env };
    delete env.EVIDENCE_GATE_ROOT;
    const run = spawnSync(process.execPath, [script, target], { encoding: 'utf8', env, timeout: 10_000 });
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(code);
  });

  // 第 2 轮 P3-3～P3-5：依据与残项说明。
  it('AC-TOOL-F367：Q-M0-122 / 123 / 118 依据与残项写法', () => {
    expect(realRow('Q-M0-122').blocks).toContain('基线开工前仅 ①②');
    expect(realRow('Q-M0-122').status).toContain('⑤ 已读到表单，在途记录形态无样本');
    expect(realRow('Q-M0-123').blocks).toContain('docs/02_业务建模/35_人事数据分析_规格.md:66 AC-HA-05');
    expect(realRow('Q-M0-123').status).toContain('AC-HA-05 与官方权限矩阵 HRBP 无菜单矛盾');
    expect(realRow('Q-M0-118').status).toMatch(/残项 = [^；]*随 F-351/);
  });

  it('AC-TOOL-F367：门禁对 F-032 / F-033 / F-076 退出 0，F-040 仍退出 1', () => {
    const report = (target: string) => gateReport(evidence, [], [target]);
    expect(report('F-032').exitCode).toBe(0);
    expect(report('F-033').exitCode).toBe(0);
    expect(report('F-076').exitCode).toBe(0);
    expect(report('F-040').exitCode).toBe(1);
    expect(report('F-040').lines.join('\n')).toContain('Q-M0-112');
  });

  it('AC-TOOL-F367：已 ✅ 的行状态列不残留 🟡 / 待决写法，🟡 后补行不残留 ✅ 完成标记', () => {
    const md = readFileSync(new URL(`../../${EVIDENCE_MD}`, import.meta.url), 'utf8');
    const statusOf = (id: string) =>
      md
        .split('\n')
        .find((l) => l.startsWith(`| ${id} `))!
        .split('|')[6]!;
    expect(statusOf('Q-M0-166')).not.toMatch(/🟡|待(?:实测|取证|定|确认|复核|用户|原站)/);
    for (const id of ['Q-M0-105', 'Q-M0-115', 'Q-M0-118', 'Q-M0-120', 'Q-M0-121', 'Q-M0-122', 'Q-M0-123']) {
      expect(statusOf(id)).not.toContain('✅');
    }
    // 第 2 轮 P3-6：仍为 🟡 的后补行必须分清残项与取证原文。
    for (const id of ['Q-M0-105', 'Q-M0-115', 'Q-M0-118', 'Q-M0-121', 'Q-M0-122', 'Q-M0-123']) {
      expect(statusOf(id)).toContain('残项 =');
      expect(statusOf(id)).toContain('以下为取证原文');
    }
  });
});
