/**
 * F-290：取证门禁（scripts/evidence-gate.mjs）的状态识别。
 * 差异登记册：✅ / “已定” / “已关闭”开头视为已结，“待用户决定 / 待原站实测”和认不出的写法仍按待决拦截；
 * 取证清单：✅ 已证；🟡 且状态列写明剩余部分由 DEC 定口径或可后补的降为“可后补”，不拦开工；其余照旧。
 * 全部用小夹具字符串，不依赖真实清单的行数（DEC-431①：状态判定只有 evidenceState / decisionSettled 两个入口）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gateReport, parseDecisions, parseEvidence } from '../../scripts/evidence-gate-lib.mjs';

const TARGET = 'R9-T01';
const decisionRow = (id: string, status: string) => `| **${id}** | 原站某行为 | 差异描述 | 方案 | ${status} |`;
const evidenceRow = (id: string, blocks: string, status: string) =>
  `| ${id} | 来源 | 取证内容 | 方法 | ${blocks} | ${status} |`;

const gate = (evidenceLines: string[], decisionLines: string[], targets: string[] = [TARGET]) =>
  gateReport(parseEvidence(evidenceLines.join('\n')), parseDecisions(decisionLines.join('\n')), targets);

describe('F-290 差异登记册状态识别', () => {
  const settled = [
    ['已定（可推翻）', '已定（可推翻）'],
    ['已定（用户选定）', '已定（用户选定）'],
    ['已关闭', '已关闭（DEC-352：查看照原站全员可见）'],
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
    ['“已定”不在开头（保守）', '待用户决定（部分已定）'],
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
  // 放行必须有“剩余事项”的明确声明（DEC-431①：evidenceState 单一入口）
  const clear = [
    ['🟡 剩余部分由 DEC 定口径', '🟡 ①④ 已取；剩余由 DEC-526 定口径'],
    ['🟡 未测部分按 DEC 口径定', '🟡 已测一半；未测部分由 DEC-392 定口径'],
    ['🟡 未测部分按设计口径定', '🟡 已测一半；未测部分按设计口径定（DEC-392）'],
    ['🟡 剩余可后补', '🟡 已取大半；**剩余（可后补）**：⑯ 本样本观察不到'],
    ['🟡 剩余后续补测', '🟡 已取大半；剩余后续补测'],
    ['🟡 剩余落地后补', '🟡 已取大半；剩余落地后补'],
  ] as const;
  it.each(clear)('%s：降为可后补，不拦开工', (_name, status) => {
    const { lines, exitCode } = gate([evidenceRow('Q-M0-901', blocks, status)], []);
    const text = lines.join('\n');
    expect(exitCode).toBe(0);
    expect(text).toContain('可先按暂定口径开发');
    expect(text).not.toContain('⛔');
  });

  it('✅ 已证：不列出，退出码 0', () => {
    const { lines, exitCode } = gate([evidenceRow('Q-M0-901', blocks, '✅ 2026-10-03 已取')], []);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).not.toContain('Q-M0-901');
  });

  const block = [
    ['🟡 无说明', '🟡 已取一部分'],
    ['🟡 提到 DEC 但不是定口径', '🟡 与 DEC-261 同构；其余未测'],
    ['🟡 只有零散的“可后补”字样、没有剩余事项声明', '🟡 已取一半；后续补测'],
    ['🟡 局部定口径、另一项待原站实测（开工前）', '🟡 ①按 DEC-392 定口径；② 待原站实测（开工前）'],
    ['🟡 局部定口径、另一项待用户决定', '🟡 ①已取；②尚未由 DEC-392 定口径，待用户决定'],
    ['🟡 ①定口径；②待用户决定', '🟡 ①由 DEC-392 定口径；②待用户决定'],
    ['🟡 声明剩余可后补却又明写仍须开工前完成', '🟡 已取一半；剩余可后补；但 ② 开工前须取证'],
    ['🟡 否定句：剩余尚未定口径', '🟡 已取一半；剩余部分尚未由 DEC-392 定口径'],
    ['🟡 第 2 轮：剩余不可后补', '🟡 已取一半；剩余不可后补'],
    ['🟡 第 2 轮：剩余不能按 DEC 定口径', '🟡 已取一半；剩余不能按 DEC-392 定口径'],
    ['🟡 第 2 轮：剩余①可后补；②仍须在实现前完成取证', '🟡 已取一半；剩余①可后补；②仍须在实现前完成取证'],
    ['🟡 剩余里夹一项白名单外的说明', '🟡 已取一半；剩余①可后补；②另有若干事项'],
    ['🟡 剩余未必可后补（不确定表达）', '🟡 已取一半；剩余未必可后补'],
    ['🔴', '🔴 未定论'],
    ['🔴 即使写了可后补', '🔴 未定论；可后补'],
    ['□ 未取证', ''],
  ] as const;
  it.each(block)('%s：照旧拦开工', (_name, status) => {
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
    const rows = [evidenceRow('Q-M0-901', blocks, '✅ 已证'), evidenceRow('Q-M0-902', blocks, '🟡 剩余（可后补）')];
    const { lines } = gate(rows, [], []);
    expect(lines[0]).toBe('未完成取证 1 项（共 2 项）');
  });
});

describe('F-290 真实清单上的放行集合（防止收紧误拦或放松误放）', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

  it('取证清单：由状态列放行的恰为 Q-M0-127 / 132 / 133 / 153', () => {
    const released = parseEvidence(read('docs/07_M0/03_需取证清单.md'))
      .filter((e) => e.level === '可后补' && !/后续|落地后|恢复时|可后补/.test(e.blocks))
      .map((e) => e.id);
    expect(released).toEqual(['Q-M0-127', 'Q-M0-132', 'Q-M0-133', 'Q-M0-153']);
  });

  it('差异登记册：非 ✅ 开头而放行的恰为 D-062～D-077，仍待决的只有 D-057', () => {
    const md = read('docs/00_状态/04_缺口冲突差异登记册.md');
    const open = parseDecisions(md).map((d) => d.id);
    const settledNotTicked = md
      .split('\n')
      .filter((l) => /^\| \*\*D-\d+\*\*/.test(l))
      .map((l) => ({ id: /D-\d+/.exec(l)![0], st: l.split('|')[5]!.trim() }))
      .filter((d) => !open.includes(d.id) && !d.st.startsWith('✅'))
      .map((d) => d.id);
    expect(open).toEqual(['D-057']);
    expect(settledNotTicked).toEqual(Array.from({ length: 16 }, (_, i) => `D-0${62 + i}`));
  });
});

