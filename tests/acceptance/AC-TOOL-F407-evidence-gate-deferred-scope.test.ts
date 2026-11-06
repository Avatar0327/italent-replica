/** AC-TOOL-F407：阻塞列“可后补”放行范围收窄——写了“开工前”的任务 / 分段不被同列别处的可后补字样放行。 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseEvidence } from '../../scripts/evidence-gate-lib.mjs';

const T1 = 'R9-T01';
const T2 = 'R9-T02';
const EVIDENCE_MD = 'docs/07_M0/03_需取证清单.md';
const DECISION_MD = 'docs/00_状态/04_缺口冲突差异登记册.md';
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const row = (blocks: string, status = '🟡 合成残项') =>
  `| Q-M0-901 | 合成来源 | 合成取证内容 | 合成方法 | ${blocks} | ${status} |`;
const markdown = (rows: string[]) => ['# F-407 合成夹具', '', '| 表头 |', '| --- |', '', ...rows, ''].join('\n');

// 与 F303 同样跑真实 CLI：门禁最终看的是退出码与输出，不是内部字段。
function runCli(blocks: string, target: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'f407-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'docs/07_M0'), { recursive: true });
  mkdirSync(path.join(root, 'docs/00_状态'), { recursive: true });
  writeFileSync(path.join(root, EVIDENCE_MD), markdown([row(blocks)]));
  writeFileSync(path.join(root, DECISION_MD), markdown([]));
  const script = fileURLToPath(new URL('../../scripts/evidence-gate.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, target], {
    encoding: 'utf8',
    env: { ...process.env, EVIDENCE_GATE_ROOT: `${root}/` },
    timeout: 10_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.stderr).toBe('');
  return { code: run.status, out: run.stdout };
}
const blocked = (blocks: string, target: string) => {
  const { code, out } = runCli(blocks, target);
  if (code === 1) expect(out).toContain('⛔ 开工前须完成的取证 1 项：');
  return code === 1;
};
const deferred = (blocks: string, target: string) => {
  const { code, out } = runCli(blocks, target);
  if (code === 0) expect(out).toContain('⚠️ 可先按暂定口径开发、合并后补的取证 1 项：');
  return code === 0;
};

describe('AC-TOOL-F407 ① 括号内“开工前：…”不被同段 / 同列的可后补放行', () => {
  it.each([
    ['同段括号内另写可后补', `${T1}（开工前：①②③；⑤ 残项可后补）`],
    ['同段括号内另写后续', `${T1}（开工前：①②；其余后续）`],
    ['括号外另写后续', `${T1}（开工前：①②）后续`],
    ['开工前已满足的写法同样按开工前', `${T1}（开工前：①②③ 已满足；⑤ 残项可后补，依据 DEC-726）`],
  ])('%s：任务判开工前，退出 1', (_name, blocks) => {
    expect(blocked(blocks, T1)).toBe(true);
  });

  it('“开工前置已满足”是前置条件说明，不算开工前子项', () => {
    expect(deferred(`${T1}（开工前置已满足；其余后续可后补）`, T1)).toBe(true);
  });
});

describe('AC-TOOL-F407 ② 只写“后续 / 落地后 / 恢复时 / 可后补”且不含开工前 → 仍可后补', () => {
  it.each([
    ['任务号后写后续', `${T1} 后续`],
    ['括号内写可后补', `${T1}（不阻塞写代码；可后补）`],
    ['写落地后', `${T1}（落地后补）`],
    ['写恢复时', `${T1}（模块恢复时）`],
  ])('%s：退出 0', (_name, blocks) => {
    expect(deferred(blocks, T1)).toBe(true);
  });

  it('未注明级别仍按开工前', () => {
    expect(blocked(`${T1}（写代码前清零）`, T1)).toBe(true);
  });
});

describe('AC-TOOL-F407 ③ 多个任务分段分别定级', () => {
  const blocks = `${T1}（开工前：①②③），${T2} 后续（⑤ 可后补）`;
  it('开工前分段的任务阻塞', () => {
    expect(blocked(blocks, T1)).toBe(true);
  });
  it('可后补分段的任务不被同行的开工前分段拖累', () => {
    expect(deferred(blocks, T2)).toBe(true);
  });
  it('颠倒顺序结果不变', () => {
    const swapped = `${T2} 后续（⑤ 可后补），${T1}（开工前：①②③）`;
    expect(blocked(swapped, T1)).toBe(true);
    expect(deferred(swapped, T2)).toBe(true);
  });
});

describe('AC-TOOL-F407 ④ F-367“不挡本任务”分段行为不变', () => {
  it('不挡本任务的分段可后补，同行其余任务仍开工前', () => {
    const blocks = `${T2}（开工前：③）、${T1}（不挡本任务：①②）`;
    expect(deferred(blocks, T1)).toBe(true);
    expect(blocked(blocks, T2)).toBe(true);
  });
  it.each([
    ['同一任务另有开工前分段', `${T1}（开工前：③）、${T1}（不挡本任务：①②）`],
    ['分段内另写开工前不放行', `${T1}（不挡本任务；③ 开工前）`],
    ['不挡本任务段内写开工前置仍待取证', `${T1}（不挡本任务：开工前置条件仍待取证）`],
    ['不挡本任务段内写开工前置已满足', `${T1}（不挡本任务：开工前置已满足）`],
  ])('%s：仍阻塞', (_name, blocks) => {
    expect(blocked(blocks, T1)).toBe(true);
  });
});

describe('AC-TOOL-F407 ⑤ 真实清单：判定变化的行 × 任务与结果文件对照表一致', () => {
  const evidence = parseEvidence(readFileSync(new URL(`../../${EVIDENCE_MD}`, import.meta.url), 'utf8'));
  const levelOf = (id: string, task: string) => evidence.find((e) => e.id === id)?.taskLevels.get(task);

  // 对照表见 .cloud_result/F-407.md：改前 → 改后。
  it('Q-M0-111 × R2-T02：写了“开工前：AC-PB-03、04、08”且 AC-PB-08 未取证，改前被“其余后续”放行，改后开工前', () => {
    expect(levelOf('Q-M0-111', 'R2-T02')).toBe('开工前');
  });

  it.each([
    ['Q-M0-115', 'R3-T07'],
    ['Q-M0-118', 'R2-T04'],
    ['Q-M0-120', 'R2-T09'],
    ['Q-M0-121', 'R2-T05'],
    ['Q-M0-122', 'R2-T07'],
  ])('%s × %s：开工前子项已明写满足，改文档为“不挡本任务”后保持可后补', (id, task) => {
    expect(levelOf(id, task)).toBe('可后补');
  });
});
