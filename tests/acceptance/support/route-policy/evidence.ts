/**
 * 显式表的证据校验（F-039 PR-A 第 4 轮，DEC-348② 补充 1）：每条义务的证据指向源码单元（函数 / 常量 / 方法 /
 * 某条注册的处理函数），锚点必须出现在单元里；每个单元登记一份规范化摘要（required/digests/units.ts），单元一改摘要
 * 就不一致（EVIDENCE_STALE），开发须复核受影响的义务后再更新摘要（`ROUTE_POLICY_UPDATE_DIGESTS=1` 只改摘要，
 * 不改义务）。证据覆盖强制调用点、授权实现与决定实参的常量三处，任一处变化都要求复核。
 * 锚点存在不是语义证明：权限键与源码实参是否一致由人工审定。
 * PR-B2（设计 B-02 / B-04）：每个证据单元再求依赖闭包（evidence-closure.ts，算到不动点），依赖摘要变化或依赖集合增减
 * 报 EVIDENCE_STALE（明细写依赖链与受影响义务），解析不了的报 EVIDENCE_CLOSURE_UNRESOLVED；R9 去重键加调用点；
 * 选择器绑定的两张表（branch-inputs.ts / domains.ts）的证据同样进摘要与闭包。
 * F-072 PR-1：依赖登记改为“节点摘要表 + 直接依赖图”（required/digests/，结构见 evidence-graph.ts），闭包由登记图推出；
 * 图变或绑定指纹变而闭包不变也报 EVIDENCE_STALE；旧 required/digests.ts 回来报 LEGACY_DIGESTS_PRESENT。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Finding } from './compare.js';
import { BRANCH_BINDINGS, type BranchBindings } from './domains.js';
import { type BoundaryEntry, EVIDENCE_BOUNDARY, inBoundary } from './evidence-boundary.js';
import {
  type BindingLine,
  bindingsOf,
  type Closure,
  type ClosureEnv,
  closureOf,
  compareText,
  createClosureEnv,
  declText,
  edgeIds,
  explore,
  type SourceReader,
  sourceFileOf,
  type Unresolved,
} from './evidence-closure.js';
import { expandGraph, type Registry, renderRegistry } from './evidence-graph.js';
import { formatGroup, staleGroups, type Use } from './evidence-report.js';
import { DIGESTS, GRAPH, NODE_DIGESTS, UNIT_BINDINGS } from './required/digests/index.js';
import type { Digests, Evidence, Obligation, RequiredTable } from './required/types.js';

export type { SourceReader } from './evidence-closure.js';

/** 证据单元 → 依赖单元 → 依赖摘要（B-02 的平铺闭包；已不再登记，仅供等价核对与报告）。 */
export { renderRegistry };
export type { Use };
export type Dependencies = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** 当前提交的登记（required/digests/）。 */
export const REGISTRY: Registry = {
  units: DIGESTS,
  unitBindings: UNIT_BINDINGS,
  nodes: NODE_DIGESTS,
  graph: expandGraph(GRAPH),
};