describe('F-290 CLI 回归：整行逐项判定（第 4 轮）', () => {
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
    writeFileSync(
      path.join(root, 'docs/07_M0/03_需取证清单.md'),
      `${evidenceRow('Q-M0-903', 'R9-T01（开工前）', status)}\n`,
    );
    writeFileSync(path.join(root, 'docs/00_状态/04_缺口冲突差异登记册.md'), '');
    const script = new URL('../../scripts/evidence-gate.mjs', import.meta.url);
    const run = spawnSync(process.execPath, [script.pathname, TARGET], {
      encoding: 'utf8',
      env: { ...process.env, EVIDENCE_GATE_ROOT: `${root}/` },
    });
    return { code: run.status, out: run.stdout };
  };

  const blocked = [
    ['剩余之前的子项不可后补', '🟡 ①不可后补；剩余可后补'],
    ['补测记录：该项不允许后补', '🟡 已取一半；剩余可后补；10-20 补：该项不允许后补'],
    ['补测记录：是否可后补尚不确定', '🟡 已取一半；剩余可后补；10-20 补：是否可后补尚不确定'],
    ['剩余之前的子项仍须取证', '🟡 ①仍须取证；剩余可后补'],
    ['补测记录：该项仍未完成取证', '🟡 已取一半；剩余可后补；10-20 补：该项仍未完成取证'],
    ['待确认', '🟡 已取一半；剩余可后补；②待确认'],
    ['可能', '🟡 已取一半；剩余可后补；②可能还有差异'],
  ] as const;
  it.each(blocked)('%s：阻塞，退出码 1', (_name, status) => {
    const { code, out } = runCli(status);
    expect(code).toBe(1);
    expect(out).toContain('⛔ 开工前须完成的取证 1 项');
  });

  it('对照：补测记录的尾部是已取事实时放行，退出码 0', () => {
    const { code, out } = runCli('🟡 已取一半；剩余可后补；10-20 补：该项已取证');
    expect(code).toBe(0);
    expect(out).toContain('可先按暂定口径开发');
  });
});
