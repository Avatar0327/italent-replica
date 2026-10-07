#!/usr/bin/env node
// AC 覆盖统计（派发规则 §6，DEC-221 后续）：扫描测试用例标题里的 AC 编号，对照追溯表与规格文档里定义的 AC，
// 结合人工备注算出“已定义 / 已覆盖 / 部分覆盖 / 未覆盖 / 未定义”，输出可嵌入报告的 Markdown 或 JSON。
//
// 用法：
//   node scripts/ac-coverage.mjs --config docs/05_验收/ac-coverage/R1.json            # 输出 Markdown
//   node scripts/ac-coverage.mjs --config <配置> --format json                          # 输出 JSON（供 R2 / R3 复用）
//   node scripts/ac-coverage.mjs --config <配置> --write docs/05_验收/R1_AC覆盖报告.md  # 改写报告中的标记块
//   node scripts/ac-coverage.mjs --config <配置> --check <报告>                         # 报告过期或映射失效时退出 1
//
// 规则：
// - “用例”= describe / it / test（含 .each / .runIf / .skipIf / .concurrent）；用例标题 = 各级 describe 标题 + 自身标题。
//   it.each 标题含 $x / %s 占位时，参数表中字符串字面量里的 AC 编号也计入；参数表里的标识符按使用位置的
//   词法作用域解析（就近声明优先）。同一作用域多处声明或 let / var 被重新赋值时无法静态确定，记入“需人工处理”，
//   不计入任何一份。
//   it.todo / .skip 不计覆盖；runIf / skipIf 计覆盖并标“条件执行”（如只在真 PostgreSQL 上运行）。
// - 标题里的写法 AC-TRF-01/37/45、AC-PRM-03~07/17、AC-TRF-13 / 14 都会展开。
// - 人工备注（配置 notes）可把状态改为“部分覆盖 / 未覆盖”并写原因与分类；evidence 把标题里没写编号的用例
//   指认为证据，脚本会校验该用例确实存在，找不到即报“映射失效”。
// - 定义来源：配置 definitions 中的 Markdown 文件或目录里、首列为单个 AC 编号的表格行。
// - 配置中的路径缺省相对仓库根；配置写了 root 时相对配置文件所在目录。
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BEGIN = '<!-- ac-coverage:begin -->';
const END = '<!-- ac-coverage:end -->';
const STATUSES = ['已覆盖', '部分覆盖', '未覆盖', '未定义'];
const ID_PATTERN = /AC-([A-Z][A-Z0-9]*)-(\d{2,3})((?:\s*[/~～]\s*\d{2,3}(?!\d))*)/g;

/** 把标题或配置里的 AC 写法展开成编号列表：AC-FWD-01~07/12 → 01…07、12。 */
export function extractIds(text) {
  const ids = new Set();
  for (const match of text.matchAll(ID_PATTERN)) {
    const [, group, firstText, rest] = match;
    const width = firstText.length;
    let previous = Number(firstText);
    ids.add(format(group, previous, width));
    for (const token of rest.matchAll(/\s*([/~～])\s*(\d{2,3})/g)) {
      const value = Number(token[2]);
      if (token[1] === '/') ids.add(format(group, value, width));
      else for (let n = previous + 1; n <= value; n++) ids.add(format(group, n, width));
      previous = value;
    }
  }
  return [...ids];
}

const format = (group, n, width) => `AC-${group}-${String(n).padStart(width, '0')}`;

/** 稳定排序：先按模块，再按序号。 */
export function compareIds(a, b) {
  const [, ga, na] = a.match(/^AC-(.+)-(\d+)$/);
  const [, gb, nb] = b.match(/^AC-(.+)-(\d+)$/);
  return ga === gb ? Number(na) - Number(nb) : ga.localeCompare(gb);
}

function listFiles(path, accept) {
  const stat = statSync(path);
  if (stat.isFile()) return accept(path) ? [path] : [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => listFiles(join(path, name), accept));
}

