/**
 * 证据依赖闭包（F-039 PR-B2，设计 B-02）。证据单元只登记调用点、实现、常量本身的摘要，决定授权实参的函数
 * （360 `routeNeed → levelOf`）改了不报。这里对每个单元求依赖闭包：从单元文本出发逐层解析标识符，
 * - 同文件顶层函数 / 常量 / 类 / 枚举；
 * - 相对 import 指向的 `apps/api/src/**` 导出（含 `export … from` 与 `export *` 转发）；
 * - `@italent/<包>` 解析到 `packages/<包>/src/index.ts` 的声明（`@italent/domain` 等）；
 * 算到不动点（广度优先，安全上限 12 层，带环检测）。不解析：注入依赖（`deps.*`、形参，由词法作用域排除）、纯类型、
 * 第三方包、边界清单内的文件（evidence-boundary.ts）、二进制资源（字体 / 图片，F-080，显式排除）。
 * 解析不了的写进 unresolved：动态 import / require、命名空间 import 的计算成员访问或整体外传、找不到的相对 import、
 * 触到层数上限仍有未展开的依赖（depth-limit）。判定“是否要报”在 evidence.ts（位于 modules/** 且不在边界内才报）。
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
}

export function createClosureEnv(
  read: SourceReader,
  boundary: readonly BoundaryEntry[],
  findNode: ClosureEnv['findNode'],
): ClosureEnv {
  return { read, boundary, findNode, infos: new Map(), edges: new Map(), namespaces: new Map() };
}

interface DeclRef {
  readonly file: string;
  readonly name: string;
}
const idOf = (ref: DeclRef) => `${ref.file}#${ref.name}`;
interface Edges {
  readonly deps: readonly DeclRef[];
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

/** 二进制资源（内置字体等，F-080）：不是 TypeScript 源码单元，显式排除——不展开、不进摘要、也不当作解析失败。 */
const ASSET_SPEC = /\.(ttf|otf|ttc|woff2?|png|jpe?g|gif|ico)$/i;

function resolveModule(env: ClosureEnv, from: string, spec: string): Target {
  if (ASSET_SPEC.test(spec)) return 'external';
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

/** 文件导出的某个名字最终落在哪个顶层声明（跟随 `export … from`、`export * as`、导入后再导出）；边界文件返回 'boundary'。 */
function exportedDecl(env: ClosureEnv, file: string, name: string, seen = new Set<string>()): Exported {
  if (seen.has(`${file}#${name}`)) return undefined;
  seen.add(`${file}#${name}`);
  if (inBoundary(file, env.boundary)) return 'boundary';
  const info = fileInfo(env, file);
  if (!info) return undefined;
  const local = info.exportedAs.get(name) ?? name;
  if (info.decls.has(local)) return { file, name: local };
  const imported = info.imports.get(local);
  if (imported) {
    const target = resolveModule(env, file, imported.spec);
    if (typeof target === 'object') {
      return imported.imported === '*'
        ? { namespace: target.file }
        : exportedDecl(env, target.file, imported.imported, seen);
    }
  }
  for (const reexport of info.reexports) {
    const target = resolveModule(env, file, reexport.spec);
    if (typeof target !== 'object') continue;
    if (reexport.namespace !== undefined) {
      if (reexport.namespace === name) return { namespace: target.file };
      continue;
    }
    const original = reexport.names ? reexport.names.get(name) : name;
    const found = original ? exportedDecl(env, target.file, original, seen) : undefined;
    if (found) return found;
  }
  return undefined;
}

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

interface Refs {
  readonly names: Set<string>;
  readonly members: [string, string][];
  /** 字面量说明符的动态 import 解构出的成员：`const { a } = await import('./x.js')`。 */
  readonly imports: { readonly spec: string; readonly name: string }[];
  readonly unresolved: Omit<Unresolved, 'file'>[];
}

/** `const { a, b: c } = await import('./x.js')` 按具名导入处理；其他写法（成员访问、then、非字面量说明符）记未解析。 */
function dynamicImport(node: ts.CallExpression, refs: Refs): void {
  const spec = node.arguments[0];
  const holder = ts.isAwaitExpression(node.parent) ? node.parent.parent : undefined;
  if (spec && ts.isStringLiteralLike(spec) && holder && ts.isVariableDeclaration(holder)) {
    if (ts.isObjectBindingPattern(holder.name)) {
      for (const element of holder.name.elements) {
        const original = element.propertyName ?? element.name;
        if (ts.isIdentifier(original)) refs.imports.push({ spec: spec.text, name: original.text });
      }
      return;
    }
  }
  refs.unresolved.push({
    reason: 'dynamic-import',
    detail: `import(${spec ? spec.getText() : ''}) 的成员用法无法确定`,
  });
}

function collectRefs(roots: readonly ts.Node[], namespaces: ReadonlySet<string>): Refs {
  const refs: Refs = { names: new Set(), members: [], imports: [], unresolved: [] };
  const scopes: Set<string>[] = [];
  const onReference = (id: ts.Identifier) => {
    if (!namespaces.has(id.text)) return void refs.names.add(id.text);
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id)
      refs.members.push([id.text, parent.name.text]);
    else if (ts.isElementAccessExpression(parent) && parent.expression === id) {
      const key = parent.argumentExpression;
      if (ts.isStringLiteralLike(key)) refs.members.push([id.text, key.text]);
      else refs.unresolved.push({ reason: 'namespace-computed', detail: `${id.text}[计算成员]` });
    } else refs.unresolved.push({ reason: 'namespace-escape', detail: `${id.text} 整体作为值使用` });
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
      } else onReference(node);
    }
    ts.forEachChild(node, visit);
    if (scope) scopes.pop();
  };
  for (const root of roots) visit(root);
  return refs;
}

