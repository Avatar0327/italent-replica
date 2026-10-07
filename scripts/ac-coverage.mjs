#!/usr/bin/env node
// AC 覆盖统计（派发规则 §6，DEC-221 后续）：扫描测试用例标题里的 AC 编号，对照追溯表与规格文档里定义的 AC，
// 结合人工备注算出“已定义 / 已覆盖 / 部分覆盖 / 未覆盖 / 未定义”，输出可嵌入报告的 Markdown 或 JSON。
//
// 用法：
//   node scripts/ac-coverage.mjs --config docs/05_验收/ac-coverage/R1.json            # 输出 Markdown
//   node scripts/ac-coverage.mjs --config <配置> --format json                          # 输出 JSON（供 R2 / R3 复用）
//   node scripts/ac-coverage.mjs --config <配置> --write docs/05_验收/R1_AC覆盖报告.md  # 改写报告中的标记块
//   node scripts/ac-coverage.mjs --config <配置> --check <报告>                         # 报告过期或有需人工处理项时退出 1
//
// 规则（DEC-245：只认白名单写法，认不出就报错，不对任何表达式求值）：
// - “用例”= describe / suite / it / test（含 .each / .for / .runIf / .skipIf / .concurrent）；
//   用例标题 = 各级 describe 标题 + 自身标题。
// - AC 编号只从三处读取：① 用例标题的字符串字面量；② .each / .for 的内联数组字面量；③ 同文件顶层 const 数组字面量
//   （全文对该名字没有任何重新赋值，也没有任何同名声明）。②③ 只在标题含 vitest 占位（$a、$0、%s 等）时读取，
//   且按 vitest 的格式化规则只读会进入标题的那些值。
// - 其他写法一律记入“需人工处理”（problems）、不计入覆盖，--check 因此失败：模板插值或非字面量标题；导入、参数、
//   catch、解构、let / var、非顶层声明的参数表；展开、拼接、函数调用生成的表；定义在辅助函数里的用例；vitest 别名
//   或命名空间导入、it.extend、把 it 当作值引用等。
// - it.todo / .skip 不计覆盖；runIf / skipIf 计覆盖并标“条件执行”（如只在真 PostgreSQL 上运行）。
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

const SUITES = new Set(['describe', 'suite']);
const TEST_FUNCTIONS = new Set([...SUITES, 'it', 'test']);
const TABLE_MODS = new Set(['each', 'for']);
// 与 vitest formatTitle 一致：%s 等（含 %%）按位置消耗参数，%# %$ 是序号；$a.b / $0 取参数的属性或下标。
const POSITIONAL = /%[sdjifoOc%]/g;
const ATTRIBUTE = /\$([$\p{ID_Continue}.]+)/gu;
const placeholderText = (title) => title.replace(/%[#$]/g, '');
const hasPlaceholder = (title) => /%[sdjifoOc%]|\$[$\p{ID_Continue}.]/u.test(placeholderText(title));

/** 解析调用链：describe / suite / it / test 及其修饰（each、for、todo、skip、runIf …）；带参数表时附 table。 */
function testCallee(expression) {
  if (ts.isIdentifier(expression))
    return TEST_FUNCTIONS.has(expression.text) ? { base: expression.text, mods: [] } : null;
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = testCallee(expression.expression);
    return inner && { ...inner, mods: [...inner.mods, expression.name.text] };
  }
  const tagged = ts.isTaggedTemplateExpression(expression);
  if (!tagged && !ts.isCallExpression(expression)) return null;
  const inner = testCallee(tagged ? expression.tag : expression.expression);
  if (!inner || !TABLE_MODS.has(inner.mods.at(-1))) return inner;
  return { ...inner, table: tagged ? expression.template : expression.arguments[0] };
}

const unwrap = (node) =>
  node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))
    ? unwrap(node.expression)
    : node;

const isPlainLiteral = (node) =>
  ts.isNumericLiteral(node) ||
  ts.isBigIntLiteral(node) ||
  [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind) ||
  (ts.isIdentifier(node) && node.text === 'undefined') ||
  (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));

/** 字面量里的全部字符串；遇到任何非字面量返回 { bad: 节点 }，不求值。 */
function literalTexts(node) {
  const texts = [];
  let bad = null;
  const visit = (raw) => {
    const current = unwrap(raw);
    if (bad) return;
    if (ts.isStringLiteralLike(current)) texts.push(current.text);
    else if (ts.isArrayLiteralExpression(current)) current.elements.forEach(visit);
    else if (ts.isObjectLiteralExpression(current))
      for (const p of current.properties)
        if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) visit(p.initializer);
        else bad ??= p;
    else if (!isPlainLiteral(current)) bad = current;
  };
  visit(node);
  return bad ? { bad } : { texts };
}

