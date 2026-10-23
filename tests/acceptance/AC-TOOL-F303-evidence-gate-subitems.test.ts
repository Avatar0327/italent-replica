/** AC-TOOL-F303：✅ 开头也逐子项检查；用合成文档运行真实 CLI，验证阻塞与定位。 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decisionSettled, evidenceState } from '../../scripts/evidence-gate-lib.mjs';

const TARGET = 'R9-T01';
const OTHER_TARGET = 'R9-T02';
const EVIDENCE_MD = 'docs/07_M0/03_需取证清单.md';
const DECISION_MD = 'docs/00_状态/04_缺口冲突差异登记册.md';
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
  expect(
    out.split('\n').some((text) => text.includes(`${file}:${line}`) && text.includes(id) && text.includes(item)),
  ).toBe(true);
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

  it.each(['；', ';', '，', ',', '。', '. ', '、', '<br>', '<br/>', '<br />', ''])(
    '分隔符 %j：逐项输出多个待决项，后面的完成标记不能覆盖前面的待决项',
    (separator) => {
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
    },
  );

  it.each([
    ['首子项待决', '✅ 待取证；②已完成', '✅ 待取证'],
    ['括号内待决', '✅ 已取证（①已完成；②待原站实测）', '②待原站实测'],
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
  ])('完成状态 %s：退出 0，不列为待决', (status) => {
    const { code, out } = run(status);
    expect(code).toBe(0);
    expect(out).not.toContain(id);
    expect(out).not.toContain(`${file}:`);
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
