/**
 * 证据依赖闭包（F-039 PR-B2，设计 B-02）。证据单元只登记调用点、实现、常量本身的摘要，决定授权实参的函数
 * （360 `routeNeed → levelOf`）改了不报。这里对每个单元求依赖闭包：从单元文本出发逐层解析标识符，
 * - 同文件顶层函数 / 常量 / 类 / 枚举；
 * - 相对 import 指向的 `apps/api/src/**` 导出（含 `export … from` 与 `export *` 转发）；
 * - `@italent/<包>` 解析到 `packages/<包>/src/index.ts` 的声明（`@italent/domain` 等）；
 * 算到不动点（广度优先，同层按字典序，安全上限 MAX_DEPTH 层，带环检测）。不解析：注入依赖（`deps.*`、形参，由词法作用域排除）、纯类型、
 * 第三方包、边界清单内的文件（evidence-boundary.ts）。
 * 解析不了的写进 unresolved：动态 import / require、命名空间 import 的计算成员访问或整体外传、找不到的相对 import、
 * 触到层数上限且有依赖落在实际访问集合之外（depth-limit，F-072 D-8 ①：与遍历顺序无关）。判定“是否要报”在 evidence.ts（位于 modules/** 且不在边界内才报）。
 * 作用域是词法近似：局部同名变量遮蔽顶层声明时按局部处理，不会误登记依赖；反过来不会漏掉真实依赖。
 */
import path from 'node:path';
import ts from 'typescript';
import { type BoundaryEntry, inBoundary } from './evidence-boundary.js';

export type SourceReader = (file: string) => string;

export interface Unresolved {
  /** 出现位置所在文件。 */
  readonly file: string;
  readonly reason: 'dynamic-import' | 'namespace-computed' | 'namespace-escape' | 'import-unresolvable' | 'depth-limit';
  readonly detail: string;
}

export interface Closure {
  readonly unit: string;
  /** 依赖单元 `文件#名字` → 声明文本。 */
  readonly deps: ReadonlyMap<string, string>;
  /** 依赖单元 → 从证据单元走到它的最短链（含两端）。 */
  readonly chains: ReadonlyMap<string, readonly string[]>;
  /** 最大层数（直接依赖为 1）。 */
  readonly depth: number;
  readonly unresolved: readonly Unresolved[];
}

/**
 * 安全上限（设计写 12）：现状实测不动点最深 27 层（PR-B2 描述附分布），12 会让 40 多个单元触顶，故放宽到 40；
 * 它只防失控，触顶仍报 depth-limit，不静默截断。
 */
export const MAX_DEPTH = 40;

const sourceFiles = new WeakMap<SourceReader, Map<string, ts.SourceFile>>();

/** 读源码并解析（按读取器缓存）；读不到时抛读取器的错误。 */
export function sourceFileOf(read: SourceReader, file: string): ts.SourceFile {
  let byFile = sourceFiles.get(read);
  if (!byFile) sourceFiles.set(read, (byFile = new Map()));
  let parsed = byFile.get(file);
  if (!parsed) byFile.set(file, (parsed = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2022, true)));
  return parsed;
}

interface ImportBinding {
  readonly spec: string;
  readonly imported: string;
}
interface Reexport {
  readonly spec: string;
  /** 导出名 → 目标文件里的原名；缺省 = `export *`。 */
  readonly names?: ReadonlyMap<string, string>;
  /** `export * as <名> from …`：把整个模块作为命名空间导出。 */
  readonly namespace?: string;
}
interface FileInfo {
  readonly sf: ts.SourceFile;
  readonly decls: ReadonlyMap<string, readonly ts.Node[]>;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly reexports: readonly Reexport[];
  /** `export { local as name }`（无 from）：name → local。 */
  readonly exportedAs: ReadonlyMap<string, string>;
}

export interface ClosureEnv {
  readonly read: SourceReader;
  readonly boundary: readonly BoundaryEntry[];
  /** 在文件里定位证据单元的名字部分（`a>b` / `route:GET /p`）。 */
  readonly findNode: (sf: ts.SourceFile, unit: string, name: string) => ts.Node;
  readonly infos: Map<string, FileInfo | undefined>;
  readonly edges: Map<string, Edges>;
  readonly namespaces: Map<string, ReadonlyMap<string, NamespaceTarget>>;
  readonly refs: Map<string, Refs>;
  readonly bindings: Map<string, readonly BindingLine[]>;
}

