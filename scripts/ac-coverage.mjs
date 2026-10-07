#!/usr/bin/env node
// AC 覆盖统计（F-030，DEC-254）：用 Vitest 运行时收集的真实用例统计 AC 覆盖，对照追溯表与规格中的定义。
//
// 用法（pnpm ac:coverage …）：
//   node scripts/ac-coverage.mjs --stage R1                  # 人读 Markdown 输出到 stdout
//   node scripts/ac-coverage.mjs --stage R1 --format json    # 机器可读 JSON
//   node scripts/ac-coverage.mjs --stage all --out <目录>     # 写出 <阶段>.json 与 <阶段>.md
//   node scripts/ac-coverage.mjs --stage R1 --check          # 有缺口、未定义引用或问题时退出码 1
//   --config-dir <目录>  配置目录，缺省 docs/05_验收/ac-coverage（config.json + 各阶段 <阶段>.json）
//   --save-collected <文件> / --from-collected <文件>  保存 / 复用一次运行时收集结果（同一提交上按阶段多次统计时用）
// 退出码：0 正常；1 --check 不通过；2 参数、配置或收集失败。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { collectProfiles } from './ac-coverage/collect.mjs';
import { loadConfig, selectStages, UsageError } from './ac-coverage/config.mjs';
import { computeReport } from './ac-coverage/coverage.mjs';
import { scanDefinitions } from './ac-coverage/definitions.mjs';
import { renderMarkdown } from './ac-coverage/markdown.mjs';

const OPTIONS = {
  stage: { type: 'string', default: 'all' },
  'config-dir': { type: 'string', default: 'docs/05_验收/ac-coverage' },
  format: { type: 'string', default: 'md' },
  out: { type: 'string' },
  check: { type: 'boolean', default: false },
  'save-collected': { type: 'string' },
  'from-collected': { type: 'string' },
};

async function collected(config, values) {
  if (values['from-collected']) return JSON.parse(readFileSync(values['from-collected'], 'utf8'));
  const result = await collectProfiles(config);
  if (values['save-collected']) writeFileSync(values['save-collected'], JSON.stringify(result));
  return result;
}

function checkMessages(report) {
  const lines = [`AC 覆盖检查不通过（${report.stages.join(' / ')}）：`];
  if (report.gaps.length) lines.push(`- 缺口 ${report.gaps.length} 条：${report.gaps.join('、')}`);
  for (const ref of report.unknownReferences) {
    lines.push(`- 测试引用了不存在的编号 ${ref.id}：${[...new Set(ref.tests.map((t) => t.file))].join('、')}`);
  }
  for (const problem of report.problems) lines.push(`- [${problem.kind}] ${problem.message}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS, allowPositionals: false });
  if (!['md', 'json'].includes(values.format)) throw new UsageError(`--format 只支持 md / json：${values.format}`);
  const config = loadConfig(values['config-dir']);
  const stageNames = selectStages(config, values.stage);
  const { definitions, duplicates } = scanDefinitions(config.definitions, config.root);
  const report = computeReport({
    config,
    stageNames,
    collected: await collected(config, values),
    definitions,
    duplicates,
  });
  const command = `pnpm ac:coverage --stage ${values.stage}`;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, `${values.stage}.json`), json);
    writeFileSync(join(values.out, `${values.stage}.md`), renderMarkdown(report, command));
  } else {
    process.stdout.write(values.format === 'json' ? json : renderMarkdown(report, command));
  }
  if (values.check && !report.ok) {
    process.stderr.write(checkMessages(report));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof UsageError ? '' : '运行失败：'}${error.message}\n`);
  process.exitCode = 2;
});