/** 定义：Markdown 表格首列恰为一个 AC 编号（可带括号说明）的行；同一编号取第一次出现的位置。 */
export function scanDefinitions(paths, root = ROOT) {
  const definitions = new Map();
  for (const file of paths.flatMap((p) => listFiles(resolve(root, p), (f) => f.endsWith('.md')))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const cell = line.match(/^\|\s*(AC-[A-Z][A-Z0-9]*-\d{2,3})(?:[（(][^|]*)?\s*\|/);
      if (cell && !definitions.has(cell[1])) definitions.set(cell[1], { file: relative(root, file), line: index + 1 });
    });
  }
  return definitions;
}

/** 解析调用链：describe / it / test 及其修饰（each、todo、skip、runIf …）。 */
function testCallee(expression) {
  if (ts.isIdentifier(expression))
    return ['describe', 'it', 'test'].includes(expression.text) ? { base: expression.text, mods: [] } : null;
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = testCallee(expression.expression);
    return inner && { ...inner, mods: [...inner.mods, expression.name.text] };
  }
  if (ts.isCallExpression(expression)) {
    const inner = testCallee(expression.expression);
    if (!inner) return null;
    const last = inner.mods.at(-1);
    return last === 'each' ? { ...inner, table: expression.arguments[0] } : inner;
  }
  return null;
}

/** 标题文本：字符串 / 模板（插值处记为 ${…}）；其他表达式取其中的字符串字面量。 */
function titleText(node, resolver) {
  if (!node) return '';
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((span) => '${…}' + span.literal.text).join('');
  return literals(node, resolver).join(' ');
}

/** 词法作用域：文件、块、函数（参数）、for 循环头、switch 的 case 块。 */
const isScope = (node) =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isModuleBlock(node) ||
  ts.isCaseBlock(node) ||
  ts.isFunctionLike(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node);

const OPAQUE = { opaque: true };
const isVar = (list) => (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;

/** 某个作用域直接声明的同名绑定：有初值的变量声明返回声明节点，参数 / 解构 / 导入 / 函数等记为不可读取初值。 */
function declarationsIn(scope, name) {
  const found = [];
  const bind = (nameNode, declaration) => {
    if (ts.isIdentifier(nameNode)) return void (nameNode.text === name && found.push(declaration ?? OPAQUE));
    for (const element of nameNode.elements ?? []) if (!ts.isOmittedExpression(element)) bind(element.name, null);
  };
  const fromList = (list) => list.declarations.forEach((d) => bind(d.name, ts.isIdentifier(d.name) ? d : null));
  if (ts.isFunctionLike(scope)) scope.parameters?.forEach((parameter) => bind(parameter.name, null));
  const head = scope.initializer;
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && head)
    if (ts.isVariableDeclarationList(head)) head.declarations.forEach((d) => bind(d.name, null));
  const statements = ts.isCaseBlock(scope) ? scope.clauses.flatMap((c) => c.statements) : (scope.statements ?? []);
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) fromList(statement.declarationList);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
      bind(statement.name, null);
    else if (ts.isImportDeclaration(statement)) importNames(statement).forEach((n) => bind(n, null));
  }
  if (ts.isSourceFile(scope) || (ts.isBlock(scope) && ts.isFunctionLike(scope.parent)))
    hoistedVars(scope).forEach((list) => fromList(list));
  return found;
}

function importNames(statement) {
  const clause = statement.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name);
  if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((e) => e.name));
  return names;
}

/** 嵌套块里的 var 声明提升到函数 / 文件作用域（不进入内层函数；直接语句已由调用方处理）。 */
function hoistedVars(scope) {
  const lists = [];
  const visit = (node, depth) => {
    if (ts.isFunctionLike(node)) return;
    if (depth > 0 && ts.isVariableDeclarationList(node) && isVar(node)) lists.push(node);
    ts.forEachChild(node, (child) => visit(child, ts.isBlock(child) || isScope(child) ? depth + 1 : depth));
  };
  ts.forEachChild(scope, (child) => visit(child, isScope(child) ? 1 : 0));
  return lists;
}

