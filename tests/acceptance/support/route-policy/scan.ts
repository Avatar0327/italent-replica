/**
 * 静态注册扫描（现状必测基准的来源 (a)，F-039 PR-A §4.2 限定版）：用 TypeScript AST 读 apps/api/src 的路由文件，
 * 找出每条 `router.<method>(path, handler)` / `router.on(method, path, handler)` 注册，展开 for…of 循环里的绑定
 * （字符串元素、元组、模块常量），算出它能产生的路径（精确或带通配），再把处理函数文本连同它引用的模块内函数
 * （经同文件定义与相对 import 逐层解析）合成"闭包文本"，供原语目录匹配。**不读任何声明**。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const API_SRC = path.resolve(process.cwd(), 'apps/api/src');

/** 不再展开的共享文件：它们导出的函数名本身就是原语（授权 / 命令 / 范围解析 / 对象写），由目录匹配。 */
const LEAF_FILES = new Set(
  [
    'authorization.ts',
    'commands.ts',
    'errors.ts',
    'middleware.ts',
    'tenant-context.ts',
    'identity.ts',
    'system-actor.ts',
    'audit/record.ts',
    'audit/capture.ts',
    'audit/request-context.ts',
    'audit/failures.ts',
    'modules/permission/module-access.ts',
    'modules/permission/module-route-access.ts',
    'modules/permission/object-write.ts',
    'modules/permission/authorizer.ts',
    'modules/permission/scope-resolver.ts',
    'modules/permission/scope-audit.ts',
    'modules/permission/org-result-scope.ts',
    'modules/permission/me.ts',
    'modules/permission/admin-http.ts',
    'modules/permission/http.ts',
    // 各模块的多态上下文 / 访问枢纽：按调用点与实参匹配原语，不展开内部分支（否则 GET 也会带上写分支的原语）
    'modules/contracts/context.ts',
    'modules/employment/context.ts',
    'modules/personnel/access.ts',
    'modules/personnel/http.ts',
    'modules/approval/access.ts',
    'modules/approval/context.ts',
    'modules/transfer/access.ts',
    'modules/employee-self-service/access.ts',
    'modules/job/context.ts',
    'audit/visibility.ts',
    'modules/survey360/context.ts',
  ].map((f) => path.join(API_SRC, f)),
);

/** 路由文件内的枢纽函数（同上理由不展开，按调用点匹配）。键 = 相对 apps/api/src 的路径#函数名。 */
const HUB_FUNCTIONS = new Set([
  'modules/contracts/routes.ts#routeContext',
  'modules/contracts/routes.ts#trim',
  'modules/contracts/routes.ts#write',
  'modules/contracts/routes.ts#requireMasterScope',
  'modules/org/routes.ts#context',
  'modules/org/routes.ts#write',
  'modules/approval/routes.ts#readCtx',
  'modules/approval/routes.ts#writeCtx',
  'modules/approval/routes.ts#command',
  'modules/approval/routes.ts#fieldAccess',
  'modules/approval/routes.ts#tenantCtx',
  'modules/approval/routes.ts#fieldRights',
  'modules/approval/routes.ts#viewerOf',
  'modules/approval/routes.ts#detailViewable',
  'modules/approval/routes.ts#ownViewable',
  'modules/approval/routes.ts#respondDetail',
  'modules/approval/routes.ts#respondHistory',
  'modules/approval/routes.ts#respondOutcome',
  'modules/approval/routes.ts#processResponse',
  'modules/transfer/manager-routes.ts#managerContext',
  'modules/transfer/linkage/routes.ts#preauthorizeLinkage',
  'modules/transfer/linkage/routes.ts#authorizeRetry',
  'modules/establishment/routes.ts#visibleCapacity',
  'modules/establishment/routes.ts#visibleScheme',
  'modules/establishment/routes.ts#visibleCopyJob',
  'modules/establishment/routes.ts#checkCapacity',
  'modules/establishment/routes.ts#checkScheme',
  'modules/establishment/routes.ts#trimCapacities',
  'audit/routes.ts#auditContext',
  'modules/idp/routes.ts#write',
]);

