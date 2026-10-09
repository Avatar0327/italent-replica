/**
 * 显式表的证据校验（F-039 PR-A 第 4 轮，DEC-348② 补充 1）：每条义务的证据指向源码单元（函数 / 常量 / 方法 /
 * 某条注册的处理函数），锚点必须出现在单元里；每个单元登记一份规范化摘要（required/digests.ts），单元一改摘要
 * 就不一致（EVIDENCE_STALE），开发须复核受影响的义务后再更新摘要（`ROUTE_POLICY_UPDATE_DIGESTS=1` 只改摘要，
 * 不改义务）。证据覆盖强制调用点、授权实现与决定实参的常量三处，任一处变化都要求复核。
 * 锚点存在不是语义证明：权限键与源码实参是否一致由人工审定。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Finding } from './compare.js';
import { DIGESTS } from './required/digests.js';
import type { Digests, Obligation, RequiredTable } from './required/types.js';

export type SourceReader = (file: string) => string;

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

const digestOf = (text: string) => createHash('sha256').update(normalize(text)).digest('hex').slice(0, 12);

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

/** 在 file 里找单元：`a>b` 表示 a 内部的 b；末段 `route:GET /p` 表示该注册调用（路径按注册处求值）。 */
export function unitText(read: SourceReader, unit: string): string {
  const [file = '', name = ''] = unit.split('#');
  if (!file || !name) throw new Error(`证据单元格式应为 文件#名字：${unit}`);
  if (/(^|\/)(app-)?policy\.ts$/.test(file)) throw new Error(`证据不得指向登记表文件：${unit}`);
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2022, true);
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
      if (scope === sf) ts.forEachChild(sf, visit);
      else ts.forEachChild(scope, visit);
    }
    scopes = hits;
  }
  if (scopes.length !== 1) throw new Error(`证据单元 ${unit} ${scopes.length ? '不唯一' : '不存在'}`);
  return scopes[0]!.getText(sf);
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
  /** 是否报登记了却没被引用的摘要（全表校验时开）。 */
  readonly unused?: boolean;
}

const identity = (o: Obligation) => `${o.perm}|${o.purpose ?? 'admission'}|${o.or ?? ''}`;

/** 全部被引用的单元 → 当前摘要。 */
export function currentDigests(table: RequiredTable, read: SourceReader = repoSource): Record<string, string> {
  const units = new Set(
    Object.values(table).flatMap((obligations) => obligations.flatMap((o) => o.at.map((e) => e.unit))),
  );
  return Object.fromEntries([...units].sort().map((unit) => [unit, digestOf(unitText(read, unit))]));
}

/** 只重写摘要文件（复核义务之后；不改义务本身）。 */
export function writeDigests(table: RequiredTable): void {
  const byFile = new Map<string, string[]>();
  for (const [unit, digest] of Object.entries(currentDigests(table))) {
    const [file, name] = splitUnit(unit);
    byFile.set(file, [...(byFile.get(file) ?? []), `    '${name.replaceAll("'", "\\'")}': '${digest}',`]);
  }
  const lines = [...byFile].flatMap(([file, names]) => [`  '${file}': {`, ...names, '  },']);
  writeFileSync(
    DIGESTS_PATH,
    [
      '/**',
      ' * 证据单元的规范化摘要（evidence.ts）。单元一改即 EVIDENCE_STALE：先复核引用它的义务，再用',
      ' * `ROUTE_POLICY_UPDATE_DIGESTS=1` 重写本文件（只改摘要，不改义务），摘要 diff 随 PR 评审。',
      ' */',
      "import type { Digests } from './types.js';",
      '',
      'export const DIGESTS: Digests = {',
      ...lines,
      '};',
      '',
    ].join('\n'),
  );
}

export function checkEvidence(table: RequiredTable, options: EvidenceOptions = {}): Finding[] {
  const read = options.read ?? repoSource;
  const digests = options.digests ?? DIGESTS;
  const findings: Finding[] = [];
  const users = new Map<string, string[]>();
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
      if (seen.has(identity(o))) report('TABLE_CONFLICT', '权限 + 用途 + 承载者完全相同的义务重复登记');
      seen.add(identity(o));
      if (!o.at.some((e) => e.role === 'call')) report('EVIDENCE_MISSING', '缺强制调用点证据（call）');
      for (const e of o.at) {
        users.set(e.unit, [...(users.get(e.unit) ?? []), `${key} ${o.perm}`]);
        const text = textOf(e.unit);
        if (text instanceof Error) report('EVIDENCE_UNIT', text.message);
        else if (!containsAnchor(text, e.anchor)) {
          report('EVIDENCE_ANCHOR', `锚点「${e.anchor}」不在 ${e.unit} 里`);
        }
      }
    }
  }
  for (const [unit, refs] of users) {
    const text = textOf(unit);
    if (text instanceof Error) continue;
    const digest = digestOf(text);
    if (digestIn(digests, unit) === digest) continue;
    findings.push({
      route: refs[0]!.split(' ').slice(0, 2).join(' '),
      code: 'EVIDENCE_STALE',
      detail: `${unit} ${digestIn(digests, unit) ? '已变化' : '未登记摘要'}，复核引用它的 ${refs.length} 条义务：${refs.join('；')}`,
    });
  }
  if (options.unused) {
    const units = Object.entries(digests).flatMap(([file, names]) =>
      Object.keys(names).map((name) => `${file}#${name}`),
    );
    for (const unit of units.filter((u) => !users.has(u))) {
      findings.push({ route: '*', code: 'EVIDENCE_UNUSED', detail: `摘要 ${unit} 没有被任何证据引用` });
    }
  }
  return findings;
}