const KINDS = {
  [ts.SyntaxKind.SpreadElement]: '展开',
  [ts.SyntaxKind.SpreadAssignment]: '展开',
  [ts.SyntaxKind.ShorthandPropertyAssignment]: '简写属性',
  [ts.SyntaxKind.PropertyAssignment]: '计算属性名',
  [ts.SyntaxKind.CallExpression]: '函数调用',
  [ts.SyntaxKind.TemplateExpression]: '模板插值',
  [ts.SyntaxKind.BinaryExpression]: '运算或拼接',
  [ts.SyntaxKind.ArrowFunction]: '函数',
  [ts.SyntaxKind.FunctionExpression]: '函数',
  [ts.SyntaxKind.MethodDeclaration]: '方法',
};
const describeNode = (node) => (ts.isIdentifier(node) ? `标识符“${node.text}”` : (KINDS[node.kind] ?? '表达式'));

const isLiteralValue = (node) =>
  isPlainLiteral(node) ||
  ts.isStringLiteralLike(node) ||
  ts.isArrayLiteralExpression(node) ||
  ts.isObjectLiteralExpression(node);

/** 按 $a.b / $a.0 路径取到的值；路径上遇到展开、简写、非字面量等读不出的成员时返回该成员（随后报错）。 */
function pathValue(object, path) {
  let current = object;
  for (const key of path) {
    current = unwrap(current);
    if (ts.isArrayLiteralExpression(current) && /^\d+$/.test(key)) current = current.elements[Number(key)];
    else if (!ts.isObjectLiteralExpression(current)) return isLiteralValue(current) ? null : current;
    else {
      const member = current.properties.find(
        (p) => ts.isSpreadAssignment(p) || (p.name && (ts.isComputedPropertyName(p.name) || p.name.text === key)),
      );
      if (!member || !ts.isPropertyAssignment(member) || ts.isComputedPropertyName(member.name)) return member;
      current = member.initializer;
    }
    if (!current) return null;
  }
  return current;
}

/**
 * 一行参数里会出现在标题中的值（vitest formatTitle）：参数 = 数组行的各元素，或单个值；%s 等按位置取参数；
 * $0 取第 0 个参数；首个参数是对象时 $a.b 取其属性，不是对象时 $a 原样保留。读不出的值原样返回，由调用方报错。
 */
function referencedValues(row, title) {
  const current = unwrap(row);
  if (ts.isSpreadElement(current)) return [current];
  const items = ts.isArrayLiteralExpression(current) ? current.elements : [current];
  const template = placeholderText(title);
  const values = items.slice(0, template.match(POSITIONAL)?.length ?? 0);
  const first = unwrap(items[0]);
  for (const [, key] of template.replace(POSITIONAL, ' ').matchAll(ATTRIBUTE)) {
    if (/^\d+$/.test(key)) values.push(items[Number(key)]);
    if (first && ts.isObjectLiteralExpression(first)) values.push(pathValue(first, key.split('.')));
    else if (first && !isLiteralValue(first)) values.push(first);
  }
  return values.filter(Boolean);
}

const DECLARATIONS = new Set([
  ts.SyntaxKind.VariableDeclaration, // 含 catch 参数、for 循环变量
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);
const INCREMENTS = new Set([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]);
const isAssignment = (kind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** 赋值目标的外壳：解构赋值里的数组 / 对象字面量、括号、类型断言等。 */
const isTargetShell = (parent, node) =>
  ts.isArrayLiteralExpression(parent) ||
  ts.isObjectLiteralExpression(parent) ||
  ts.isParenthesizedExpression(parent) ||
  ts.isSpreadElement(parent) ||
  ts.isSpreadAssignment(parent) ||
  ts.isShorthandPropertyAssignment(parent) ||
  ts.isAsExpression(parent) ||
  ts.isSatisfiesExpression(parent) ||
  ts.isNonNullExpression(parent) ||
  (ts.isPropertyAssignment(parent) && parent.initializer === node);

/** 标识符是否被写入：= / += 等赋值（含解构赋值）、++ / --、for…of / for…in 的循环目标。 */
function isWritten(identifier) {
  for (let node = identifier; node.parent; node = node.parent) {
    const parent = node.parent;
    if (ts.isBinaryExpression(parent) && parent.left === node) return isAssignment(parent.operatorToken.kind);
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && INCREMENTS.has(parent.operator))
      return true;
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return true;
    if (!isTargetShell(parent, node)) return false;
  }
  return false;
}

/** 全文中与参数表同名、却不是单纯读取的位置（同名声明或写入）；不分析作用域，出现即算。 */
function conflictOf(source, declaration) {
  const name = declaration.name.text;
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name && node !== declaration.name) {
      const parent = node.parent;
      const what =
        DECLARATIONS.has(parent.kind) && parent.name === node ? '有同名声明' : isWritten(node) && '被重新赋值';
      if (what) found = { node, what };
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 参数表标识符：必须是同文件顶层 const 声明，且全文无同名声明、无重新赋值；否则报错并返回 null。 */
function topLevelTable(identifier, source, report) {
  const name = identifier.text;
  const declarations = source.statements
    .filter((s) => ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const)
    .flatMap((s) => s.declarationList.declarations)
    .filter((d) => ts.isIdentifier(d.name) && d.name.text === name && d.initializer);
  const conflict = declarations.length === 1 ? conflictOf(source, declarations[0]) : null;
  if (declarations.length !== 1) report(identifier, `参数表“${name}”不是同文件顶层 const 声明`);
  else if (conflict)
    report(identifier, `参数表“${name}”在本文件第 ${lineOf(source, conflict.node)} 行${conflict.what}`);
  else return unwrap(declarations[0].initializer);
  return null;
}

const lineOf = (source, node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** 参数表中会进入标题的 AC 编号；参数表或被引用的值不在白名单内时报错，整张表不计入。 */
function tableIds(table, title, source, report) {
  const named = ts.isIdentifier(table);
  const rows = named ? topLevelTable(table, source, report) : unwrap(table);
  if (!rows || !ts.isArrayLiteralExpression(rows)) {
    if (!named || rows) report(table, '参数表不是数组字面量');
    return [];
  }
  const texts = [];
  for (const value of rows.elements.flatMap((row) => referencedValues(row, title))) {
    const result = literalTexts(value);
    if (result.bad) {
      report(result.bad, `参数表含非字面量（${describeNode(result.bad)}）`);
      return [];
    }
    texts.push(...result.texts);
  }
  return extractIds(texts.join(' '));
}

/** 用例标题只认字符串字面量；模板插值与其他表达式报错，该标题不计入。 */
function titleOf(node, report) {
  if (ts.isStringLiteralLike(node)) return node.text;
  report(node, ts.isTemplateExpression(node) ? '用例标题含模板插值' : '用例标题不是字符串字面量');
  return '';
}

/** 从 vitest 以别名或命名空间导入用例函数时，脚本认不出这些用例。 */
function checkImports(source, report) {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'vitest') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) report(statement, '以命名空间导入 vitest');
    for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : [])
      if (element.propertyName && TEST_FUNCTIONS.has(element.propertyName.text))
        report(statement, `从 vitest 以别名导入“${element.propertyName.text}”`);
  }
}

