/**
 * 静态依赖图守卫的 TypeScript AST 实现（BE-7 PT-3a 审查 P3①，不靠正则 / grep）：
 * 沿源码里的运行时模块引用走图——`import … from`、裸 `import './x'`、`export … from`、`import('./x')`、
 * `import x = require('./x')`、`require('./x')`——所以 `import './index.js'` 这类不带 from 的绕路引用也算；
 * 注释、字符串里碰巧出现的 import 文本不算；`import type` / `export type … from` 编译后被擦除，不是运行时边。
 * 文件系统通过 SourceHost 注入，负例可以用虚拟文件，不依赖真实目录。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

export interface SourceHost {
  /** 文件内容；不存在或不是文件返回 undefined。 */
  read(file: string): string | undefined;
}

export const fileSystemHost: SourceHost = {
  read: (file) => (existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined),
};

/** 一个文件里的全部运行时模块说明符（按出现顺序）。 */
export function runtimeSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const literal = (node: ts.Node | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) literal(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly) literal(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      literal(node.moduleReference.expression);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      literal(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 相对说明符解析成 host 里存在的文件：ESM 的 .js 写法对应 .ts / .tsx、省略扩展名、目录入口 index.ts。 */
export function resolveRelative(from: string, specifier: string, host: SourceHost): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.(?:js|mjs)$/, '');
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')];
  return candidates.find((candidate) => host.read(candidate) !== undefined);
}

export interface ImportTarget {
  /** 绝对路径的目标文件（如 apps/api/src/index.ts）。 */
  readonly files?: readonly string[];
  /** 包名（精确或子路径）：如 '@italent/api'。 */
  readonly packages?: readonly string[];
}

const isPackage = (specifier: string, name: string) => specifier === name || specifier.startsWith(`${name}/`);

/** 从 entry 出发的静态依赖图里，第一条会加载目标的链（entry → … → 目标）；没有返回 null。 */
export function importChainTo(entry: string, target: ImportTarget, host: SourceHost = fileSystemHost): string[] | null {
  const seen = new Set<string>();
  const visit = (file: string, chain: readonly string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file, host.read(file) ?? '')) {
      if (target.packages?.some((name) => isPackage(specifier, name))) return [...chain, file, specifier];
      const resolved = resolveRelative(file, specifier, host);
      if (!resolved) continue;
      if (target.files?.includes(resolved)) return [...chain, file, resolved];
      const found = visit(resolved, [...chain, file]);
      if (found) return found;
    }
    return null;
  };
  return visit(entry, []);
}

/** 目录下哪些文件直接引用了 target（解析后等于 target）；用于“只被某个文件引用”的守卫。 */
export function directImporters(files: readonly string[], target: string, host: SourceHost = fileSystemHost): string[] {
  return files.filter((file) =>
    runtimeSpecifiers(file, host.read(file) ?? '').some((specifier) => resolveRelative(file, specifier, host) === target),
  );
}
