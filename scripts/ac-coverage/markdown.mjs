// 人读 Markdown：汇总、检查结果、逐条明细、收集统计与采集局限。
import { STATUSES } from './coverage.mjs';

const cell = (text) =>
  String(text ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const bold = (cells) => `| ${cells.map((c) => `**${cell(c)}**`).join(' | ')} |`;
const header = (cells) => [row(cells), `|${cells.map(() => '---').join('|')}|`];

function summaryTable(report) {
  const lines = header(['分组', 'AC 条数', ...STATUSES]);
  for (const group of report.groups)
    lines.push(row([group.name, group.summary.total, ...STATUSES.map((s) => group.summary[s])]));
  lines.push(bold(['合计', report.summary.total, ...STATUSES.map((s) => report.summary[s])]));
  return lines;
}

function checkSection(report) {
  const lines = [`- 结论：${report.ok ? '通过' : '不通过'}`];
  lines.push(`- 缺口（无人工改判的未覆盖 / 仅 skip / todo / 未定义）：${report.gaps.length} 条${list(report.gaps)}`);
  const unknown = report.unknownReferences.map(
    (r) => `${r.id}（${[...new Set(r.tests.map((t) => t.file))].join('、')}）`,
  );
  lines.push(`- 测试引用但追溯表与规格中不存在的编号：${unknown.length} 个${list(unknown)}`);
  const ignored = report.ignoredReferences.map((r) => `${r.id}（${r.reason}）`);
  if (ignored.length) lines.push(`- 已登记的非业务编号：${ignored.join('；')}`);
  lines.push(`- 问题：${report.problems.length} 个${list(report.problems.map((p) => `[${p.kind}] ${p.message}`))}`);
  if (report.duplicateDefinitions.length) {
    lines.push(`- 提示：重复定义 ${report.duplicateDefinitions.length} 处（以第一处为准，不判失败）：`);
    lines.push(...report.duplicateDefinitions.map((d) => `  - ${d.id}：${d.location}（以 ${d.first} 为准）`));
  }
  return lines;
}

const DETAIL_COLUMNS = [
  '编号',
  '运行时状态',
  '最终状态',
  '用例数（运行 / skip·todo / 人工映射）',
  '条件执行',
  '测试文件',
  '定义位置',
  '分类',
  '备注',
];

const list = (items) => (items.length ? `：${items.join('；')}` : '');

function files(entry) {
  return entry.files.length > 4
    ? `${entry.files.slice(0, 4).join('、')} 等 ${entry.files.length} 个`
    : entry.files.join('、');
}

function detailTable(report, group) {
  const lines = [`### ${group.name}`, ''];
  lines.push(...header(DETAIL_COLUMNS));
  for (const id of group.ids) {
    const e = report.entries[id];
    const counts = `${e.tests} / ${e.skippedOrTodo} / ${e.mapped}`;
    const conditional = e.conditional.length
      ? `仅 ${e.conditional.join(' / ')}`
      : e.conditionalTests
        ? `含 ${e.conditionalTests} 个条件执行用例`
        : '—';
    lines.push(row([id, e.runtimeStatus, e.status, counts, conditional, files(e), e.definition, e.category, e.note]));
  }
  return lines;
}

function statsTable(report) {
  const lines = header([
    '收集档',
    '文件',
    'run',
    'skip',
    'todo',
    'mode 为 only',
    '收集错误',
    '身份无法确认（不计入覆盖）',
  ]);
  for (const [name, s] of Object.entries(report.profiles))
    lines.push(row([name, s.files, s.run, s.skip, s.todo, s.only, s.errors, s.excluded]));
  return lines;
}

export function renderMarkdown(report, command) {
  return [
    `# AC 覆盖报告（运行时采集）：${report.titles.join(' / ')}`,
    '',
    `> 生成命令：\`${command}\`。用例、最终标题与 run / skip / todo 状态由 Vitest 运行时收集`,
    '> （`collect(…, { staticParse: false })`），不读测试源码（DEC-254，F-030）。',
    '',
    '## 汇总',
    '',
    ...summaryTable(report),
    '',
    '## 检查结果',
    '',
    ...checkSection(report),
    '',
    '## 明细',
    '',
    ...report.groups.flatMap((g) => [...detailTable(report, g), '']),
    '## 收集统计',
    '',
    ...statsTable(report),
    '',
    '采集局限：只收集、不执行用例体，用例体内的 `ctx.skip()` 与用例失败不在统计内（失败由 CI 全绿保证）。',
    '“条件执行”表示覆盖该编号的用例只在部分收集档运行（如仅真 PostgreSQL）。',
    '身份无法确认的注册（位置未知、同档重复、跨 project 同名、各档对不上）不计入覆盖，汇总与明细的计数都不含，',
    '逐条列在检查结果的 identity 问题里；收集统计的 run / skip / todo 是各档原样计数，含这些注册。',
    '',
  ].join('\n');
}
