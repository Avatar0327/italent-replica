#!/usr/bin/env node
// 取证门禁：列出某个任务开工 / 合并前还在等的取证项（Q-M0-xx）与待用户决定的差异（D-xxx）。
// 用法：node scripts/evidence-gate.mjs R1-T08 [R1-T09 | F-007 ...]    无参数时列出全部未完成取证。
// 退出码：有“开工前”未完成项或待决差异时为 1，否则为 0。
// 数据源：docs/07_M0/03_需取证清单.md、docs/00_状态/04_缺口冲突差异登记册.md（只读）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gateReport, parseDecisions, parseEvidence } from './evidence-gate-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

const { lines, exitCode } = gateReport(
  parseEvidence(read('docs/07_M0/03_需取证清单.md')),
  parseDecisions(read('docs/00_状态/04_缺口冲突差异登记册.md')),
  process.argv.slice(2),
);
for (const line of lines) console.log(line);
process.exit(exitCode);