/**
 * 动态分派表（处理函数按请求参数从局部对象里取处理器，静态展开跟不过去）：键 = 相对路径#分派表名，
 * 值 = 分派到的处理器工厂。闭包展开时把工厂当作处理函数的直接调用（审查第 1 轮 P3-1：人才表单）。
 */
const DISPATCH: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  'modules/talent/routes.ts#forms': [['modules/talent/form-access.ts', 'talentFormHandler']],
};

const REGISTER_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'on']);
/** 只把路由器变量上的调用当注册，避免把 `config.get(tx, key)` 之类当成路由。 */
const ROUTER_NAMES = /^(router|module|app|sub|api|root)$/;
const KEYWORDS = new Set(
  (
    'async await break case catch class const continue debugger default delete do else export extends finally for ' +
    'function if import in instanceof let new return super switch this throw try typeof var void while with yield ' +
    'of true false null undefined'
  ).split(' '),
);

interface FileInfo {
  readonly file: string;
  readonly sf: ts.SourceFile;
  /** 顶层函数 / 箭头函数常量：名字 → 文本。 */
  readonly defs: Map<string, string>;
  /** 顶层常量初始化表达式：名字 → 节点（字符串 / 数组 / 对象字面量等）。 */
  readonly consts: Map<string, ts.Expression>;
  /** 相对 import：本地名字 → 目标文件与原名（处理 `adminGuard as guard`）。 */
  readonly imports: Map<string, { readonly file: string; readonly name: string }>;
  /** `import * as ns from './x.js'`：命名空间 → 目标文件（`ns.fn(…)` 按目标文件里的 fn 展开）。 */
  readonly namespaces: Map<string, string>;
  /** `export { a } from './x.js'`：名字 → 目标文件；`export * from` 列表。 */
  readonly reexports: Map<string, string>;
  readonly starExports: string[];
}

export interface SourceIndex {
  readonly files: Map<string, FileInfo>;
}

export interface StaticRegistration {
  readonly file: string;
  readonly line: number;
  /** 大写方法；`*` 表示静态无法确定。 */
  readonly methods: readonly string[];
  /** 精确路径（循环展开后）或 null。 */
  readonly exactPath: string | null;
  /** 带通配的路径正则（exactPath 为 null 时使用）。 */
  readonly pattern: RegExp | null;
  readonly wildcards: number;
  readonly handlerText: string;
  /** 处理函数文本之外还要展开的标识符（循环绑定到的函数名等）。 */
  readonly extraRoots: readonly string[];
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function resolveRelative(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* 不存在，试下一个 */
    }
  }
  return undefined;
}

function indexFile(file: string): FileInfo {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const defs = new Map<string, string>();
  const consts = new Map<string, ts.Expression>();
  const imports = new Map<string, { file: string; name: string }>();
  const namespaces = new Map<string, string>();
  const reexports = new Map<string, string>();
  const starExports: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) defs.set(statement.name.text, statement.getText(sf));
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const init = declaration.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          defs.set(declaration.name.text, init.getText(sf));
        else consts.set(declaration.name.text, init);
      }
    }
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings) {
      const target = resolveRelative(file, (statement.moduleSpecifier as ts.StringLiteral).text);
      if (!target) continue;
      const bindings = statement.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.set(element.name.text, { file: target, name: element.propertyName?.text ?? element.name.text });
        }
      }
      if (ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, target);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const target = resolveRelative(file, (statement.moduleSpecifier as ts.StringLiteral).text);
      if (!target) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) reexports.set(element.name.text, target);
      } else starExports.push(target);
    }
  }
  return { file, sf, defs, consts, imports, namespaces, reexports, starExports };
}