const ROOT = process.cwd();
const REQUIRED_DIR = 'tests/acceptance/support/route-policy/required';
const DIGESTS_DIR = path.resolve(ROOT, REQUIRED_DIR, 'digests');
const LEGACY_DIGESTS = `${REQUIRED_DIR}/digests.ts`;
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
export interface EvidenceOptions {
  readonly read?: SourceReader;
  /** 证据单元摘要（缺省 = 登记里的 units）。 */
  readonly digests?: Digests;
  /** 依赖闭包的登记（缺省 = required/digests/）。 */
  readonly registry?: Registry;
  /** 旧 digests.ts 守卫检查的仓库根（缺省 = 当前目录；全表校验时带出）。 */
  readonly legacyRoot?: string;
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

interface BranchUse extends Use {
  readonly evidence: Evidence;
}

/** 选择器绑定表里的全部证据（输入来源按端点 × 位置，分支值按域 × 字段）。 */
function branchUses(branch: BranchBindings | false): BranchUse[] {
  if (!branch) return [];
  const inputs = Object.entries(branch.inputs).flatMap(([key, entries]) =>
    entries.flatMap((input) =>
      input.at.map((evidence) => ({ route: key, label: `${key} 输入来源 @${input.position}`, evidence })),
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
  const push = (unit: string, use: Use) => {
    const list = users.get(unit) ?? [];
    // 同一义务（或登记项）对同一单元的多条证据只算一次；标签带序号，同端点同权限的不同义务不会合并
    if (!list.some((existing) => existing.label === use.label)) users.set(unit, [...list, use]);
  };
  for (const [key, obligations] of Object.entries(table)) {
    for (const [index, o] of obligations.entries()) {
      for (const e of o.at) push(e.unit, { route: key, label: `${key} #${index + 1} ${o.perm}` });
    }
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

const envs = new WeakMap<SourceReader, Map<readonly BoundaryEntry[], ClosureEnv>>();
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

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const formatBinding = (line: BindingLine) => `${line.at}:${line.local} → ${line.resolved.join(' → ')}`;
/** 绑定指纹：按序的“局部标识符 → 解析链”清单的摘要；别名交换、转导出改指、遮蔽全局都会改变它（F-072 §2.3.2）。 */
const bindingDigest = (lines: readonly BindingLine[]) => sha(lines.map(formatBinding).join('\n'));

/** 由一组根（及其单元文本）算出的登记：全部可达依赖（不设层数上限，层数上限只作用于闭包推导）。 */
function registryFor(env: ClosureEnv, roots: readonly string[], texts: ReadonlyMap<string, string>): Registry {
  const graph: Record<string, readonly string[]> = {};
  const targets = new Set<string>();
  for (const id of explore(env, roots)) {
    const edges = edgeIds(env, id);
    if (edges.length) graph[id] = edges;
    for (const dep of edges) targets.add(dep);
  }
  const nodes = Object.fromEntries(
    [...targets].map((id) => [id, [digestOf(declText(env, id)), bindingDigest(bindingsOf(env, id))] as const]),
  );
  const unitBindings = Object.fromEntries(roots.map((unit) => [unit, bindingDigest(bindingsOf(env, unit))]));
  const units: Record<string, Record<string, string>> = {};
  for (const unit of roots) {
    const [file, name] = splitUnit(unit);
    (units[file] ??= {})[name] = digestOf(texts.get(unit)!);
  }
  return { units, unitBindings, nodes, graph };
}

/** 当前源码算出的登记（全部被引用的单元）。 */
export function currentRegistry(
  table: RequiredTable,
  read: SourceReader = repoSource,
  branch: BranchBindings | false = BRANCH_BINDINGS,
  boundary: readonly BoundaryEntry[] = EVIDENCE_BOUNDARY,
): Registry {
  const roots = [...usesOf(table, branch).keys()].sort(compareText);
  return registryFor(closureEnvFor(read, boundary), roots, new Map(roots.map((unit) => [unit, unitText(read, unit)])));
}

/** 只重写登记文件（复核义务之后；不改义务）：required/digests/ 下的 units.ts、nodes.ts、graph/*。 */
export function writeDigests(table: RequiredTable): void {
  const files = renderRegistry(currentRegistry(table));
  mkdirSync(path.join(DIGESTS_DIR, 'graph'), { recursive: true });
  for (const name of readdirSync(path.join(DIGESTS_DIR, 'graph'))) {
    if (!(`graph/${name}` in files)) rmSync(path.join(DIGESTS_DIR, 'graph', name));
  }
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(DIGESTS_DIR, name);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== text) writeFileSync(target, text);
  }
}

/** 旧的平铺 required/digests.ts 回来了（合并冲突时被保留 / 复活）：保留删除，用新生成器重算。 */
export function legacyDigestsFindings(root: string = ROOT): Finding[] {
  if (!existsSync(path.join(root, LEGACY_DIGESTS))) return [];
  return [
    {
      route: '*',
      code: 'LEGACY_DIGESTS_PRESENT',
      detail:
        `${LEGACY_DIGESTS} 不应存在：证据依赖登记已改为 required/digests/ 目录（F-072）。` +
        '合并时保留删除（git rm），再用 ROUTE_POLICY_UPDATE_DIGESTS=1 重新生成。',
    },
  ];
}

const MODULES = 'apps/api/src/modules/';

/** modules/** 下且不在边界内的未解析项才报（设计 B-02 第 2 点）。 */
const reportable = (item: Unresolved, boundary: readonly BoundaryEntry[]) =>
  item.file.startsWith(MODULES) && !inBoundary(item.file, boundary);

/** 登记了却没被引用的摘要、根、图节点（全表校验时开）。 */
function unusedRegistrations(
  env: ClosureEnv,
  usable: readonly string[],
  users: ReadonlyMap<string, readonly Use[]>,
  digests: Digests,
  registry: Registry,
): Finding[] {
  const reached = explore(env, usable);
  const unused = (detail: string): Finding => ({ route: '*', code: 'EVIDENCE_UNUSED', detail });
  const units = Object.entries(digests).flatMap(([file, names]) => Object.keys(names).map((name) => `${file}#${name}`));
  const roots = new Set([...Object.keys(registry.unitBindings), ...Object.keys(registry.graph)]);
  return [
    ...units.filter((unit) => !users.has(unit)).map((unit) => unused(`摘要 ${unit} 没有被任何证据引用`)),
    ...[...roots]
      .filter((id) => (id in registry.unitBindings ? !users.has(id) : !reached.has(id)))
      .map((id) => unused(`依赖登记 ${id} 没有被任何证据引用`)),
    ...Object.keys(registry.nodes)
      .filter((id) => !reached.has(id))
      .map((id) => unused(`依赖节点登记 ${id} 没有被任何证据引用`)),
  ];
}

export function checkEvidence(table: RequiredTable, options: EvidenceOptions = {}): Finding[] {
  const read = options.read ?? repoSource;
  const registry = options.registry ?? REGISTRY;
  const digests = options.digests ?? registry.units;
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
  const env = closureEnvFor(read, boundary);
  const texts2 = new Map(usable.map((unit) => [unit, textOf(unit) as string]));
  const current = registryFor(env, usable, texts2);
  const usableUses = new Map(usable.map((unit) => [unit, users.get(unit)!]));
  for (const group of staleGroups({ reg: { ...registry, units: digests }, cur: current, roots: usableUses })) {
    const bindings = (node: string) => bindingsOf(env, node).map(formatBinding).join(' | ') || '空';
    findings.push({ route: '*', code: 'EVIDENCE_STALE', detail: formatGroup(group, bindings), group });
  }
  for (const unit of usable) {
    const closure = closures.get(unit);
    if (!closure || closure instanceof Error) continue;
    const route = users.get(unit)![0]!.route;
    for (const item of closure.unresolved.filter((u) => reportable(u, boundary))) {
      findings.push({
        route,
        code: 'EVIDENCE_CLOSURE_UNRESOLVED',
        detail: `${unit} 的依赖闭包有解析不了的项：${item.reason} ${item.detail}（${item.file}）`,
      });
    }
  }
  if (options.unused)
    findings.push(
      ...unusedRegistrations(env, usable, users, digests, registry),
      ...legacyDigestsFindings(options.legacyRoot),
    );
  return findings;
}