/** 用例函数被当作值引用（如 const t = it、[it].forEach）：经由别名定义的用例认不出。 */
function isAliasedTestFunction(node) {
  if (!ts.isIdentifier(node) || !TEST_FUNCTIONS.has(node.text)) return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
    return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return false;
  if (parent.name === node && (DECLARATIONS.has(parent.kind) || ts.isPropertyAssignment(parent))) return false;
  return !(ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent));
}

/** 不是作为实参原地传入的函数（函数声明、赋给变量的函数等）：其中定义的用例，所在 describe 由调用处决定。 */
const helperName = (node) => {
  if (!ts.isFunctionLike(node) || !node.body) return null;
  if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)) return null;
  if (node.name) return node.name.getText();
  return ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : '匿名函数';
};

const modeOf = (mods, inherited) => {
  if (inherited === 'skip' || mods.includes('skip')) return 'skip';
  if (mods.includes('todo')) return 'todo';
  if (inherited === 'conditional' || mods.some((m) => m === 'runIf' || m === 'skipIf')) return 'conditional';
  return 'run';
};

/** 一个测试文件里的全部用例：完整标题、AC 编号、执行方式；认不出的写法记入 problems（DEC-245）。 */
export function scanTestFile(file, root = ROOT, problems = []) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const relativeFile = relative(root, file);
  const report = (node, message) =>
    problems.push(`${relativeFile}:${lineOf(source, node)}：${message}，其中的 AC 编号未计入（DEC-245 白名单）`);
  checkImports(source, report);
  const cases = [];
  const visit = (node, stack) => {
    if (isAliasedTestFunction(node)) report(node, `用例函数“${node.text}”被当作值引用`);
    const callee = ts.isCallExpression(node) ? testCallee(node.expression) : null;
    if (!callee) {
      const helper = helperName(node);
      return ts.forEachChild(node, (child) => visit(child, helper ? { ...stack, helper } : stack));
    }
    if (callee.mods.includes('extend')) return void report(node, `自定义用例函数（${callee.base}.extend）`);
    if (stack.helper) return void report(node, `用例定义在函数“${stack.helper}”中，所在 describe 无法静态确定`);
    const own = node.arguments[0] ? titleOf(node.arguments[0], report) : '';
    const fromTable =
      'table' in callee && hasPlaceholder(own) ? tableIds(callee.table ?? node, own, source, report) : [];
    const frame = { ids: [...extractIds(own), ...fromTable], mode: modeOf(callee.mods, stack.mode) };
    if (SUITES.has(callee.base)) {
      const next = { ...stack, titles: [...stack.titles, own], ids: [...stack.ids, ...frame.ids], mode: frame.mode };
      node.arguments.slice(1).forEach((argument) => visit(argument, next));
      return undefined;
    }
    const ids = [...new Set([...stack.ids, ...frame.ids])].sort(compareIds);
    cases.push({ file: relativeFile, title: [...stack.titles, own].join(' > '), ids, mode: frame.mode });
    return undefined;
  };
  visit(source, { titles: [], ids: [], mode: 'run', helper: null });
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
