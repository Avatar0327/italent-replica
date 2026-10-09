/**
 * 显式表的证据校验（F-039 PR-A 第 4 轮，DEC-348② 补充 1）：每条义务的证据指向源码单元（函数 / 常量 / 方法 /
 * 某条注册的处理函数），锚点必须出现在单元里；每个单元登记一份规范化摘要（required/digests.ts），单元一改摘要
 * 就不一致（EVIDENCE_STALE），开发须复核受影响的义务后再更新摘要（`ROUTE_POLICY_UPDATE_DIGESTS=1` 只改摘要，
 * 不改义务）。证据覆盖强制调用点、授权实现与决定实参的常量三处，任一处变化都要求复核。
 * 锚点存在不是语义证明：权限键与源码实参是否一致由人工审定。
 * PR-B2（设计 B-02 / B-04）：每个证据单元再求依赖闭包（evidence-closure.ts，算到不动点），依赖摘要变化或依赖集合增减
 * 报 EVIDENCE_STALE（明细写依赖链与受影响义务），解析不了的报 EVIDENCE_CLOSURE_UNRESOLVED；R9 去重键加调用点；
 * 选择器绑定的两张表（branch-inputs.ts / domains.ts）的证据同样进摘要与闭包。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Finding } from './compare.js';
import { BRANCH_BINDINGS, type BranchBindings } from './domains.js';
import { type BoundaryEntry, EVIDENCE_BOUNDARY, inBoundary } from './evidence-boundary.js';
import {
  type Closure,
  closureOf,
  createClosureEnv,
  type SourceReader,
  sourceFileOf,
  type Unresolved,
} from './evidence-closure.js';
import { DEPENDENCIES, DIGESTS } from './required/digests.js';
import type { Digests, Evidence, Obligation, RequiredTable } from './required/types.js';

export type { SourceReader } from './evidence-closure.js';

/** 证据单元 → 依赖单元 → 依赖摘要（required/digests.ts 的 DEPENDENCIES 段，B-02）。 */
export type Dependencies = Readonly<Record<string, Readonly<Record<string, string>>>>;

const ROOT = process.cwd();
const DIGESTS_PATH = path.resolve(ROOT, 'tests/acceptance/support/route-policy/required/digests.ts');
const cache = new Map<string, string>();

/** 仓库相对路径读源码（缓存）。 */
export const repoSource: SourceReader = (file) => {
  let text = cache.get(file);
  if (text === undefined) {
    text = readFileSync(path.resolve(ROOT, file), 'utf8');
    cache.set(file, text);
  }
  return text;
};

/** 锚点是否出现在单元里：按词法记号序列比较；锚点落在字符串 / 模板（如 SQL）里时，按该字面量空白折叠后的文本比较。 */
export function containsAnchor(unit: string, anchor: string): boolean {
  if (normalize(unit).includes(normalize(anchor))) return true;
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const wanted = collapse(anchor);
  return tokens(unit).some((token) => /^['"`}]/.test(token) && collapse(token).includes(wanted));
}

/** 词法记号序列（跳过空白与注释；模板字符串按片段重扫），用空格连接。 */
export function normalize(text: string): string {
  return tokens(text).join(' ');
}

function tokens(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, ts.LanguageVariant.Standard, text);
  const out: string[] = [];
  const stack: ('brace' | 'template')[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && stack.at(-1) === 'template') {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) stack.pop();
    } else if (kind === ts.SyntaxKind.OpenBraceToken) stack.push('brace');
    else if (kind === ts.SyntaxKind.CloseBraceToken) stack.pop();
    else if (kind === ts.SyntaxKind.TemplateHead) stack.push('template');
    else if (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) {
      const previous = out.at(-1) ?? '';
      if (!/^[\w$)\]]/.test(previous.slice(-1)) || /^(return|typeof|case|in|of)$/.test(previous)) {
        kind = scanner.reScanSlashToken();
      }
    }
    out.push(scanner.getTokenText());
  }
  return out;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function nameOf(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return undefined;
}

/** 在 node 所在的作用域链里找 `const name = …` 的初始化表达式，或 `for (const name of […])` 的取值列表。 */
function lookup(node: ts.Node, name: string): ts.Expression | readonly ts.Expression[] | undefined {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (ts.isForOfStatement(scope) && ts.isVariableDeclarationList(scope.initializer)) {
      const declared = scope.initializer.declarations[0]?.name;
      let iterable = scope.expression;
      while (ts.isAsExpression(iterable) || ts.isParenthesizedExpression(iterable)) iterable = iterable.expression;
      if (declared && ts.isIdentifier(declared) && declared.text === name && ts.isArrayLiteralExpression(iterable)) {
        return iterable.elements;
      }
    }
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : undefined;
    for (const statement of statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
      }
    }
  }
  return undefined;
}

