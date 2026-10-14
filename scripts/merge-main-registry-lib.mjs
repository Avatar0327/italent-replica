// F-133（DEC-491④）：pnpm merge:main 的“登记类”冲突自动合并（两边都加条目 → 取并集），单测见 tests/merge-main-registry.test.ts。
// 登记类 = 每个 PR 往同一个清单里各加几行的文件，加在同一个位置就必冲突，但内容上没有取舍：
//   ① F-039 登记：required/declared/<模块>.ts（声明集合，结构化合并）、required/declared/index.ts 与 required/index.ts（模块注册表）；
//   ② 路由登记：apps/api/src/app.ts（TENANT_MODULES 挂载）、packages/db/src/schema/index.ts（表导出）。
// 只处理“两边相对分叉点都是纯新增”的情形：任何一侧改了、删了已有条目，或写法超出已知形状，都不猜测，留给人工。
// 处理后逐项核对“本分支新增 ∪ main 新增”都在结果里、没有重复（verify*），缺一即失败。
import { resolveHunks } from './merge-main-lib.mjs';

const ROUTE_POLICY = 'tests/acceptance/support/route-policy';
export const DECLARED_DIR = `${ROUTE_POLICY}/required/declared`;
export const DECLARED_INDEX_PATH = `${DECLARED_DIR}/index.ts`;

/** required/declared/<模块>.ts（不含 index.ts）：F-124 起各模块自己的 F-039 声明集合。 */
export const isDeclaredModulePath = (file) => new RegExp(`^${DECLARED_DIR}/(?!index\\.ts$)[\\w-]+\\.ts$`).test(file);

const IMPORT_LINE = /^import (?:type )?\{ [\w$, ]+ \} from '[^']+';$/;
const REGISTRY_ENTRY_LINE = /^ {2}(?:'[\w-]+'|\w+): \w+,$/;

/**
 * 逐行登记文件：路径 → 允许自动合并的行形状。冲突处的每一行（本分支 / 分叉点 / main 三侧）都必须符合其中之一。
 * 挂载顺序有语义（路由先到先匹配），所以不重新排序：本分支一侧在前，main 新增的追加在后，结果只取决于两个输入。
 */
export const REGISTRY_LINE_FILES = Object.freeze({
  'apps/api/src/app.ts': [IMPORT_LINE, /^ {2}register\w+,(?: \/\/ .+)?$/],
  'packages/db/src/schema/index.ts': [
    /^export \* from '\.\/[\w-]+\.js';$/,
    /^export \{ [\w$, ]+ \} from '\.\/[\w-]+\.js';$/,
  ],
  [`${ROUTE_POLICY}/required/index.ts`]: [IMPORT_LINE, REGISTRY_ENTRY_LINE],
  [DECLARED_INDEX_PATH]: [IMPORT_LINE, REGISTRY_ENTRY_LINE],
});

/** 登记类文件（会走本模块的合并）；其余冲突照旧归“生成物”或“须人工处理”。 */
export const isRegistryPath = (file) => isDeclaredModulePath(file) || Object.hasOwn(REGISTRY_LINE_FILES, file);

/** 供 --check / 文档列出的边界。 */
export const REGISTRY_PATHS = Object.freeze([`${DECLARED_DIR}/<模块>.ts`, ...Object.keys(REGISTRY_LINE_FILES)]);

const nonBlank = (text) => (text ?? '').split('\n').filter((line) => line.trim());

// ---------------------------------------------------------------------------------------------
// 逐行登记文件

/** 一处冲突：三侧每行都是登记行、两侧相对分叉点都是纯新增 → 本分支一侧在前，main 新增的追加在后（去重）；否则 null。 */
export function unionLineHunk(patterns, { ours, base, theirs }) {
  const sides = [ours, base ?? '', theirs];
  if (sides.some((side) => side.split('\n').some((line, i, all) => !line.trim() && i < all.length - 1))) return null;
  const [o, b, t] = sides.map(nonBlank);
  if (![...o, ...b, ...t].every((line) => patterns.some((re) => re.test(line)))) return null;
  if (!b.every((line) => o.includes(line) && t.includes(line))) return null;
  const merged = [...new Set([...o, ...t])];
  return `${merged.join('\n')}\n`;
}

/** 逐行登记文件的冲突（diff3 文本）：每一处都满足 unionLineHunk 才算解决，否则原样保留标记，remaining 为剩余处数。 */
export function resolveLineRegistry(file, diff3Text) {
  const patterns = REGISTRY_LINE_FILES[file];
  if (!patterns) return null;
  return resolveHunks(diff3Text, (hunk) => unionLineHunk(patterns, hunk));
}