function edgesFor(env: ClosureEnv, file: string, nodes: readonly ts.Node[]): Edges {
  const info = fileInfo(env, file);
  if (!info) return { deps: [], unresolved: [] };
  const namespaces = namespaceBindings(env, file);
  const refs = collectRefs(nodes, new Set(namespaces.keys()));
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
  return { deps: [...deps.values()], unresolved };
}

function declEdges(env: ClosureEnv, ref: DeclRef): Edges {
  const id = idOf(ref);
  let edges = env.edges.get(id);
  if (!edges) {
    edges = edgesFor(env, ref.file, fileInfo(env, ref.file)?.decls.get(ref.name) ?? []);
    env.edges.set(id, edges);
  }
  return edges;
}

function declText(env: ClosureEnv, ref: DeclRef): string {
  const info = fileInfo(env, ref.file);
  return (info?.decls.get(ref.name) ?? []).map((node) => node.getText(info!.sf)).join('\n');
}

/** 证据单元的依赖闭包（广度优先，最短链；到 MAX_DEPTH 层仍有未展开的依赖，记 depth-limit）。 */
export function closureOf(env: ClosureEnv, unit: string): Closure {
  const at = unit.indexOf('#');
  const file = unit.slice(0, at);
  const info = fileInfo(env, file);
  if (!info) throw new Error(`证据单元 ${unit} 的文件读不到`);
  const root = edgesFor(env, file, [env.findNode(info.sf, unit, unit.slice(at + 1))]);
  const unresolved = new Map<string, Unresolved>();
  const record = (items: readonly Unresolved[]) => {
    for (const item of items) unresolved.set(`${item.file}|${item.reason}|${item.detail}`, item);
  };
  record(root.unresolved);
  const deps = new Map<string, string>();
  const parents = new Map<string, string>();
  const visited = new Set([unit]);
  let frontier = root.deps.map((ref) => ({ ref, parent: unit }));
  let depth = 0;
  let reached = 0;
  while (frontier.length) {
    depth++;
    const next: typeof frontier = [];
    for (const { ref, parent } of frontier) {
      const id = idOf(ref);
      if (visited.has(id)) continue;
      visited.add(id);
      reached = depth;
      parents.set(id, parent);
      deps.set(id, declText(env, ref));
      const edges = declEdges(env, ref);
      record(edges.unresolved);
      const fresh = edges.deps.filter((d) => !visited.has(idOf(d)));
      if (depth < MAX_DEPTH) next.push(...fresh.map((d) => ({ ref: d, parent: id })));
      else if (fresh.length)
        record([{ file: ref.file, reason: 'depth-limit', detail: `${id} 在第 ${depth} 层仍有未展开的依赖` }]);
    }
    frontier = next;
  }
  const chains = new Map<string, readonly string[]>();
  for (const id of deps.keys()) {
    const chain = [id];
    for (let up = parents.get(id); up; up = parents.get(up)) chain.unshift(up);
    chains.set(id, chain);
  }
  return { unit, deps, chains, depth: reached, unresolved: [...unresolved.values()] };
}