export function createClosureEnv(
  read: SourceReader,
  boundary: readonly BoundaryEntry[],
  findNode: ClosureEnv['findNode'],
): ClosureEnv {
  return {
    read,
    boundary,
    findNode,
    infos: new Map(),
    edges: new Map(),
    namespaces: new Map(),
    refs: new Map(),
    bindings: new Map(),
  };
}

interface DeclRef {
  readonly file: string;
  readonly name: string;
}
const idOf = (ref: DeclRef) => `${ref.file}#${ref.name}`;
interface Edges {
  readonly deps: readonly DeclRef[];
  /** 依赖的 `文件#名字`，字典序。 */
  readonly ids: readonly string[];
  readonly unresolved: readonly Unresolved[];
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, out);
}

function topLevelDecls(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const decls = new Map<string, ts.Node[]>();
  const add = (name: string, node: ts.Node) => decls.set(name, [...(decls.get(name) ?? []), node]);
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      add(statement.name.text, statement);
    }
  }
  return decls;
}

function moduleBindings(sf: ts.SourceFile) {
  const imports = new Map<string, ImportBinding>();
  const reexports: Reexport[] = [];
  const exportedAs = new Map<string, string>();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const spec = statement.moduleSpecifier.text;
      if (clause.name) imports.set(clause.name.text, { spec, imported: 'default' });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, { spec, imported: '*' });
      else if (named) {
        for (const el of named.elements) {
          if (!el.isTypeOnly) imports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const spec =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      const exports =
        statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause : undefined;
      if (spec && statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        reexports.push({ spec, namespace: statement.exportClause.name.text });
      } else if (spec && !statement.exportClause) reexports.push({ spec });
      else if (spec && exports) {
        const names = new Map(
          exports.elements.filter((e) => !e.isTypeOnly).map((e) => [e.name.text, (e.propertyName ?? e.name).text]),
        );
        reexports.push({ spec, names });
      } else if (exports) {
        for (const el of exports.elements)
          if (!el.isTypeOnly) exportedAs.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
  }
  return { imports, reexports, exportedAs };
}

function fileInfo(env: ClosureEnv, file: string): FileInfo | undefined {
  if (env.infos.has(file)) return env.infos.get(file);
  let info: FileInfo | undefined;
  try {
    const sf = sourceFileOf(env.read, file);
    info = { sf, decls: topLevelDecls(sf), ...moduleBindings(sf) };
  } catch {
    info = undefined;
  }
  env.infos.set(file, info);
  return info;
}

type Target = { readonly file: string } | 'external' | 'missing';

function resolveModule(env: ClosureEnv, from: string, spec: string): Target {
  if (spec.startsWith('.')) {
    const base = path.posix.join(path.posix.dirname(from), spec).replace(/\.(js|ts)$/, '');
    const file = [`${base}.ts`, `${base}/index.ts`].find((candidate) => fileInfo(env, candidate));
    return file ? { file } : 'missing';
  }
  const pkg = /^@italent\/([\w-]+)$/.exec(spec)?.[1];
  if (!pkg) return 'external';
  const index = pkg === 'api' ? 'apps/api/src/index.ts' : `packages/${pkg}/src/index.ts`;
  return fileInfo(env, index) ? { file: index } : 'missing';
}

type Exported = DeclRef | { readonly namespace: string } | 'boundary' | undefined;
/** 命名空间绑定指向的模块文件；边界内的模块不展开；找不到模块的记原说明符。 */
type NamespaceTarget = { readonly file: string } | 'boundary' | { readonly missing: string };

/** 导出名的解析结果，加上经过的每一跳（绑定指纹用：转导出改指也要看得见）。 */
interface Resolved {
  readonly found: Exported;
  readonly chain: readonly string[];
}

const boundaryOf = (env: ClosureEnv, file: string) =>
  env.boundary.find((e) => (e.path.endsWith('/') ? file.startsWith(e.path) : file === e.path))?.path;

/** 文件导出的某个名字最终落在哪个顶层声明（跟随 `export … from`、`export * as`、导入后再导出）；边界文件返回 'boundary'。 */
function exportedChain(env: ClosureEnv, file: string, name: string, seen = new Set<string>()): Resolved {
  const here = `${file}#${name}`;
  if (seen.has(here)) return { found: undefined, chain: [here, 'cycle'] };
  seen.add(here);
  const boundary = boundaryOf(env, file);
  if (boundary) return { found: 'boundary', chain: [here, `boundary:${boundary}`] };
  const info = fileInfo(env, file);
  if (!info) return { found: undefined, chain: [here, 'unresolved'] };
  const local = info.exportedAs.get(name) ?? name;
  if (info.decls.has(local)) return { found: { file, name: local }, chain: [here, `decl:${file}#${local}`] };
  const imported = info.imports.get(local);
  if (imported) {
    const target = resolveModule(env, file, imported.spec);
    if (typeof target === 'object') {
      if (imported.imported === '*') {
        return {
          found: { namespace: target.file },
          chain: [here, `import:${imported.spec}`, `namespace:${target.file}`],
        };
      }
      const next = exportedChain(env, target.file, imported.imported, seen);
      return { found: next.found, chain: [here, `import:${imported.spec}`, ...next.chain] };
    }
  }
  for (const reexport of info.reexports) {
    const target = resolveModule(env, file, reexport.spec);
    if (typeof target !== 'object') continue;
    if (reexport.namespace !== undefined) {
      if (reexport.namespace === name) {
        return {
          found: { namespace: target.file },
          chain: [here, `export-ns:${reexport.spec}`, `namespace:${target.file}`],
        };
      }
      continue;
    }
    const original = reexport.names ? reexport.names.get(name) : name;
    const next = original ? exportedChain(env, target.file, original, seen) : undefined;
    if (next?.found) return { found: next.found, chain: [here, `export-from:${reexport.spec}`, ...next.chain] };
  }
  return { found: undefined, chain: [here, 'unresolved'] };
}

const exportedDecl = (env: ClosureEnv, file: string, name: string): Exported => exportedChain(env, file, name).found;

/** 文件里每个本地名若是命名空间（`import * as ns`，或具名导入的是 `export * as ns` 转出的模块），指向哪个模块。 */
function namespaceBindings(env: ClosureEnv, file: string): ReadonlyMap<string, NamespaceTarget> {
  const cached = env.namespaces.get(file);
  if (cached) return cached;
  const out = new Map<string, NamespaceTarget>();
  const info = fileInfo(env, file);
  for (const [local, binding] of info?.imports ?? []) {
    const target = resolveModule(env, file, binding.spec);
    if (target === 'external') continue;
    if (target === 'missing') {
      if (binding.imported === '*') out.set(local, { missing: binding.spec });
      continue;
    }
    const found =
      binding.imported === '*' ? { namespace: target.file } : exportedDecl(env, target.file, binding.imported);
    if (found && typeof found === 'object' && 'namespace' in found) {
      out.set(local, inBoundary(found.namespace, env.boundary) ? 'boundary' : { file: found.namespace });
    }
  }
  env.namespaces.set(file, out);
  return out;
}

function scopeOf(node: ts.Node): Set<string> | undefined {
  const out = new Set<string>();
  const declare = (list: ts.VariableDeclarationList | ts.ForInitializer | undefined) => {
    if (list && ts.isVariableDeclarationList(list)) for (const d of list.declarations) bindingNames(d.name, out);
  };
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) bindingNames(parameter.name, out);
    if (ts.isFunctionExpression(node) && node.name) out.add(node.name.text);
    return out;
  }
  if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
    const statements = ts.isCaseBlock(node)
      ? node.clauses.flatMap((clause) => [...clause.statements])
      : [...node.statements];
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) declare(statement.declarationList);
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        out.add(statement.name.text);
      }
    }
    return out;
  }
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    declare(node.initializer);
    return out;
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) bindingNames(node.variableDeclaration.name, out);
  return ts.isCatchClause(node) ? out : undefined;
}

