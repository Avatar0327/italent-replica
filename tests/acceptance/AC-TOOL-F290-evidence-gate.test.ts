/**
 * F-290：取证门禁（scripts/evidence-gate.mjs）的状态识别（第 5 轮起：精确匹配放行，DEC-431①）。
 * 放行 = 整条状态列（规范化空白与全半角标点后）逐字等于放行表里的一条；放行表取自真实清单当前放行的 20 行
 * （Q-M0-127 / 132 / 133 / 153 + D-062～D-077）。其余状态一律阻塞：没有关键词 / 子串 / 正则式的“已取”“可后补”判定。
 * 新的状态写法须人工把原文加进 evidence-gate-lib.mjs 的放行表并配测试。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gateReport, parseDecisions, parseEvidence } from '../../scripts/evidence-gate-lib.mjs';

const TARGET = 'R9-T01';
const EVIDENCE_MD = 'docs/07_M0/03_需取证清单.md';
const DECISION_MD = 'docs/00_状态/04_缺口冲突差异登记册.md';
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const cellsOf = (line: string) =>
  line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());

// 真实清单 / 登记册里的状态列原文（放行表的来源行）
const evidenceCell = (id: string) =>
  cellsOf(
    read(EVIDENCE_MD)
      .split('\n')
      .find((l) => l.startsWith(`| ${id} `))!,
  )[5]!;
const decisionCell = (id: string) =>
  cellsOf(
    read(DECISION_MD)
      .split('\n')
      .find((l) => l.startsWith(`| **${id}** `))!,
  )[4]!;
const RELEASED_EVIDENCE = ['Q-M0-127', 'Q-M0-132', 'Q-M0-133', 'Q-M0-153'];
const RELEASED_DECISIONS = Array.from({ length: 16 }, (_, i) => `D-0${62 + i}`);

const decisionRow = (id: string, status: string) => `| **${id}** | 原站某行为 | 差异描述 | 方案 | ${status} |`;
const evidenceRow = (id: string, blocks: string, status: string) =>
  `| ${id} | 来源 | 取证内容 | 方法 | ${blocks} | ${status} |`;
const gate = (evidenceLines: string[], decisionLines: string[], targets: string[] = [TARGET]) =>
  gateReport(parseEvidence(evidenceLines.join('\n')), parseDecisions(decisionLines.join('\n')), targets);

describe('F-290 差异登记册状态识别', () => {
  const settled = [
    ['已定（可推翻）', decisionCell('D-066')],
    ['已定（用户选定）', decisionCell('D-070')],
    ['已关闭', decisionCell('D-064')],
    ['✅', '✅ 用户 2026-10-06 选① → DEC-222'],
  ] as const;
  it.each(settled)('%s：不拦开工', (_name, status) => {
    const { lines, exitCode } = gate([], [decisionRow('D-901', status)]);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).not.toContain('D-901');
  });

  const open = [
    ['待用户决定', '待用户决定'],
    ['待原站实测', '待原站实测'],
    ['无法识别的状态', '观察中'],
    ['“已定”后追加说明（精确匹配，保守）', '已定（可推翻）；待复核'],
    ['“已定”不在开头', '待用户决定（部分已定）'],
  ] as const;
  it.each(open)('%s：按待决拦截', (_name, status) => {
    const { lines, exitCode } = gate([], [decisionRow('D-902', status)]);
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('D-902');
  });

  it('无参数时已结行不再列出、待决行仍列出，退出码 0', () => {
    const { lines, exitCode } = gate([], [decisionRow('D-901', '已定'), decisionRow('D-902', '待用户决定')], []);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('待用户决定 / 待原站实测的差异 1 项');
    expect(lines.join('\n')).not.toContain('D-901');
  });

  it('显式写了“影响任务”的待决行只拦对应任务', () => {
    const row = decisionRow('D-903', '待用户决定').replace('差异描述', '差异描述；影响任务：R9-T02');
    expect(gate([], [row]).exitCode).toBe(0);
    expect(gate([], [row], ['R9-T02']).exitCode).toBe(1);
  });
});

describe('F-290 取证清单状态识别', () => {
  const blocks = `${TARGET}（开工前）`;

  it.each([
    ['🟡 剩余部分按 DEC 口径定', evidenceCell('Q-M0-153')],
    ['🟡 剩余可后补（员工自助）', evidenceCell('Q-M0-133')],
    ['🟡 剩余可后补（下级可见性）', evidenceCell('Q-M0-132')],
    ['🟡 剩余可后补（清单）', evidenceCell('Q-M0-127')],
  ])('%s：降为可后补，不拦开工', (_name, status) => {
    const { lines, exitCode } = gate([evidenceRow('Q-M0-901', blocks, status)], []);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('可先按暂定口径开发');
    expect(lines.join('\n')).not.toContain('⛔');
  });

  it('✅ 已证：不列出，退出码 0', () => {
    const { lines, exitCode } = gate([evidenceRow('Q-M0-901', blocks, '✅ 2026-10-03 已取')], []);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).not.toContain('Q-M0-901');
  });

  it.each([
    ['🟡 无说明', '🟡 已取一部分'],
    ['🟡 只提到 DEC 编号', '🟡 与 DEC-261 同构；其余未测'],
    ['🔴', '🔴 未定论'],
    ['🔴 即使写了可后补', '🔴 未定论；可后补'],
    ['□ 未取证', ''],
  ])('%s：照旧拦开工', (_name, status) => {
    const { lines, exitCode } = gate([evidenceRow('Q-M0-902', blocks, status)], []);
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('⛔ 开工前须完成的取证 1 项');
  });

  it('任务列已写“后续 / 可后补”的行保持原有的可后补处理（与 F-271 对 Q-M0-119 的结果一致）', () => {
    const row = evidenceRow(
      'Q-M0-119',
      'R9-T01（①④ 已满足；剩余项可后补，F-271 对账）',
      '🟡 口径已定：DEC-526；仍未验证',
    );
    const { lines, exitCode } = gate([row], []);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('Q-M0-119');
  });

  it('无参数时仍列出全部非 ✅ 的取证（含可后补）', () => {
    const rows = [
      evidenceRow('Q-M0-901', blocks, '✅ 已证'),
      evidenceRow('Q-M0-902', blocks, evidenceCell('Q-M0-133')),
    ];
    expect(gate(rows, [], [])['lines'][0]).toBe('未完成取证 1 项（共 2 项）');
  });
});

describe('F-290 精确匹配：放行表之外一律阻塞', () => {
  const blocks = `${TARGET}（开工前）`;
  const released = (status: string) =>
    !gate([evidenceRow('Q-M0-903', blocks, status)], [])
      .lines.join('')
      .includes('⛔');
  const settledDecision = (status: string) => gate([], [decisionRow('D-903', status)]).exitCode === 0;

  it.each(RELEASED_EVIDENCE)('%s 的状态列原文放行；空白 / 全半角标点差异不影响', (id) => {
    const cell = evidenceCell(id);
    expect(released(cell)).toBe(true);
    expect(released(` ${cell.replace(/，/g, ',').replace(/；/g, ';')} `)).toBe(true);
  });
  it.each(RELEASED_EVIDENCE)('%s 的状态列原文追加任意字符 / 删减即阻塞', (id) => {
    const cell = evidenceCell(id);
    for (const changed of [`${cell}。`, `${cell}x`, `${cell}；②待确认`, `x${cell}`, cell.slice(0, -1), cell.slice(1)]) {
      expect(released(changed)).toBe(false);
    }
  });
  it.each(RELEASED_DECISIONS)('%s 的状态列原文放行，追加任意字符即阻塞', (id) => {
    const cell = decisionCell(id);
    expect(settledDecision(cell)).toBe(true);
    for (const changed of [`${cell}。`, `${cell}x`, `${cell}；待复核`, `x${cell}`]) {
      expect(settledDecision(changed)).toBe(false);
    }
  });
});

describe('F-290 CLI 回归：第 3～5 轮全部复现写法阻塞、退出码 1', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  // 在临时目录放夹具清单 / 登记册，真实运行 scripts/evidence-gate.mjs R9-T01
  const runCli = (status: string) => {
    const root = mkdtempSync(path.join(tmpdir(), 'f290-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'docs/07_M0'), { recursive: true });
    mkdirSync(path.join(root, 'docs/00_状态'), { recursive: true });
    writeFileSync(path.join(root, EVIDENCE_MD), `${evidenceRow('Q-M0-903', 'R9-T01（开工前）', status)}\n`);
    writeFileSync(path.join(root, DECISION_MD), '');
    const script = new URL('../../scripts/evidence-gate.mjs', import.meta.url);
    const run = spawnSync(process.execPath, [script.pathname, TARGET], {
      encoding: 'utf8',
      env: { ...process.env, EVIDENCE_GATE_ROOT: `${root}/` },
    });
    return { code: run.status, out: run.stdout };
  };

  const blocked = [
    // 第 2 轮
    '🟡 已取一半；剩余不可后补',
    '🟡 已取一半；剩余不能按 DEC-392 定口径',
    '🟡 已取一半；剩余①可后补；②仍须在实现前完成取证',
    '🟡 已取一半；剩余①可后补；②另有若干事项',
    '🟡 已取一半；剩余未必可后补',
    // 第 3 轮
    '🟡 ①不可后补；剩余可后补',
    '🟡 已取一半；剩余可后补；10-20 补：该项不允许后补',
    '🟡 已取一半；剩余可后补；10-20 补：是否可后补尚不确定',
    '🟡 ①仍须取证；剩余可后补',
    '🟡 已取一半；剩余可后补；10-20 补：该项仍未完成取证',
    '🟡 已取一半；剩余可后补；②待确认',
    '🟡 已取一半；剩余可后补；②可能还有差异',
    // 第 4 轮
    '🟡 ①需先补全取证；剩余可后补',
    '🟡 已取一半；剩余可后补；10-20 补：该项已取证了吗',
    '🟡 已取证结论存疑；剩余可后补',
    '🟡 已取证；原结论已撤销，需重新实测；剩余可后补',
    '🟡 已取一半；剩余可后补；②实测计划尚在排期',
    '🟡 已取一半；剩余可后补；10-20 补：拟下周实测',
    '🟡 已取一半；剩余可后补；10-20 补：补全方案尚有争议',
    // 没有放行表之外的“合法”写法
    '🟡 已取一半；剩余可后补',
    '🟡 已取一半；未测部分按设计口径定（DEC-392）',
  ];
  it.each(blocked)('%s', (status) => {
    const { code, out } = runCli(status);
    expect(code).toBe(1);
    expect(out).toContain('⛔ 开工前须完成的取证 1 项');
  });

  it.each(RELEASED_EVIDENCE)('对照：%s 状态列原文放行，退出码 0', (id) => {
    const { code, out } = runCli(evidenceCell(id));
    expect(code).toBe(0);
    expect(out).toContain('可先按暂定口径开发');
  });
});

describe('F-290 真实清单上的放行集合（防止收紧误拦或放松误放）', () => {
  it('取证清单：由状态列放行的恰为 Q-M0-127 / 132 / 133 / 153', () => {
    const released = parseEvidence(read(EVIDENCE_MD))
      .filter((e) => e.level === '可后补' && !/后续|落地后|恢复时|可后补/.test(e.blocks))
      .map((e) => e.id);
    expect(released).toEqual(RELEASED_EVIDENCE);
  });

  it('差异登记册：非 ✅ 开头而放行的恰为 D-062～D-077，仍待决的只有 D-057', () => {
    const md = read(DECISION_MD);
    const open = parseDecisions(md).map((d) => d.id);
    const settledNotTicked = md
      .split('\n')
      .filter((l) => /^\| \*\*D-\d+\*\*/.test(l))
      .map((l) => ({ id: /D-\d+/.exec(l)![0], st: cellsOf(l)[4]! }))
      .filter((d) => !open.includes(d.id) && !d.st.startsWith('✅'))
      .map((d) => d.id);
    expect(open).toEqual(['D-057']);
    expect(settledNotTicked).toEqual(RELEASED_DECISIONS);
  });
});