export function indexSources(root = API_SRC): SourceIndex {
  const files = new Map<string, FileInfo>();
  for (const file of listTsFiles(root)) {
    if (file.includes(`${path.sep}route-policy${path.sep}`)) continue;
    const info = indexFile(file);
    if (info.sf.text.includes('defineTable(')) continue; // 登记表文件：基准不读声明
    files.set(file, info);
  }
  return { files };
}

// ---- 循环绑定与路径求值 ------------------------------------------------------------------------------------------

type Bound = string | { readonly ref: string } | { readonly tuple: readonly Bound[] } | { readonly opaque: true };
type Bindings = ReadonlyMap<string, Bound>;

function literalElement(node: ts.Expression, info: FileInfo): Bound {
  const inner = ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isIdentifier(inner)) {
    const constant = info.consts.get(inner.text);
    if (constant && (ts.isStringLiteral(constant) || ts.isNoSubstitutionTemplateLiteral(constant)))
      return constant.text;
    return { ref: inner.text };
  }
  if (ts.isArrayLiteralExpression(inner)) return { tuple: inner.elements.map((e) => literalElement(e, info)) };
  return { opaque: true };
}

/** 把 for…of 的可迭代表达式解析成元素列表；解析不了返回 undefined（退化为通配）。 */
function iterableElements(expr: ts.Expression, info: FileInfo, scope?: ts.Node): Bound[] | undefined {
  const inner = ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.map((e) => literalElement(e, info));
  if (ts.isIdentifier(inner)) {
    // 模块常量，或包围作用域里的局部常量（如 `const own = [['urge', urge], …] as const`）
    const constant = info.consts.get(inner.text) ?? (scope ? localInitializer(inner.text, scope) : undefined);
    return constant ? iterableElements(constant, info) : undefined;
  }
  if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
    const { expression: object, name } = inner.expression;
    const arg = inner.arguments[0];
    if (ts.isIdentifier(object) && object.text === 'Object' && arg) {
      const target = ts.isIdentifier(arg) ? info.consts.get(arg.text) : arg;
      const literal =
        target && (ts.isAsExpression(target) || ts.isParenthesizedExpression(target)) ? target.expression : target;
      if (literal && ts.isObjectLiteralExpression(literal)) {
        const entries = literal.properties.flatMap((p) => {
          if (!ts.isPropertyAssignment(p)) return [];
          const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
          return key === undefined ? [] : [{ key, value: literalElement(p.initializer, info) }];
        });
        if (name.text === 'entries') return entries.map((e) => ({ tuple: [e.key, e.value] }));
        if (name.text === 'keys') return entries.map((e) => e.key);
        if (name.text === 'values') return entries.map((e) => e.value);
      }
    }
  }
  return undefined;
}

function bindPattern(name: ts.BindingName, value: Bound, into: Map<string, Bound>): void {
  if (ts.isIdentifier(name)) {
    into.set(name.text, value);
    return;
  }
  if (ts.isArrayBindingPattern(name) && typeof value === 'object' && 'tuple' in value) {
    name.elements.forEach((element, i) => {
      if (ts.isBindingElement(element)) bindPattern(element.name, value.tuple[i] ?? { opaque: true }, into);
    });
  }
}

/** 从注册调用往外收集所有 for…of，返回绑定组合的笛卡尔积（空数组元素 = 没有循环）。 */
function loopBindings(call: ts.Node, info: FileInfo): Bindings[] {
  const loops: ts.ForOfStatement[] = [];
  for (let node: ts.Node | undefined = call.parent; node; node = node.parent) {
    if (ts.isForOfStatement(node)) loops.push(node);
    if (ts.isFunctionLike(node) && !loops.length) continue;
  }
  let combos: Map<string, Bound>[] = [new Map()];
  for (const loop of loops.reverse()) {
    if (!ts.isVariableDeclarationList(loop.initializer)) continue;
    const declaration = loop.initializer.declarations[0];
    const elements = declaration ? iterableElements(loop.expression, info, loop) : undefined;
    if (!declaration || !elements) continue;
    combos = combos.flatMap((combo) =>
      elements.map((element) => {
        const next = new Map(combo);
        bindPattern(declaration.name, element, next);
        return next;
      }),
    );
  }
  return combos;
}