/** 标识符是否是对某个绑定的引用（不是声明名、属性名、成员名、标签）。 */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent as (ts.Node & { name?: ts.Node; propertyName?: ts.Node }) | undefined;
  if (!parent) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (parent.name === id || parent.propertyName === id) return false;
  return !(ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent));
}

/** 一处引用（按遍历顺序，含重复）：绑定指纹按它逐个登记“局部标识符 → 解析目标”（F-072 §2.3.2）。 */
type RefPosition =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'member'; readonly ns: string; readonly member: string }
  | { readonly kind: 'escape'; readonly ns: string; readonly reason: 'namespace-computed' | 'namespace-escape' }
  | { readonly kind: 'dynamic'; readonly spec: string; readonly name: string }
  | { readonly kind: 'require' };

export interface Refs {
  readonly names: Set<string>;
  readonly members: [string, string][];
  /** 字面量说明符的动态 import 解构出的成员：`const { a } = await import('./x.js')`。 */
  readonly imports: { readonly spec: string; readonly name: string }[];
  readonly unresolved: Omit<Unresolved, 'file'>[];
  readonly positions: RefPosition[];
}

/** `const { a, b: c } = await import('./x.js')` 按具名导入处理；其他写法（成员访问、then、非字面量说明符）记未解析。 */
function dynamicImport(node: ts.CallExpression, refs: Refs): void {
  const spec = node.arguments[0];
  const holder = ts.isAwaitExpression(node.parent) ? node.parent.parent : undefined;
  if (spec && ts.isStringLiteralLike(spec) && holder && ts.isVariableDeclaration(holder)) {
    if (ts.isObjectBindingPattern(holder.name)) {
      for (const element of holder.name.elements) {
        const original = element.propertyName ?? element.name;
        if (!ts.isIdentifier(original)) continue;
        refs.imports.push({ spec: spec.text, name: original.text });
        refs.positions.push({ kind: 'dynamic', spec: spec.text, name: original.text });
      }
      return;
    }
  }
  refs.unresolved.push({
    reason: 'dynamic-import',
    detail: `import(${spec ? spec.getText() : ''}) 的成员用法无法确定`,
  });
  refs.positions.push({ kind: 'dynamic', spec: spec ? spec.getText() : '', name: '*' });
}