/** 从使用位置向外找声明：就近作用域优先；返回 { scope, declarations }，找不到返回 null。 */
function lookup(identifier) {
  for (let node = identifier.parent; node; node = node.parent) {
    if (!isScope(node)) continue;
    const declarations = declarationsIn(node, identifier.text);
    if (declarations.length) return { scope: node, declarations };
  }
  return null;
}

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** let / var 在其作用域内被重新赋值（按同一声明判断，不算内层同名遮蔽）。 */
function reassigned(scope, declaration) {
  let hit = false;
  const visit = (node) => {
    if (hit) return;
    const target = ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind) ? node.left : null;
    if (target && ts.isIdentifier(target) && target.text === declaration.name.text)
      hit = lookup(target)?.declarations[0] === declaration;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return hit;
}

/** 标识符解析器：返回声明的初值；无法静态确定（多处声明、被重新赋值）时记 problems 并返回 null。 */
function scopeResolver(source, relativeFile, problems) {
  return (identifier) => {
    const found = lookup(identifier);
    if (!found) return null;
    const [declaration] = found.declarations;
    let reason = null;
    if (found.declarations.length > 1) reason = `同一作用域有 ${found.declarations.length} 处声明`;
    else if (declaration === OPAQUE || !declaration.initializer) return null;
    else if (isVar(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const))
      if (reassigned(found.scope, declaration)) reason = '被重新赋值';
    if (!reason) return declaration;
    const line = source.getLineAndCharacterOfPosition(identifier.getStart(source)).line + 1;
    problems.push(
      `${relativeFile}:${line}：参数表标识符“${identifier.text}”无法静态确定（${reason}），其中的 AC 编号未计入`,
    );
    return null;
  };
}

/** 标识符是否为对变量的引用（排除属性名、声明名等）。 */
function isReference(identifier) {
  const parent = identifier.parent;
  if (!parent) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === identifier)
    return false;
  if (ts.isBindingElement(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent))
    return parent.initializer === identifier;
  return !(ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isPropertySignature(parent));
}

/** 表达式中可达的字符串字面量；标识符按词法作用域跟随其声明初值（防循环）。 */
function literals(node, resolver, seen = new Set()) {
  const found = [];
  const visit = (current) => {
    if (ts.isStringLiteralLike(current)) return void found.push(current.text);
    if (ts.isIdentifier(current) && isReference(current)) {
      const declaration = resolver(current);
      if (declaration && !seen.has(declaration)) {
        seen.add(declaration);
        visit(declaration.initializer);
      }
      return undefined;
    }
    ts.forEachChild(current, visit);
    return undefined;
  };
  visit(node);
  return found;
}

const modeOf = (mods, inherited) => {
  if (inherited === 'skip' || mods.includes('skip')) return 'skip';
  if (mods.includes('todo')) return 'todo';
  if (inherited === 'conditional' || mods.some((m) => m === 'runIf' || m === 'skipIf')) return 'conditional';
  return 'run';
};

/** 一个测试文件里的全部用例：完整标题、AC 编号、执行方式。 */
export function scanTestFile(file, root = ROOT, problems = []) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cases = [];
  const relativeFile = relative(root, file);
  const resolver = scopeResolver(source, relativeFile, problems);
  const visit = (node, stack) => {
    const callee = ts.isCallExpression(node) ? testCallee(node.expression) : null;
    if (!callee) return ts.forEachChild(node, (child) => visit(child, stack));
    const own = titleText(node.arguments[0], resolver);
    const placeholders = /\$\w|%[sidfjo#]|\$\{…\}/.test(own);
    const tableIds = callee.table && placeholders ? extractIds(literals(callee.table, resolver).join(' ')) : [];
    const frame = { title: own, ids: [...extractIds(own), ...tableIds], mode: modeOf(callee.mods, stack.mode) };
    if (callee.base === 'describe') {
      const next = { titles: [...stack.titles, own], ids: [...stack.ids, ...frame.ids], mode: frame.mode };
      node.arguments.slice(1).forEach((argument) => visit(argument, next));
      return undefined;
    }
    const ids = [...new Set([...stack.ids, ...frame.ids])].sort(compareIds);
    cases.push({ file: relativeFile, title: [...stack.titles, own].join(' > '), ids, mode: frame.mode });
    return undefined;
  };
  visit(source, { titles: [], ids: [], mode: 'run' });
  return cases;
}