function lineProblems(file, text, { ours, base, theirs }) {
  const patterns = REGISTRY_LINE_FILES[file];
  const registry = (source) => nonBlank(source).filter((line) => patterns.some((re) => re.test(line)));
  const result = registry(text);
  const baseLines = new Set(registry(base));
  const problems = [];
  for (const [side, source] of [
    ['本分支', ours],
    ['main', theirs],
  ])
    for (const line of registry(source))
      if (!baseLines.has(line) && !result.includes(line)) problems.push(`${side}新增的登记项丢失：${line.trim()}`);
  for (const line of new Set(result))
    if (result.filter((l) => l === line).length > 1) problems.push(`登记项重复：${line.trim()}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// required/declared/<模块>.ts：结构化合并

/** 懒加载 typescript 与 prettier（根 devDependencies）；装不上时返回 undefined，调用方按“无法自动处理”回退人工。 */
export async function loadTools() {
  try {
    const [ts, prettier] = await Promise.all([import('typescript'), import('prettier')]);
    return { ts: ts.default ?? ts, prettier: prettier.default ?? prettier };
  } catch {
    return undefined;
  }
}

class Unsupported extends Error {}
const unsupported = (message) => {
  throw new Unsupported(message);
};

const itemId = (item) => JSON.stringify(item);
const itemParts = (item) => (Array.isArray(item) ? item : [item]);
function compareItems(a, b) {
  const [x, y] = [itemParts(a), itemParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    return (x[i] ?? '') < (y[i] ?? '') ? -1 : 1;
  }
  return 0;
}
const isSorted = (items) => items.every((item, i) => i === 0 || compareItems(items[i - 1], item) <= 0);

/**
 * 解析一份声明文件：`export const X: ModuleDeclared = { 键: [字符串 | [字符串…]…], … };`（文件里只有这一个变量语句）。
 * head = 对象字面量之前的全部文本（import、说明、`export const …=`），tail = 之后的文本。
 * 属性只能是“标识符: 数组”，元素只能是字符串或字符串元组，数组里不许有注释；超出这个形状一律 Unsupported。
 */
export function parseDeclared(ts, text) {
  const sf = ts.createSourceFile('declared.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = sf.statements.at(-1);
  if (!stmt || !ts.isVariableStatement(stmt) || sf.statements.filter(ts.isVariableStatement).length !== 1)
    unsupported('文件里不是“只有一个 export const 声明”的形状');
  const decls = stmt.declarationList.declarations;
  const literal = decls.length === 1 ? decls[0].initializer : undefined;
  if (!literal || !ts.isObjectLiteralExpression(literal)) unsupported('声明不是对象字面量');
  const keys = literal.properties.map((prop) => {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || !ts.isArrayLiteralExpression(prop.initializer))
      unsupported(`属性 ${prop.getText(sf)} 不是“键: 数组”`);
    const items = prop.initializer.elements.map((el) => {
      if (
        ts.getLeadingCommentRanges(text, el.getFullStart())?.length ||
        ts.getTrailingCommentRanges(text, el.getEnd())?.length
      )
        unsupported(`${prop.name.text} 的数组元素带注释`);
      if (ts.isStringLiteral(el)) return el.text;
      if (ts.isArrayLiteralExpression(el) && el.elements.every(ts.isStringLiteral))
        return el.elements.map((e) => e.text);
      return unsupported(`${prop.name.text} 的元素不是字符串或字符串元组：${el.getText(sf)}`);
    });
    const comment = (ts.getLeadingCommentRanges(text, prop.getFullStart()) ?? [])
      .map((range) => text.slice(range.pos, range.end).trim())
      .join('\n');
    return { name: prop.name.text, comment, items };
  });
  return { head: text.slice(0, literal.getStart(sf)), tail: text.slice(literal.getEnd()), keys };
}

const pick3 = (ours, base, theirs, what) => {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  return unsupported(`${what}两边都改了且不同`);
};

const quote = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const showItem = (item) => (Array.isArray(item) ? `[${item.map(quote).join(', ')}]` : quote(item));

/** 三方并集：删除也算（一侧删了另一侧没动 → 删除），两侧新增都保留；全有序则整体按码点排序，否则本分支顺序在前、main 新增在后。 */
function mergeItems(ours, base, theirs) {
  const ids = (items) => new Set(items.map(itemId));
  const [o, b, t] = [ids(ours), ids(base), ids(theirs)];
  const removed = new Set([...b].filter((id) => !o.has(id) || !t.has(id)));
  const seen = new Set();
  const merged = [...ours, ...theirs].filter((item) => {
    const id = itemId(item);
    if (removed.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [ours, base, theirs].every(isSorted) ? merged.sort(compareItems) : merged;
}

/** 写回文本：不带格式，交给 prettier。 */
function emitDeclared({ head, tail, keys }) {
  const body = keys
    .map(({ name, comment, items }) =>
      [comment, `${name}: [`, ...items.map((item) => `${showItem(item)},`), '],'].filter(Boolean).join('\n'),
    )
    .join('\n');
  return `${head}{\n${body}\n}${tail}`;
}

async function formatDeclared(tools, file, source) {
  const config = (await tools.prettier.resolveConfig(file)) ?? {};
  return tools.prettier.format(source, { ...config, parser: 'typescript', filepath: file });
}

/** 把一份声明文件解析再原样写回（含 prettier），用来守“合并后的写法与仓库里的文件逐字一致”。 */
export async function roundTripDeclared(tools, file, text) {
  return formatDeclared(tools, file, emitDeclared(parseDeclared(tools.ts, text)));
}

/**
 * 声明文件三方并集合并：返回 { text } 或 { error }（写法超出已知形状、头部 / 说明两边都改了且不同、并集校验失败）。
 * 属性顺序：本分支的在前，main 新增的种类追加在后；某种类合并后为空但任一侧写过它则保留空数组。
 */
export async function mergeDeclared(tools, file, { ours, base, theirs }) {
  try {
    const [o, b, t] = [ours, base, theirs].map((text) => parseDeclared(tools.ts, text));
    const find = (parsed, name) => parsed.keys.find((k) => k.name === name);
    const names = [...new Set([...o.keys, ...t.keys].map((k) => k.name))];
    const keys = names.map((name) => {
      const [ko, kb, kt] = [o, b, t].map((parsed) => find(parsed, name));
      const items = mergeItems(ko?.items ?? [], kb?.items ?? [], kt?.items ?? []);
      return {
        name,
        comment: pick3(ko?.comment, kb?.comment, kt?.comment, `${name} 的说明`) ?? '',
        items,
        keep: items.length > 0 || Boolean(ko || kt),
      };
    });
    const merged = {
      head: pick3(o.head, b.head, t.head, '文件头部（import / 说明 / 声明）'),
      tail: pick3(o.tail, b.tail, t.tail, '文件尾部'),
      keys: keys.filter((k) => k.keep),
    };
    const text = await formatDeclared(tools, file, emitDeclared(merged));
    const problems = declaredProblems(tools, text, { ours, base, theirs });
    return problems.length ? { error: problems.join('；') } : { text };
  } catch (error) {
    if (error instanceof Unsupported) return { error: error.message };
    throw error;
  }
}

/** 并集校验：本分支新增 ∪ main 新增都在结果里、结果无重复；任一侧写法超出已知形状也算问题（无法核对）。 */
export function declaredProblems(tools, text, { ours, base, theirs }) {
  try {
    const [r, o, b, t] = [text, ours, base, theirs].map((source) => parseDeclared(tools.ts, source));
    const itemsOf = (parsed, name) => parsed.keys.find((k) => k.name === name)?.items ?? [];
    const problems = [];
    const names = new Set([...o.keys, ...t.keys, ...r.keys].map((k) => k.name));
    for (const name of names) {
      const result = itemsOf(r, name).map(itemId);
      const baseIds = new Set(itemsOf(b, name).map(itemId));
      for (const [side, parsed] of [
        ['本分支', o],
        ['main', t],
      ])
        for (const item of itemsOf(parsed, name))
          if (!baseIds.has(itemId(item)) && !result.includes(itemId(item)))
            problems.push(`${side}新增的登记项丢失：${name} ${itemId(item)}`);
      for (const id of new Set(result))
        if (result.filter((x) => x === id).length > 1) problems.push(`登记项重复：${name} ${id}`);
    }
    return problems;
  } catch (error) {
    if (error instanceof Unsupported) return [error.message];
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// 统一入口

/**
 * 登记类冲突文件的自动合并：versions = { ours, base, theirs }（三侧完整文件），diff3 = git merge-file --diff3 的输出（逐行登记文件用）。
 * 返回 { text } 或 { error }；error 表示留给人工（文件原样不动，由调用方列入业务冲突）。
 */
export async function resolveRegistryFile(tools, file, { versions, diff3 }) {
  if (isDeclaredModulePath(file)) {
    if (!tools) return { error: '缺少 typescript / prettier，无法结构化合并声明文件' };
    if (Object.values(versions).some((text) => text === undefined))
      return { error: '一侧缺少该文件（新增 / 删除冲突）' };
    return mergeDeclared(tools, file, versions);
  }
  if (!Object.hasOwn(REGISTRY_LINE_FILES, file)) return { error: '不是登记类文件' };
  if (diff3 === undefined) return { error: '一侧缺少该文件（新增 / 删除冲突）' };
  const resolved = resolveLineRegistry(file, diff3);
  if (!resolved || resolved.remaining)
    return { error: '冲突处不是纯新增的登记行（改了或删了已有条目，或夹有其他代码）' };
  const problems = lineProblems(file, resolved.text, versions);
  return problems.length ? { error: problems.join('；') } : { text: resolved.text };
}

/** 合并结果（工作区文件）的并集校验：用于两边都改过的登记文件，包括 git 自动合并成功没有冲突的。返回问题清单。 */
export function registryProblems(tools, file, text, versions) {
  if (isDeclaredModulePath(file)) return tools ? declaredProblems(tools, text, versions) : [];
  return Object.hasOwn(REGISTRY_LINE_FILES, file) ? lineProblems(file, text, versions) : [];
}