const WILDCARD = '\u0000';

/** 求表达式的字符串值；解析不了返回 WILDCARD 占位。 */
function evalString(expr: ts.Expression, info: FileInfo, bindings: Bindings, scope: ts.Node): string {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr))
    return evalString(expr.expression, info, bindings, scope);
  if (ts.isTemplateExpression(expr)) {
    return (
      expr.head.text +
      expr.templateSpans.map((span) => evalString(span.expression, info, bindings, scope) + span.literal.text).join('')
    );
  }
  if (ts.isIdentifier(expr)) {
    const bound = bindings.get(expr.text);
    if (typeof bound === 'string') return bound;
    if (bound) return WILDCARD;
    const constant = info.consts.get(expr.text);
    if (constant) return evalString(constant, info, bindings, scope);
    const local = localInitializer(expr.text, scope);
    if (local) return evalString(local, info, bindings, scope);
    return WILDCARD;
  }
  if (ts.isConditionalExpression(expr)) {
    const condition = evalCondition(expr.condition, info, bindings, scope);
    if (condition === undefined) return WILDCARD;
    return evalString(condition ? expr.whenTrue : expr.whenFalse, info, bindings, scope);
  }
  return WILDCARD;
}

function evalCondition(expr: ts.Expression, info: FileInfo, bindings: Bindings, scope: ts.Node): boolean | undefined {
  if (ts.isParenthesizedExpression(expr)) return evalCondition(expr.expression, info, bindings, scope);
  if (ts.isBinaryExpression(expr)) {
    const left = evalString(expr.left, info, bindings, scope);
    const right = evalString(expr.right, info, bindings, scope);
    if (left === WILDCARD || right === WILDCARD) return undefined;
    const kind = expr.operatorToken.kind;
    if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken)
      return left === right;
    if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken) {
      return left !== right;
    }
    return undefined;
  }
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const receiver = evalString(expr.expression.expression, info, bindings, scope);
    const arg = expr.arguments[0] ? evalString(expr.arguments[0], info, bindings, scope) : WILDCARD;
    if (receiver === WILDCARD || arg === WILDCARD) return undefined;
    if (expr.expression.name.text === 'endsWith') return receiver.endsWith(arg);
    if (expr.expression.name.text === 'startsWith') return receiver.startsWith(arg);
    return undefined;
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = evalCondition(expr.operand, info, bindings, scope);
    return inner === undefined ? undefined : !inner;
  }
  const value = evalString(expr, info, bindings, scope);
  return value === WILDCARD ? undefined : value.length > 0;
}

/** 在包围作用域里找局部 `const name = …` 的初始化表达式。 */
function localInitializer(name: string, scope: ts.Node): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (let node: ts.Node | undefined = scope; node && !found; node = node.parent) {
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isFunctionLike(node)) visit(node);
  }
  return found;
}

function evalMethods(
  expr: ts.Expression | undefined,
  fallback: string,
  info: FileInfo,
  bindings: Bindings,
  scope: ts.Node,
) {
  if (!expr) return [fallback.toUpperCase()];
  const inner = ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements
      .map((e) => evalString(e, info, bindings, scope))
      .map((m) => (m === WILDCARD ? '*' : m.toUpperCase()));
  }
  const value = evalString(inner, info, bindings, scope);
  return [value === WILDCARD ? '*' : value.toUpperCase()];
}

function toPattern(value: string): { exactPath: string | null; pattern: RegExp | null; wildcards: number } {
  const wildcards = value.split(WILDCARD).length - 1;
  if (!wildcards) return { exactPath: value, pattern: null, wildcards: 0 };
  const source = value
    .split(WILDCARD)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*?');
  return { exactPath: null, pattern: new RegExp(`^${source}$`), wildcards };
}