function collectRefs(roots: readonly ts.Node[], namespaces: ReadonlySet<string>): Refs {
  const refs: Refs = { names: new Set(), members: [], imports: [], unresolved: [], positions: [] };
  const scopes: Set<string>[] = [];
  const escape = (ns: string, reason: 'namespace-computed' | 'namespace-escape', detail: string) => {
    refs.unresolved.push({ reason, detail });
    refs.positions.push({ kind: 'escape', ns, reason });
  };
  const member = (ns: string, name: string) => {
    refs.members.push([ns, name]);
    refs.positions.push({ kind: 'member', ns, member: name });
  };
  const onReference = (id: ts.Identifier) => {
    if (!namespaces.has(id.text)) {
      refs.names.add(id.text);
      return void refs.positions.push({ kind: 'name', name: id.text });
    }
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) member(id.text, parent.name.text);
    else if (ts.isElementAccessExpression(parent) && parent.expression === id) {
      const key = parent.argumentExpression;
      if (ts.isStringLiteralLike(key)) member(id.text, key.text);
      else escape(id.text, 'namespace-computed', `${id.text}[计算成员]`);
    } else escape(id.text, 'namespace-escape', `${id.text} 整体作为值使用`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    const scope = scopeOf(node);
    if (scope) scopes.push(scope);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImport(node, refs);
    if (ts.isIdentifier(node) && isReference(node) && !scopes.some((s) => s.has(node.text))) {
      if (node.text === 'require' && ts.isCallExpression(node.parent)) {
        refs.unresolved.push({ reason: 'dynamic-import', detail: 'require(…)' });
        refs.positions.push({ kind: 'require' });
      } else onReference(node);
    }
    ts.forEachChild(node, visit);
    if (scope) scopes.pop();
  };
  for (const root of roots) visit(root);
  return refs;
}

/** 证据单元 / 依赖节点 `文件#名字` 对应的声明节点：顶层声明按名字取（可能多个），否则按证据单元规则定位。 */
function nodesOf(env: ClosureEnv, id: string): { readonly file: string; readonly nodes: readonly ts.Node[] } {
  const at = id.indexOf('#');
  const file = id.slice(0, at);
  const info = fileInfo(env, file);
  if (!info) throw new Error(`证据单元 ${id} 的文件读不到`);
  const name = id.slice(at + 1);
  return { file, nodes: info.decls.get(name) ?? [env.findNode(info.sf, id, name)] };
}

function nodeRefs(env: ClosureEnv, id: string): Refs {
  let refs = env.refs.get(id);
  if (!refs) {
    const { file, nodes } = nodesOf(env, id);
    refs = collectRefs(nodes, new Set(namespaceBindings(env, file).keys()));
    env.refs.set(id, refs);
  }
  return refs;
}