export function scanTests(paths, root = ROOT, problems = []) {
  return paths
    .flatMap((p) => listFiles(resolve(root, p), (f) => /\.test\.(ts|tsx|mts|js|mjs)$/.test(f)))
    .flatMap((file) => scanTestFile(file, root, problems));
}

/** 展开配置里的分组范围；后面的分组不重复计入前面已有的编号。 */
export function expandGroups(groups) {
  const seen = new Set();
  return groups.map((group) => {
    const ids = group.include.flatMap((spec) => extractIds(spec)).filter((id) => !seen.has(id));
    ids.forEach((id) => seen.add(id));
    return { name: group.name, ids: [...new Set(ids)].sort(compareIds) };
  });
}

/** 人工映射：evidence 里每项 {file, title} 必须命中一个计覆盖的用例，否则记为映射失效。 */
function resolveEvidence(id, note, cases, problems) {
  const matched = [];
  for (const evidence of note?.evidence ?? []) {
    const hit = cases.filter(
      (c) =>
        c.mode !== 'todo' && c.mode !== 'skip' && c.file.endsWith(evidence.file) && c.title.includes(evidence.title),
    );
    if (hit.length === 0) problems.push(`${id}：人工映射失效（${evidence.file} 中找不到“${evidence.title}”）`);
    matched.push(...hit);
  }
  return matched;
}

function statusOf(id, defined, auto, mapped, note, problems) {
  if (!defined) return note?.status === '未覆盖' ? '未覆盖' : '未定义';
  if (note?.status) {
    if (!STATUSES.includes(note.status)) problems.push(`${id}：备注状态“${note.status}”不合法`);
    if (note.status === '已覆盖' && auto.length + mapped.length === 0)
      problems.push(`${id}：备注称已覆盖，但没有任何用例`);
    return note.status;
  }
  return auto.length + mapped.length > 0 ? '已覆盖' : '未覆盖';
}

/** 计算每条 AC 的覆盖结论；problems 收集映射失效、状态矛盾等需要人工处理的问题。 */
export function computeCoverage(config, root = ROOT) {
  const definitions = scanDefinitions(config.definitions, root);
  const problems = [];
  const cases = scanTests(config.tests, root, problems);
  const notes = config.notes ?? {};
  const groups = expandGroups(config.groups).map((group) => ({
    name: group.name,
    rows: group.ids.map((id) => {
      const counted = cases.filter((c) => c.ids.includes(id) && c.mode !== 'todo' && c.mode !== 'skip');
      const mapped = resolveEvidence(id, notes[id], cases, problems);
      const status = statusOf(id, definitions.get(id), counted, mapped, notes[id], problems);
      return {
        id,
        definedAt: definitions.get(id) ?? null,
        status,
        category: notes[id]?.category ?? null,
        note: notes[id]?.note ?? null,
        cases: counted.length,
        mappedCases: mapped.length,
        conditional: [...counted, ...mapped].some((c) => c.mode === 'conditional'),
        files: [...new Set([...counted, ...mapped].map((c) => c.file.split('/').at(-1)))].sort(),
      };
    }),
  }));
  for (const id of Object.keys(notes))
    if (!groups.some((g) => g.rows.some((r) => r.id === id))) problems.push(`${id}：备注不在任何分组范围内`);
  return { title: config.title, groups, problems, totals: totals(groups.flatMap((g) => g.rows)) };
}

function totals(rows) {
  const count = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
  const categories = {};
  for (const row of rows.filter((r) => r.status !== '已覆盖' && r.category))
    categories[`${row.status} · ${row.category}`] = (categories[`${row.status} · ${row.category}`] ?? 0) + 1;
  return {
    all: rows.length,
    ...count,
    mappedOnly: rows.filter((r) => r.status === '已覆盖' && r.cases === 0 && r.mappedCases > 0).length,
    categories,
  };
}