/** 只取调用位置的标识符（`name(`），避免同名参数 / 变量（如 `write = false`）误当成函数引用。 */
function identifiers(text: string): string[] {
  const names = [...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!);
  return [...new Set(names.filter((w) => !KEYWORDS.has(w)))];
}

/**
 * 处理函数文本。循环展开后能判定真假的 `if (cond) return …;`（如共用处理函数里的 `if (suffix) return importPreview(…)`）
 * 按分支裁剪：条件为真 → 之前的语句 + 该 return 表达式；为假 → 去掉这条 if。判定不了的保留原文。
 */
function handlerBodyText(handler: ts.Expression, info: FileInfo, bindings: Bindings, scope: ts.Node): string {
  const fn = ts.isArrowFunction(handler) || ts.isFunctionExpression(handler) ? handler : undefined;
  if (!fn || !fn.body || !ts.isBlock(fn.body) || !bindings.size) return handler.getText(info.sf);
  const kept: string[] = [];
  for (const statement of fn.body.statements) {
    if (ts.isIfStatement(statement)) {
      const verdict = evalCondition(statement.expression, info, bindings, scope);
      const chosen =
        verdict === true ? statement.thenStatement : verdict === false ? statement.elseStatement : undefined;
      if (verdict !== undefined) {
        if (chosen) kept.push(chosen.getText(info.sf));
        // 选中的分支以 return 结束：后面的语句不会执行
        const last = chosen && ts.isBlock(chosen) ? chosen.statements.at(-1) : chosen;
        if (last && ts.isReturnStatement(last)) return kept.join('\n');
        continue;
      }
    }
    kept.push(statement.getText(info.sf));
  }
  return kept.join('\n');
}

/** 处理函数文本；引用的局部函数（包围作用域里的 `const h = () => …`）与循环绑定到的函数名一并带上。 */
function handlerRoots(
  handler: ts.Expression,
  info: FileInfo,
  bindings: Bindings,
  scope: ts.Node,
): { text: string; roots: string[] } {
  const parts = [handlerBodyText(handler, info, bindings, scope)];
  const roots: string[] = [];
  const seen = new Set<string>();
  const queue = identifiers(parts[0]!);
  if (ts.isIdentifier(handler)) queue.push(handler.text);
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const bound = bindings.get(name);
    if (bound && typeof bound === 'object' && 'ref' in bound) roots.push(bound.ref);
    const local = localInitializer(name, scope);
    const hub = HUB_FUNCTIONS.has(`${path.relative(API_SRC, info.file)}#${name}`);
    if (local && !hub && (ts.isArrowFunction(local) || ts.isFunctionExpression(local))) {
      const text = local.getText(info.sf);
      parts.push(text);
      queue.push(...identifiers(text));
    }
  }
  if (ts.isCallExpression(handler) && ts.isIdentifier(handler.expression)) roots.push(handler.expression.text);
  if (ts.isIdentifier(handler)) roots.push(handler.text);
  return { text: parts.join('\n'), roots };
}