function edgesFrom(env: ClosureEnv, file: string, refs: Refs): Edges {
  const info = fileInfo(env, file);
  if (!info) return { deps: [], ids: [], unresolved: [] };
  const namespaces = namespaceBindings(env, file);
  const deps = new Map<string, DeclRef>();
  const unresolved: Unresolved[] = refs.unresolved.map((u) => ({ file, ...u }));
  const miss = (detail: string) => unresolved.push({ file, reason: 'import-unresolvable', detail });
  // 内部（非边界、非第三方）导入解析不了时登记在调用方文件，不管目标在 apps/ 还是 packages/
  const add = (found: Exported, label: string) => {
    if (found === 'boundary') return;
    if (found && 'name' in found) deps.set(idOf(found), found);
    else miss(`${label}：目标模块里找不到这个导出`);
  };
  const viaImport = (spec: string, name: string) => {
    const target = resolveModule(env, file, spec);
    if (target === 'missing') miss(`${spec}（引用 ${name}）：找不到模块`);
    else if (target !== 'external') add(exportedDecl(env, target.file, name), `${spec} 的 ${name}`);
  };
  for (const name of refs.names) {
    const binding = info.imports.get(name);
    if (info.decls.has(name)) add({ file, name }, name);
    else if (binding && !namespaces.has(name)) viaImport(binding.spec, binding.imported);
  }
  for (const [namespace, member] of refs.members) {
    const target = namespaces.get(namespace);
    if (!target || target === 'boundary') continue;
    if ('missing' in target) miss(`${target.missing}（引用 ${namespace}.${member}）：找不到模块`);
    else add(exportedDecl(env, target.file, member), `${namespace}.${member}`);
  }
  for (const { spec, name } of refs.imports) viaImport(spec, name);
  return { deps: [...deps.values()], ids: [...deps.keys()].sort(compareText), unresolved };
}

function nodeEdges(env: ClosureEnv, id: string): Edges {
  let edges = env.edges.get(id);
  if (!edges) {
    edges = edgesFrom(env, nodesOf(env, id).file, nodeRefs(env, id));
    env.edges.set(id, edges);
  }
  return edges;
}

/** 节点的直接依赖（字典序）。 */
export const edgeIds = (env: ClosureEnv, id: string): readonly string[] => nodeEdges(env, id).ids;
/** 节点自身的解析不了的项。 */
export const unresolvedOf = (env: ClosureEnv, id: string): readonly Unresolved[] => nodeEdges(env, id).unresolved;

/** 依赖节点的声明文本（同名多声明按顺序拼接）。 */
export function declText(env: ClosureEnv, id: string): string {
  const { file, nodes } = nodesOf(env, id);
  const info = fileInfo(env, file)!;
  return nodes.map((node) => node.getText(info.sf)).join('\n');
}

/** 绑定清单的一行：声明内第 `at` 个引用，局部标识符解析到哪里（解析链每一跳都记）。 */
export interface BindingLine {
  readonly at: number;
  readonly local: string;
  readonly resolved: readonly string[];
}

/** 模块说明符 → 链：外部包 / 找不到的模块只记说明符，内部模块再跟随转导出每一跳。 */
function viaChain(env: ClosureEnv, file: string, spec: string, imported: string): string[] {
  const target = resolveModule(env, file, spec);
  if (target === 'external') return [`external:${spec}#${imported}`];
  if (target === 'missing') return [`missing:${spec}#${imported}`];
  return [`import:${spec}`, ...exportedChain(env, target.file, imported).chain];
}

function resolveRef(env: ClosureEnv, file: string, position: RefPosition): BindingLine['resolved'] {
  const info = fileInfo(env, file)!;
  switch (position.kind) {
    case 'name': {
      if (info.decls.has(position.name)) return [`decl:${file}#${position.name}`];
      const binding = info.imports.get(position.name);
      return binding ? viaChain(env, file, binding.spec, binding.imported) : [`global:${position.name}`];
    }
    case 'member': {
      const target = namespaceBindings(env, file).get(position.ns);
      const spec = info.imports.get(position.ns)?.spec ?? '';
      if (!target || target === 'boundary') return [`import:${spec}`, 'boundary-namespace'];
      if ('missing' in target) return [`missing:${target.missing}`];
      return [`import:${spec}`, `namespace:${target.file}`, ...exportedChain(env, target.file, position.member).chain];
    }
    case 'escape':
      return [`unresolved:${position.reason}`];
    case 'dynamic':
      return [
        `dynamic:${position.spec}#${position.name}`,
        ...(position.name === '*' ? [] : viaChain(env, file, position.spec, position.name)),
      ];
    case 'require':
      return ['unresolved:require'];
  }
}