/**
 * 注册路径求值（全部可能取值）：字符串、模板字符串、作用域链里的字符串常量（`${BASE}/plans`、`${path}/:id`），
 * 以及 for…of 字面量数组绑定的循环变量（`/api/tenant/job/${kind}/sync-sequence`）。
 */
function pathsOf(node: ts.Node | readonly ts.Expression[] | undefined, depth = 0): string[] {
  if (!node || depth > 5) return [];
  if (Array.isArray(node)) return (node as readonly ts.Expression[]).flatMap((n) => pathsOf(n, depth + 1));
  const one = node as ts.Node;
  if (ts.isStringLiteral(one) || ts.isNoSubstitutionTemplateLiteral(one)) return [one.text];
  if (ts.isIdentifier(one)) return pathsOf(lookup(one, one.text), depth + 1);
  if (ts.isTemplateExpression(one)) {
    let out = [one.head.text];
    for (const span of one.templateSpans) {
      const values = pathsOf(span.expression, depth + 1);
      out = out.flatMap((prefix) => values.map((value) => prefix + value + span.literal.text));
    }
    return out;
  }
  return [];
}

/** `METHOD 路径` 的注册调用（`x.get('/p', …)` 或 `x.on('GET', '/p', …)`）。 */
function isRoute(node: ts.Node, method: string, routePath: string): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const name = node.expression.name.text;
  if (METHODS.has(name)) return name.toUpperCase() === method && pathsOf(node.arguments[0]).includes(routePath);
  if (name !== 'on') return false;
  return (
    pathsOf(node.arguments[0]).some((m) => m.toUpperCase() === method) && pathsOf(node.arguments[1]).includes(routePath)
  );
}