export function scanRegistrations(index: SourceIndex): StaticRegistration[] {
  const out: StaticRegistration[] = [];
  for (const info of index.files.values()) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        REGISTER_METHODS.has(node.expression.name.text) &&
        ts.isIdentifier(node.expression.expression) &&
        ROUTER_NAMES.test(node.expression.expression.text) &&
        node.arguments.length >= 2
      ) {
        const method = node.expression.name.text;
        const args = node.arguments;
        const pathArg = method === 'on' ? args[1] : args[0];
        const handler = args[args.length - 1];
        if (pathArg && handler && pathArg !== handler) {
          const line = info.sf.getLineAndCharacterOfPosition(node.getStart(info.sf)).line + 1;
          for (const bindings of loopBindings(node, info)) {
            const methods = evalMethods(method === 'on' ? args[0] : undefined, method, info, bindings, node);
            const { text, roots } = handlerRoots(handler, info, bindings, node);
            out.push({
              file: info.file,
              line,
              methods,
              ...toPattern(evalString(pathArg, info, bindings, node)),
              handlerText: text,
              extraRoots: roots,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.sf);
  }
  return out;
}

/** 按最终路径前缀确定路由所属的源码目录（与声明无关）：子应用 / 模块各自的目录。 */
export interface RouteModule {
  readonly module: string;
  readonly prefix: string;
  /** 子应用（经 route() 挂载）：注册时写的是去掉前缀的本地路径。 */
  readonly subApp: boolean;
  readonly dirs: readonly string[];
}
const SUB_APPS = new Set(['employment', 'approval', 'contracts', 'self-service', 'survey360', 'survey360-link']);
export function moduleDirs(fullPath: string): RouteModule {
  const modules = path.join(API_SRC, 'modules');
  const table: readonly (readonly [string, string, readonly string[]])[] = [
    ['employment', '/api/tenant/employment', ['employment', 'transfer'].map((d) => path.join(modules, d))],
    ['approval', '/api/tenant/approval', [path.join(modules, 'approval')]],
    ['contracts', '/api/tenant/contracts', [path.join(modules, 'contracts')]],
    ['self-service', '/api/tenant/self-service', [path.join(modules, 'employee-self-service')]],
    ['tenant-settings', '/api/tenant/settings', [path.join(modules, 'tenant-settings')]],
    ['permission', '/api/tenant/permission', [path.join(modules, 'permission')]],
    ['org', '/api/tenant/org', [path.join(modules, 'org')]],
    ['job', '/api/tenant/job', [path.join(modules, 'job')]],
    ['establishment', '/api/tenant/establishment', [path.join(modules, 'establishment')]],
    ['personnel', '/api/tenant/personnel', [path.join(modules, 'personnel')]],
    ['audit', '/api/tenant/audit', [path.join(API_SRC, 'audit')]],
    ['platform', '/api/platform', [path.join(modules, 'platform')]],
    ['survey360', '/api/tenant/survey360', [path.join(modules, 'survey360')]],
    ['survey360-link', '/api/survey360/link', [path.join(modules, 'survey360')]],
    ['talent', '/api/tenant/talent', [path.join(modules, 'talent')]],
    ['idp', '/api/tenant/idp', [path.join(modules, 'idp')]],
  ];
  const hit = table.find(([, prefix]) => fullPath === prefix || fullPath.startsWith(prefix + '/'));
  return hit
    ? { module: hit[0], prefix: hit[1], subApp: SUB_APPS.has(hit[0]), dirs: hit[2] }
    : { module: 'root', prefix: '', subApp: false, dirs: [path.join(API_SRC, 'app.ts')] };
}

/** 为一条运行时路由（方法 + 本地路径）挑静态注册：精确路径优先，其次通配最少；并列返回全部（闭包取并集）。 */
export function matchRegistrations(
  registrations: readonly StaticRegistration[],
  method: string,
  localPath: string,
  dirs?: readonly string[],
): StaticRegistration[] {
  const candidates = registrations.filter(
    (r) =>
      (!dirs || dirs.some((dir) => r.file.startsWith(dir + path.sep) || r.file === dir)) &&
      (r.methods.includes(method) || r.methods.includes('*')) &&
      (r.exactPath === localPath || (r.pattern?.test(localPath) ?? false)),
  );
  const exact = candidates.filter((r) => r.exactPath === localPath);
  if (exact.length) return exact;
  const best = Math.min(...candidates.map((r) => r.wildcards));
  return candidates.filter((r) => r.wildcards === best);
}

// ---- 闭包文本 ------------------------------------------------------------------------------------------------------

function findDef(
  index: SourceIndex,
  file: string,
  name: string,
  depth = 0,
): { file: string; text: string } | undefined {
  if (depth > 4) return undefined;
  const info = index.files.get(file);
  if (!info) return undefined;
  const local = info.defs.get(name);
  if (local !== undefined) {
    return HUB_FUNCTIONS.has(`${path.relative(API_SRC, file)}#${name}`) ? undefined : { file, text: local };
  }
  const imported = info.imports.get(name);
  if (imported) {
    if (LEAF_FILES.has(imported.file)) return undefined;
    return findDef(index, imported.file, imported.name, depth + 1);
  }
  const reexported = info.reexports.get(name);
  if (reexported) return LEAF_FILES.has(reexported) ? undefined : findDef(index, reexported, name, depth + 1);
  for (const star of info.starExports) {
    const hit = LEAF_FILES.has(star) ? undefined : findDef(index, star, name, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** 文本里按名字引用的同文件模块常量（`VIEW`、`SYNC` 这类 need 常量）的初始化文本。 */
function constantTexts(index: SourceIndex, file: string, text: string): string[] {
  const info = index.files.get(file);
  if (!info) return [];
  const names = new Set(text.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? []);
  return [...names].flatMap((name) => {
    const constant = info.consts.get(name);
    return constant ? [`${name} = ${constant.getText(info.sf)}`] : [];
  });
}

/** 文本里 `ns.fn` 形式、ns 为命名空间 import 的引用：展开为目标文件里的 fn（叶子文件不展开）。 */
function namespaceRefs(index: SourceIndex, file: string, text: string): { file: string; name: string }[] {
  const info = index.files.get(file);
  if (!info?.namespaces.size) return [];
  const out: { file: string; name: string }[] = [];
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g)) {
    const target = info.namespaces.get(match[1]!);
    if (target && !LEAF_FILES.has(target)) out.push({ file: target, name: match[2]! });
  }
  return out;
}

/** 处理函数文本 + 它（递归）引用的模块内函数文本；叶子文件不展开。`trace` 收集展开链（调试 / 统计）。 */
export function closureText(
  index: SourceIndex,
  registration: StaticRegistration,
  maxDepth = 6,
  trace?: string[],
): string {
  const parts: string[] = [
    registration.handlerText,
    ...constantTexts(index, registration.file, registration.handlerText),
  ];
  const visited = new Set<string>();
  const handlerNames = identifiers(registration.handlerText);
  const words = new Set([...registration.handlerText.matchAll(/\b[A-Za-z_$][\w$]*\b/g)].map((m) => m[0]));
  const dispatched = [...words].flatMap((name) =>
    (DISPATCH[`${path.relative(API_SRC, registration.file)}#${name}`] ?? []).map(([file, target]) => ({
      file: path.join(API_SRC, file),
      name: target,
      depth: 0,
    })),
  );
  const queue: { file: string; name: string; depth: number }[] = [
    ...handlerNames.map((name) => ({ file: registration.file, name, depth: 0 })),
    ...registration.extraRoots.map((name) => ({ file: registration.file, name, depth: 0 })),
    ...namespaceRefs(index, registration.file, registration.handlerText).map((ref) => ({ ...ref, depth: 0 })),
    ...dispatched,
  ];
  while (queue.length) {
    const item = queue.shift()!;
    const hit = findDef(index, item.file, item.name);
    if (!hit) continue;
    const key = `${hit.file}#${item.name}`;
    if (visited.has(key)) continue;
    visited.add(key);
    trace?.push(`${item.depth}:${path.relative(API_SRC, hit.file)}#${item.name}`);
    parts.push(hit.text);
    parts.push(...constantTexts(index, hit.file, hit.text));
    if (item.depth < maxDepth) {
      for (const name of identifiers(hit.text)) queue.push({ file: hit.file, name, depth: item.depth + 1 });
      for (const ref of namespaceRefs(index, hit.file, hit.text)) queue.push({ ...ref, depth: item.depth + 1 });
    }
  }
  return parts.join('\n');
}