const localOf = (position: RefPosition): string =>
  position.kind === 'name'
    ? position.name
    : position.kind === 'member'
      ? `${position.ns}.${position.member}`
      : position.kind === 'escape'
        ? position.ns
        : position.kind === 'dynamic'
          ? position.name
          : 'require';

/** 节点的完整绑定清单（引用位置按遍历顺序；空白与注释不影响序号）。 */
export function bindingsOf(env: ClosureEnv, id: string): readonly BindingLine[] {
  let lines = env.bindings.get(id);
  if (!lines) {
    const { file } = nodesOf(env, id);
    lines = nodeRefs(env, id).positions.map((position, at) => ({
      at,
      local: localOf(position),
      resolved: resolveRef(env, file, position),
    }));
    env.bindings.set(id, lines);
  }
  return lines;
}

export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Walk {
  /** 闭包节点 → 从哪个节点走到它（按访问顺序）。 */
  readonly parents: ReadonlyMap<string, string>;
  /** 最大层数（直接依赖为 1）。 */
  readonly depth: number;
  /** 第 MAX_DEPTH 层上、确有依赖落在实际访问集合 V(r) = {r} ∪ Cl(r) 之外的节点（depth-limit，F-072 D-8 ①）。 */
  readonly limited: readonly string[];
}

/**
 * 广度优先求闭包，同层按 `edgesOf` 给出的顺序（调用方保证字典序）。与旧算法的差别只在 depth-limit：旧算法在
 * 处理第 MAX_DEPTH 层的节点时，只要它有“当时还没访问过”的依赖就报，同层先后会改变结果；这里等整张闭包走完，
 * 只看依赖是否真的落在 V(r) 之外，因此与遍历顺序无关。
 */
export function walk(root: string, edgesOf: (id: string) => readonly string[]): Walk {
  const parents = new Map<string, string>();
  const visited = new Set([root]);
  const atLimit: string[] = [];
  let frontier = edgesOf(root).map((id) => ({ id, parent: root }));
  let depth = 0;
  let reached = 0;
  while (frontier.length) {
    depth++;
    const next: typeof frontier = [];
    for (const { id, parent } of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      reached = depth;
      parents.set(id, parent);
      if (depth < MAX_DEPTH)
        next.push(
          ...edgesOf(id)
            .filter((d) => !visited.has(d))
            .map((d) => ({ id: d, parent: id })),
        );
      else atLimit.push(id);
    }
    frontier = next;
  }
  const limited = atLimit.filter((id) => edgesOf(id).some((d) => !visited.has(d)));
  return { parents, depth: reached, limited };
}

/** 从 walk 的 parents 还原最短链（含两端；根是第一层节点的 parent）。 */
export function chainsOf(parents: ReadonlyMap<string, string>): Map<string, readonly string[]> {
  const chains = new Map<string, readonly string[]>();
  for (const id of parents.keys()) {
    const chain = [id];
    for (let up = parents.get(id); up; up = parents.get(up)) chain.unshift(up);
    chains.set(id, chain);
  }
  return chains;
}

/** 从一组根出发可达的全部节点（不设层数上限；登记图按它生成）。 */
export function explore(env: ClosureEnv, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...edgeIds(env, id));
  }
  return seen;
}

/** 证据单元的依赖闭包（广度优先，最短链；depth-limit 的定义见 walk）。 */
export function closureOf(env: ClosureEnv, unit: string): Closure {
  const rootEdges = nodeEdges(env, unit);
  const result = walk(unit, (id) => edgeIds(env, id));
  const unresolved = new Map<string, Unresolved>();
  const record = (items: readonly Unresolved[]) => {
    for (const item of items) unresolved.set(`${item.file}|${item.reason}|${item.detail}`, item);
  };
  record(rootEdges.unresolved);
  const deps = new Map<string, string>();
  for (const id of result.parents.keys()) {
    deps.set(id, declText(env, id));
    record(unresolvedOf(env, id));
  }
  for (const id of result.limited) {
    const file = id.slice(0, id.indexOf('#'));
    record([{ file, reason: 'depth-limit', detail: `${id} 在第 ${MAX_DEPTH} 层仍有未展开的依赖` }]);
  }
  return {
    unit,
    deps,
    chains: chainsOf(result.parents),
    depth: result.depth,
    unresolved: [...unresolved.values()],
  };
}