/** 在文件里找单元节点：`a>b` 表示 a 内部的 b；末段 `route:GET /p` 表示该注册调用（路径按注册处求值）。 */
export function findUnitNode(sf: ts.SourceFile, unit: string, name: string): ts.Node {
  let scopes: ts.Node[] = [sf];
  for (const part of name.split('>')) {
    const route = /^route:(\w+) (.+)$/.exec(part);
    const hits: ts.Node[] = [];
    for (const scope of scopes) {
      const visit = (node: ts.Node) => {
        const hit = route ? isRoute(node, route[1]!, route[2]!) : node !== scope && nameOf(node) === part;
        if (hit) hits.push(node);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(scope, visit);
    }
    scopes = hits;
  }
  if (scopes.length !== 1) throw new Error(`证据单元 ${unit} ${scopes.length ? '不唯一' : '不存在'}`);
  return scopes[0]!;
}

export function unitText(read: SourceReader, unit: string): string {
  const [file = '', name = ''] = unit.split('#');
  if (!file || !name) throw new Error(`证据单元格式应为 文件#名字：${unit}`);
  if (/(^|\/)(app-)?policy\.ts$/.test(file)) throw new Error(`证据不得指向登记表文件：${unit}`);
  const sf = sourceFileOf(read, file);
  return findUnitNode(sf, unit, name).getText(sf);
}

const splitUnit = (unit: string): [string, string] => {
  const at = unit.indexOf('#');
  return [unit.slice(0, at), unit.slice(at + 1)];
};
const digestIn = (digests: Digests, unit: string) => {
  const [file, name] = splitUnit(unit);
  return digests[file]?.[name];
};

export interface EvidenceOptions {
  readonly read?: SourceReader;
  readonly digests?: Digests;
  /** 依赖闭包的登记（缺省 = required/digests.ts 的 DEPENDENCIES）。 */
  readonly dependencies?: Dependencies;
  /** 闭包边界（缺省 = evidence-boundary.ts）。 */
  readonly boundary?: readonly BoundaryEntry[];
  /** 选择器绑定两张表的证据（缺省 = 真实登记；false = 不校验，供夹具）。 */
  readonly branch?: BranchBindings | false;
  /** 是否报登记了却没被引用的摘要与依赖登记（全表校验时开）。 */
  readonly unused?: boolean;
}

/** R9 去重键（B-04）：权限 + 用途 + 承载者 + 排序后的（调用点单元, 调用点锚点）。同函数同锚点视为同一判定。 */
const identity = (o: Obligation) => {
  const calls = o.at
    .filter((e) => e.role === 'call')
    .map((e) => `${e.unit}@${normalize(e.anchor)}`)
    .sort();
  return `${o.perm}|${o.purpose ?? 'admission'}|${o.or ?? ''}|${calls.join(';')}`;
};

export interface Use {
  /** 报告里的端点标签（Finding.route）。 */
  readonly route: string;
  /** 复核清单里的一条（义务 / 登记项）。 */
  readonly label: string;
}

interface BranchUse extends Use {
  readonly evidence: Evidence;
}

/** 选择器绑定表里的全部证据（输入来源按端点 × 位置，分支值按域 × 字段）。 */
function branchUses(branch: BranchBindings | false): BranchUse[] {
  if (!branch) return [];
  const inputs = Object.entries(branch.inputs).flatMap(([key, entries]) =>
    entries.flatMap((input) =>
      input.at.map((evidence) => ({ route: key, label: `输入来源 @${input.position}`, evidence })),
    ),
  );
  const values = Object.entries(branch.values).flatMap(([domain, entries]) =>
    entries.flatMap((entry) =>
      entry.at.map((evidence) => ({
        route: `分支值 ${domain}`,
        label: `分支值 ${domain}/${entry.field}${entry.variant ? `#${entry.variant}` : ''}`,
        evidence,
      })),
    ),
  );
  return [...inputs, ...values];
}

/** 证据单元 → 引用它的义务 / 登记项（含选择器绑定表）。 */
export function usesOf(table: RequiredTable, branch: BranchBindings | false = BRANCH_BINDINGS): Map<string, Use[]> {
  const users = new Map<string, Use[]>();
  const push = (unit: string, use: Use) => users.set(unit, [...(users.get(unit) ?? []), use]);
  for (const [key, obligations] of Object.entries(table)) {
    for (const o of obligations) for (const e of o.at) push(e.unit, { route: key, label: `${key} ${o.perm}` });
  }
  for (const { evidence, ...use } of branchUses(branch)) push(evidence.unit, use);
  return users;
}

const digestCache = new Map<string, string>();
/** 规范化摘要（按文本缓存：闭包里同一个依赖会出现在几百个单元的闭包里）。 */
const digestOf = (text: string) => {
  let digest = digestCache.get(text);
  if (digest === undefined) {
    digest = createHash('sha256').update(normalize(text)).digest('hex').slice(0, 12);
    digestCache.set(text, digest);
  }
  return digest;
};

/** 全部被引用的单元 → 当前摘要（含选择器绑定表的证据单元）。 */
export function currentDigests(
  table: RequiredTable,
  read: SourceReader = repoSource,
  branch: BranchBindings | false = BRANCH_BINDINGS,
): Record<string, string> {
  const units = [...usesOf(table, branch).keys()].sort();
  return Object.fromEntries(units.map((unit) => [unit, digestOf(unitText(read, unit))]));
}

/** 同 currentDigests，但按 文件 → 单元名 → 摘要 分组（与 DIGESTS 同形，供 checkEvidence 的 digests 选项）。 */
export function currentDigestTable(
  table: RequiredTable,
  read: SourceReader = repoSource,
  branch: BranchBindings | false = BRANCH_BINDINGS,
): Digests {
  const byFile: Record<string, Record<string, string>> = {};
  for (const [unit, digest] of Object.entries(currentDigests(table, read, branch))) {
    const [file, name] = splitUnit(unit);
    (byFile[file] ??= {})[name] = digest;
  }
  return byFile;
}

const envs = new WeakMap<SourceReader, Map<readonly BoundaryEntry[], ReturnType<typeof createClosureEnv>>>();
/** 同一个读取器 + 同一份边界复用解析与边的缓存（repoSource 全程不变；测试里打补丁的读取器各用各的）。 */
function closureEnvFor(read: SourceReader, boundary: readonly BoundaryEntry[]) {
  let byBoundary = envs.get(read);
  if (!byBoundary) envs.set(read, (byBoundary = new Map()));
  let env = byBoundary.get(boundary);
  if (!env) byBoundary.set(boundary, (env = createClosureEnv(read, boundary, findUnitNode)));
  return env;
}

function closuresOf(
  units: Iterable<string>,
  read: SourceReader,
  boundary: readonly BoundaryEntry[],
): Map<string, Closure | Error> {
  const env = closureEnvFor(read, boundary);
  const out = new Map<string, Closure | Error>();
  for (const unit of units) {
    try {
      out.set(unit, closureOf(env, unit));
    } catch (error) {
      out.set(unit, error as Error);
    }
  }
  return out;
}

const depDigests = (closure: Closure): Record<string, string> =>
  Object.fromEntries(
    [...closure.deps].sort(([a], [b]) => a.localeCompare(b)).map(([dep, text]) => [dep, digestOf(text)]),
  );

/** 全部被引用的单元 → 依赖单元 → 依赖摘要（B-02 的 DEPENDENCIES）。 */
export function currentDependencies(
  table: RequiredTable,
  read: SourceReader = repoSource,
  branch: BranchBindings | false = BRANCH_BINDINGS,
  boundary: readonly BoundaryEntry[] = EVIDENCE_BOUNDARY,
): Record<string, Record<string, string>> {
  const closures = closuresOf([...usesOf(table, branch).keys()].sort(), read, boundary);
  return Object.fromEntries(
    [...closures].map(([unit, closure]) => {
      if (closure instanceof Error) throw closure;
      return [unit, depDigests(closure)];
    }),
  );
}

export interface ClosureReport {
  readonly unit: string;
  readonly size: number;
  readonly depth: number;
  readonly unresolved: readonly Unresolved[];
  readonly deps: Readonly<Record<string, string>>;
}

/** 每个单元的闭包大小、最大深度、unresolved（供测试输出与 PR 描述引用）。 */
export function closureReports(
  table: RequiredTable,
  read: SourceReader = repoSource,
  branch: BranchBindings | false = BRANCH_BINDINGS,
  boundary: readonly BoundaryEntry[] = EVIDENCE_BOUNDARY,
): ClosureReport[] {
  const closures = closuresOf([...usesOf(table, branch).keys()].sort(), read, boundary);
  return [...closures].flatMap(([unit, closure]) =>
    closure instanceof Error
      ? []
      : [
          {
            unit,
            size: closure.deps.size,
            depth: closure.depth,
            unresolved: closure.unresolved,
            deps: depDigests(closure),
          },
        ],
  );
}

/** 只重写摘要文件（复核义务之后；不改义务）：证据单元摘要 + 依赖闭包登记。 */
export function writeDigests(table: RequiredTable): void {
  const byFile = new Map<string, string[]>();
  for (const [unit, digest] of Object.entries(currentDigests(table))) {
    const [file, name] = splitUnit(unit);
    byFile.set(file, [...(byFile.get(file) ?? []), `    '${name.replaceAll("'", "\\'")}': '${digest}',`]);
  }
  const lines = [...byFile].flatMap(([file, names]) => [`  '${file}': {`, ...names, '  },']);
  const deps = Object.entries(currentDependencies(table)).flatMap(([unit, entries]) => [
    `  '${unit.replaceAll("'", "\\'")}': {`,
    ...Object.entries(entries).map(([dep, digest]) => `    '${dep.replaceAll("'", "\\'")}': '${digest}',`),
    '  },',
  ]);
  writeFileSync(
    DIGESTS_PATH,
    [
      '/**',
      ' * 证据单元的规范化摘要与依赖闭包登记（evidence.ts）。单元一改即 EVIDENCE_STALE：先复核引用它的义务，再用',
      ' * `ROUTE_POLICY_UPDATE_DIGESTS=1` 重写本文件（只改摘要，不改义务），摘要 diff 随 PR 评审。',
      ' * DEPENDENCIES：证据单元 → 依赖单元 → 依赖摘要（B-02，闭包算到不动点；边界见 evidence-boundary.ts）。',
      ' */',
      '/* eslint-disable max-len -- 生成文件，单元键含完整路由路径 */',
      "import type { Digests } from './types.js';",
      '',
      'export const DIGESTS: Digests = {',
      ...lines,
      '};',
      '',
      'export const DEPENDENCIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {',
      ...deps,
      '};',
      '',
    ].join('\n'),
  );
}

const labels = (uses: readonly Use[]) => uses.map((use) => use.label).join('；');

const MODULES = 'apps/api/src/modules/';

/** modules/** 下且不在边界内的未解析项才报（设计 B-02 第 2 点）。 */
const reportable = (item: Unresolved, boundary: readonly BoundaryEntry[]) =>
  item.file.startsWith(MODULES) && !inBoundary(item.file, boundary);

function checkDependencies(
  closure: Closure,
  registered: Readonly<Record<string, string>> | undefined,
  uses: readonly Use[],
): { stale?: string; unresolved: Unresolved[] } {
  const current = depDigests(closure);
  const changes: string[] = [];
  const chain = (dep: string) => closure.chains.get(dep)?.join(' → ') ?? dep;
  if (!registered) changes.push('依赖闭包没有登记');
  else {
    for (const [dep, digest] of Object.entries(current)) {
      if (!registered[dep]) changes.push(`新增依赖 ${dep}（链：${chain(dep)}）`);
      else if (registered[dep] !== digest) changes.push(`依赖 ${dep} 已变化（链：${chain(dep)}）`);
    }
    for (const dep of Object.keys(registered)) if (!current[dep]) changes.push(`依赖 ${dep} 不再被引用`);
  }
  const shown = changes.slice(0, 5).join('；') + (changes.length > 5 ? `；……共 ${changes.length} 处` : '');
  const review = `复核引用 ${closure.unit} 的 ${uses.length} 条义务：${labels(uses)}`;
  return {
    ...(changes.length ? { stale: `${closure.unit} 的${shown}。${review}` } : {}),
    unresolved: [...closure.unresolved],
  };
}

export function checkEvidence(table: RequiredTable, options: EvidenceOptions = {}): Finding[] {
  const read = options.read ?? repoSource;
  const digests = options.digests ?? DIGESTS;
  const dependencies = options.dependencies ?? DEPENDENCIES;
  const boundary = options.boundary ?? EVIDENCE_BOUNDARY;
  const branch = options.branch === undefined ? BRANCH_BINDINGS : options.branch;
  const findings: Finding[] = [];
  const texts = new Map<string, string | Error>();
  const textOf = (unit: string) => {
    if (!texts.has(unit)) {
      try {
        texts.set(unit, unitText(read, unit));
      } catch (error) {
        texts.set(unit, error as Error);
      }
    }
    return texts.get(unit)!;
  };
  for (const [key, obligations] of Object.entries(table)) {
    const seen = new Set<string>();
    for (const o of obligations) {
      const report = (code: string, detail: string) =>
        findings.push({ route: key, code, detail: `${o.perm}：${detail}` });
      if (seen.has(identity(o))) report('TABLE_CONFLICT', '权限 + 用途 + 承载者 + 调用点完全相同的义务重复登记');
      seen.add(identity(o));
      if (!o.at.some((e) => e.role === 'call')) report('EVIDENCE_MISSING', '缺强制调用点证据（call）');
      for (const e of o.at) {
        const text = textOf(e.unit);
        if (text instanceof Error) report('EVIDENCE_UNIT', text.message);
        else if (!containsAnchor(text, e.anchor)) {
          report('EVIDENCE_ANCHOR', `锚点「${e.anchor}」不在 ${e.unit} 里`);
        }
      }
    }
  }
  for (const { evidence, route, label } of branchUses(branch)) {
    const text = textOf(evidence.unit);
    const report = (code: string, detail: string) => findings.push({ route, code, detail: `${label}：${detail}` });
    if (text instanceof Error) report('EVIDENCE_UNIT', text.message);
    else if (!containsAnchor(text, evidence.anchor)) {
      report('EVIDENCE_ANCHOR', `锚点「${evidence.anchor}」不在 ${evidence.unit} 里`);
    }
  }
  const users = usesOf(table, branch);
  const usable = [...users.keys()].filter((unit) => !(textOf(unit) instanceof Error));
  const closures = closuresOf(usable, read, boundary);
  for (const [unit, refs] of users) {
    const text = textOf(unit);
    if (text instanceof Error) continue;
    const digest = digestOf(text);
    const route = refs[0]!.route;
    if (digestIn(digests, unit) !== digest) {
      findings.push({
        route,
        code: 'EVIDENCE_STALE',
        detail: `${unit} ${digestIn(digests, unit) ? '已变化' : '未登记摘要'}，复核引用它的 ${refs.length} 条义务：${labels(refs)}`,
      });
    }
    const closure = closures.get(unit);
    if (!closure || closure instanceof Error) continue;
    const checked = checkDependencies(closure, dependencies[unit], refs);
    if (checked.stale) findings.push({ route, code: 'EVIDENCE_STALE', detail: checked.stale });
    for (const item of checked.unresolved.filter((u) => reportable(u, boundary))) {
      findings.push({
        route,
        code: 'EVIDENCE_CLOSURE_UNRESOLVED',
        detail: `${unit} 的依赖闭包有解析不了的项：${item.reason} ${item.detail}（${item.file}）`,
      });
    }
  }
  if (options.unused) {
    const units = Object.entries(digests).flatMap(([file, names]) =>
      Object.keys(names).map((name) => `${file}#${name}`),
    );
    for (const unit of units.filter((u) => !users.has(u))) {
      findings.push({ route: '*', code: 'EVIDENCE_UNUSED', detail: `摘要 ${unit} 没有被任何证据引用` });
    }
    for (const unit of Object.keys(dependencies).filter((u) => !users.has(u))) {
      findings.push({ route: '*', code: 'EVIDENCE_UNUSED', detail: `依赖登记 ${unit} 没有被任何证据引用` });
    }
  }
  return findings;
}