const cell = (text) =>
  String(text ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');

function summaryTable(result) {
  const lines = ['| 分组 | AC 条数 | 已覆盖 | 部分覆盖 | 未覆盖 | 未定义 |', '|---|---|---|---|---|---|'];
  for (const group of result.groups) {
    const t = totals(group.rows);
    lines.push(`| ${group.name} | ${t.all} | ${t.已覆盖} | ${t.部分覆盖} | ${t.未覆盖} | ${t.未定义} |`);
  }
  const t = result.totals;
  lines.push(`| **合计** | **${t.all}** | **${t.已覆盖}** | **${t.部分覆盖}** | **${t.未覆盖}** | **${t.未定义}** |`);
  return lines;
}

function categoryLines(result) {
  const entries = Object.entries(result.totals.categories).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return [];
  return ['', '| 状态 · 分类 | 条数 |', '|---|---|', ...entries.map(([k, v]) => `| ${k} | ${v} |`)];
}

function detailTable(group) {
  const lines = [
    `#### ${group.name}`,
    '',
    '| 编号 | 状态 | 用例数（标题含编号 / 人工映射） | 测试文件 | 定义位置 | 备注 |',
  ];
  lines.push('|---|---|---|---|---|---|');
  for (const row of group.rows) {
    const counts = `${row.cases} / ${row.mappedCases}${row.conditional ? '（含条件执行）' : ''}`;
    const files = row.files.slice(0, 4).join('、') + (row.files.length > 4 ? ` 等 ${row.files.length} 个` : '');
    const where = row.definedAt ? `${row.definedAt.file.split('/').at(-1)}:${row.definedAt.line}` : '—';
    const note = [row.category, row.note].filter(Boolean).join('：');
    lines.push(
      `| ${row.id} | ${row.status} | ${counts} | ${cell(files) || '—'} | ${cell(where)} | ${cell(note) || '—'} |`,
    );
  }
  return lines;
}

export function renderMarkdown(result, command) {
  const lines = [`> 由脚本生成，请勿手改：\`${command}\``, '', ...summaryTable(result), ...categoryLines(result)];
  if (result.totals.mappedOnly)
    lines.push('', `其中 ${result.totals.mappedOnly} 条的用例标题未写编号，靠人工映射（脚本已校验用例存在）计入。`);
  if (result.problems.length) lines.push('', '**需人工处理**：', ...result.problems.map((p) => `- ${p}`));
  for (const group of result.groups) lines.push('', ...detailTable(group));
  return lines.join('\n');
}

export function replaceBlock(report, generated) {
  const start = report.indexOf(BEGIN);
  const end = report.indexOf(END);
  if (start < 0 || end < start) throw new Error(`报告中缺少标记 ${BEGIN} … ${END}`);
  return `${report.slice(0, start + BEGIN.length)}\n${generated}\n${report.slice(end)}`;
}

function parseArgs(argv) {
  const args = { format: 'md' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['config', 'format', 'write', 'check'].includes(key)) throw new Error(`未知参数 ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  if (!args.config) throw new Error('缺少 --config <配置文件>');
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const configPath = resolve(ROOT, args.config);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // 配置里的路径缺省相对仓库根；配置写了 root 时相对配置文件所在目录（自测夹具用）。
  const result = computeCoverage(config, config.root ? resolve(dirname(configPath), config.root) : ROOT);
  if (args.format === 'json') return void process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const command = `node scripts/ac-coverage.mjs --config ${args.config} --write ${args.write ?? args.check ?? '<报告>'}`;
  const markdown = renderMarkdown(result, command);
  if (args.check) {
    const report = readFileSync(resolve(ROOT, args.check), 'utf8');
    const stale = replaceBlock(report, markdown) !== report;
    if (stale) process.stderr.write(`${args.check} 中的覆盖统计已过期，请用 --write 重新生成\n`);
    if (result.problems.length) process.stderr.write(`${result.problems.join('\n')}\n`);
    process.exitCode = stale || result.problems.length ? 1 : 0;
    return undefined;
  }
  if (args.write) {
    const path = resolve(ROOT, args.write);
    writeFileSync(path, replaceBlock(readFileSync(path, 'utf8'), markdown));
  } else process.stdout.write(`${markdown}\n`);
  if (result.problems.length) process.stderr.write(`需人工处理：\n${result.problems.join('\n')}\n`);
  return undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
