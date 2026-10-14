// F-133（DEC-491④）：pnpm merge:main 的“登记类”冲突自动合并（两边都加条目 → 取并集），单测见 tests/merge-main-registry.test.ts。
// 登记类 = 每个 PR 往同一个清单里各加几行的文件，加在同一个位置就必冲突，但内容上没有取舍：
//   ① F-039 登记：required/declared/<模块>.ts（声明集合，结构化合并）、required/declared/index.ts 与 required/index.ts（模块注册表）；
//   ② 路由登记：apps/api/src/app.ts（TENANT_MODULES 挂载）、packages/db/src/schema/index.ts（表导出）。
//
// 第 2 轮返工（DEC-431①）：自动合并与提交前核对共用同一个“登记区解析器”（parseEntries）和同一个比较函数（compareEntries），
// 一律按条目身份（导入绑定、挂载函数、注册键、导出名、声明条目）比较，不再按整行比较：
//   - 解析不了的形状（登记区里的未知语句、变量找不到、数组元素不是字符串……）= 无法核对 = 失败；
//   - 自动合并（strict）只收“两边相对分叉点都是纯新增”：任一边删除或改动分叉点已有条目、同一身份两边值不同，都转人工；
//   - 提交前核对（非 strict，含 Git 无冲突自动合并、人工解决过的文件）：每个身份必须等于“谁改了就听谁的”的期望值，不许重复。
import { resolveHunks } from './merge-main-lib.mjs';

const ROUTE_POLICY = 'tests/acceptance/support/route-policy';
export const DECLARED_DIR = `${ROUTE_POLICY}/required/declared`;
export const DECLARED_INDEX_PATH = `${DECLARED_DIR}/index.ts`;

/** required/declared/<模块>.ts（不含 index.ts）：F-124 起各模块自己的 F-039 声明集合。 */
export const isDeclaredModulePath = (file) => new RegExp(`^${DECLARED_DIR}/(?!index\\.ts$)[\\w-]+\\.ts$`).test(file);

const IMPORT_LINE = /^import (?:type )?\{ [\w$, ]+ \} from '[^']+';$/;
const REGISTRY_ENTRY_LINE = /^ {2}(?:'[\w-]+'|\w+): \w+,$/;

/**
 * 逐行登记文件：路径 → 冲突处允许自动合并的行形状（只是冲突处的预筛；真正的接受条件是整份结果通过 registryProblems）。
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

/**
 * 逐行登记文件的登记区（解析器按它取条目）：
 * imports = 文件里所有 import 声明（按导入绑定）；exports = 文件里只许有 export … from 声明，别的语句 = 无法识别；
 * arrays / objects = 按变量名找数组 / 对象字面量（找不到 = 无法识别），按元素文本 / 属性键取条目。
 */
export const REGISTRY_REGIONS = Object.freeze({
  'apps/api/src/app.ts': { imports: true, arrays: ['TENANT_MODULES'] },
  'packages/db/src/schema/index.ts': { exports: true },
  [`${ROUTE_POLICY}/required/index.ts`]: { imports: true, objects: ['REQUIRED_BY_MODULE'] },
  [DECLARED_INDEX_PATH]: { imports: true, objects: ['DECLARED'] },
});

/** 登记类文件（会走本模块的合并）；其余冲突照旧归“生成物”或“须人工处理”。 */
export const isRegistryPath = (file) => isDeclaredModulePath(file) || Object.hasOwn(REGISTRY_LINE_FILES, file);

/** 供 --check / 文档列出的边界。 */
export const REGISTRY_PATHS = Object.freeze([`${DECLARED_DIR}/<模块>.ts`, ...Object.keys(REGISTRY_LINE_FILES)]);

const nonBlank = (text) => (text ?? '').split('\n').filter((line) => line.trim());

class Unsupported extends Error {}
const unsupported = (message) => {
  throw new Unsupported(message);
};

// ---------------------------------------------------------------------------------------------
// 逐行登记文件：冲突处的行合并（预筛）

/** 一处冲突：三侧每行都是登记行、两侧相对分叉点都是纯新增 → 本分支一侧在前，main 新增的追加在后（整行去重）；否则 null。 */
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

// ---------------------------------------------------------------------------------------------
// 登记区解析器：文本 → 条目 [{ id, value }]（同一个 id 出现多次就是重复，由比较函数报告）

/** 懒加载 typescript 与 prettier（根 devDependencies）；装不上时返回 undefined，调用方按“无法自动处理 / 无法核对”失败。 */
export async function loadTools() {
  try {
    const [ts, prettier] = await Promise.all([import('typescript'), import('prettier')]);
    return { ts: ts.default ?? ts, prettier: prettier.default ?? prettier };
  } catch {
    return undefined;
  }
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();

function importEntries(ts, stmt) {
  const from = stmt.moduleSpecifier.text;
  const clause = stmt.importClause;
  if (!clause) return [{ id: `import-side-effect:${from}`, value: from }];
  const type = clause.isTypeOnly ? 'type ' : '';
  const entries = [];
  if (clause.name) entries.push({ id: `import:${clause.name.text}`, value: `${type}${from}#default` });
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings))
    entries.push({ id: `import:${bindings.name.text}`, value: `${type}${from}#*` });
  else if (bindings)
    for (const el of bindings.elements) {
      const kind = el.isTypeOnly ? 'type ' : type;
      entries.push({ id: `import:${el.name.text}`, value: `${kind}${from}#${(el.propertyName ?? el.name).text}` });
    }
  return entries;
}

function exportEntries(ts, sf, stmt) {
  if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier)
    return unsupported(`登记区里只许有 export … from，遇到：${squash(stmt.getText(sf)).slice(0, 60)}`);
  const from = stmt.moduleSpecifier.text;
  const type = stmt.isTypeOnly ? 'type ' : '';
  const clause = stmt.exportClause;
  if (!clause) return [{ id: `export*:${from}`, value: `${type}${from}` }];
  if (ts.isNamespaceExport(clause)) return [{ id: `export:${clause.name.text}`, value: `${type}${from}#*` }];
  return clause.elements.map((el) => ({
    id: `export:${el.name.text}`,
    value: `${el.isTypeOnly ? 'type ' : type}${from}#${(el.propertyName ?? el.name).text}`,
  }));
}

function unwrap(ts, node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current))
  )
    current = current.expression;
  return current;
}

function findInitializer(ts, sf, name) {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations)
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return unwrap(ts, decl.initializer);
  }
  return unsupported(`找不到 ${name}`);
}

/** 数组元素只认直接标识符（挂载函数名）：`mount(c)` / `mount( c )` / 展开等文本身份不稳定，一律拒绝，不猜。 */
function arrayEntries(ts, sf, name) {
  const literal = findInitializer(ts, sf, name);
  if (!literal || !ts.isArrayLiteralExpression(literal)) return unsupported(`${name} 不是数组字面量`);
  return literal.elements.map((el) => {
    if (!ts.isIdentifier(el))
      return unsupported(`${name} 里有不是直接标识符的元素：${squash(el.getText(sf)).slice(0, 60)}`);
    return { id: `array:${name}:${el.text}`, value: el.text };
  });
}

function objectEntries(ts, sf, name) {
  const literal = findInitializer(ts, sf, name);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return unsupported(`${name} 不是对象字面量`);
  return literal.properties.map((prop) => {
    if (ts.isShorthandPropertyAssignment(prop))
      return { id: `object:${name}:${prop.name.text}`, value: prop.name.text };
    const keyed = ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name));
    if (!keyed) return unsupported(`${name} 里有无法识别的属性：${squash(prop.getText(sf)).slice(0, 60)}`);
    return { id: `object:${name}:${prop.name.text}`, value: squash(prop.initializer.getText(sf)) };
  });
}

/**
 * required/declared/<模块>.ts 的结构：`export const X: ModuleDeclared = { 键: [字符串 | [字符串…]…], … };`（文件里只有这一个变量语句）。
 * head = 对象字面量之前的全部文本（import、说明、`export const …=`），tail = 之后的文本。
 * 属性只能是“标识符: 数组”，元素只能是字符串或字符串元组，数组里不许有注释；超出这个形状一律无法识别。
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

const itemId = (item) => JSON.stringify(item);

/**
 * 登记区解析：把一份登记类文件取成条目列表。无法识别的形状抛 Unsupported（调用方当“无法核对 = 失败”）。
 * 声明文件：每个（种类, 条目）一个条目；逐行登记文件：按 REGISTRY_REGIONS 取导入绑定 / 导出名 / 数组元素 / 对象属性。
 */
export function parseEntries(tools, file, text) {
  const { ts } = tools;
  if (isDeclaredModulePath(file))
    return parseDeclared(ts, text).keys.flatMap((key) =>
      key.items.map((item) => ({ id: `declared:${key.name}:${itemId(item)}`, value: '1' })),
    );
  const region = REGISTRY_REGIONS[file];
  if (!region) return unsupported('不是登记类文件');
  const sf = ts.createSourceFile('registry.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entries = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && region.imports) entries.push(...importEntries(ts, stmt));
    else if (region.exports) entries.push(...exportEntries(ts, sf, stmt));
  }
  for (const name of region.arrays ?? []) entries.push(...arrayEntries(ts, sf, name));
  for (const name of region.objects ?? []) entries.push(...objectEntries(ts, sf, name));
  return entries;
}

// ---------------------------------------------------------------------------------------------
// 比较：自动合并（strict）与提交前核对（非 strict）共用

const show = (value) => (value === undefined ? '无' : value);

function toMap(entries) {
  const map = new Map();
  const duplicates = new Set();
  for (const { id, value } of entries) {
    if (map.has(id)) duplicates.add(id);
    else map.set(id, value);
  }
  return { map, duplicates };
}

/**
 * 逐个条目身份比较结果与三侧，返回问题清单（空 = 通过）。
 * - 结果里同一身份出现多次 = 重复（同一键两边值不同、同一挂载函数两边各加一份，不论是否有 Git 冲突）；
 * - strict（自动合并）：分叉点已有的条目任一边删除或改动 = 须人工；同一身份两边都新增且值不同 = 冲突；结果必须正好是两边新增的并集；
 * - 非 strict（提交前核对，含人工解决过的文件）：期望值 = 只有一边改了就取那一边，两边都改成不同的值时由人决定（结果里有一份即可）；
 *   结果与期望不符（丢了、多了、值不对）都算问题。
 */
export function compareEntries({ result, ours, base, theirs }, { strict = false } = {}) {
  const [r, o, b, t] = [result, ours, base, theirs].map(toMap);
  const problems = [...r.duplicates].map((id) => `登记项重复：${id}（需要只留一份；同一身份的值两边不一致时由人选择）`);
  const ids = new Set([...r.map.keys(), ...o.map.keys(), ...b.map.keys(), ...t.map.keys()]);
  for (const id of ids) {
    const [vr, vo, vb, vt] = [r, o, b, t].map((side) => side.map.get(id));
    if (strict && vb !== undefined && (vo !== vb || vt !== vb)) {
      problems.push(
        `分叉点已有登记项被一侧删除或改动，须人工：${id}（分叉点 ${show(vb)}／本分支 ${show(vo)}／main ${show(vt)}）`,
      );
      continue;
    }
    if (strict && vb === undefined && vo !== undefined && vt !== undefined && vo !== vt) {
      problems.push(`同一登记项两边值不同，须人工：${id}（本分支 ${show(vo)}／main ${show(vt)}）`);
      continue;
    }
    if (!strict && vo !== vb && vt !== vb && vo !== vt) {
      // 两边都改成不同的值：由人决定“值”，但两边都还保留着的身份必须仍然存在（不能借“人工决定”把它删掉）
      if (vo !== undefined && vt !== undefined && vr === undefined)
        problems.push(
          `登记项丢失：${id}（两边都有，值不同可由人选择，但不能删除；本分支 ${show(vo)}／main ${show(vt)}）`,
        );
      continue;
    }
    const expected = vo === vt || vt === vb ? vo : vo === vb ? vt : (vo ?? vt);
    if (vr === expected) continue;
    if (vr === undefined) problems.push(`登记项丢失：${id}（应为 ${show(expected)}）`);
    else if (expected === undefined) problems.push(`多出的登记项：${id}（值 ${show(vr)}）`);
    else problems.push(`登记项的值不符：${id}（应为 ${show(expected)}，实为 ${show(vr)}）`);
  }
  return problems;
}

/**
 * 登记类文件合并结果的**最终不变式**（无条件，提交前对每个登记文件都算，不看哪一边改过）：
 * 应有身份集合 = 分叉点保留项（两边都还在）∪ 本分支新增 ∪ main 新增，结果里每个身份必须存在且恰好一份；
 * 人工决定的同键异值只放宽“值等于哪一边”，不放宽“必须存在”；应有集合非空而文件缺失 = 失败。
 * 某一侧没有这个文件按“没有任何条目”算（新增 / 删除都走同一套比较）；四侧都没有则没有可核对的内容，通过。
 * 缺工具、结果里有无法识别的形状，都返回问题（无法核对 = 失败）。
 */
export function registryProblems(tools, file, text, versions, options) {
  const sources = { result: text, ours: versions.ours, base: versions.base, theirs: versions.theirs };
  if (Object.values(sources).every((source) => source === undefined)) return [];
  if (!tools) return ['缺少 typescript / prettier，无法核对登记项'];
  try {
    const entries = Object.fromEntries(
      Object.entries(sources).map(([side, source]) => [
        side,
        source === undefined ? [] : parseEntries(tools, file, source),
      ]),
    );
    const problems = compareEntries(entries, options);
    if (text === undefined && problems.length) problems.unshift('登记文件缺失（两边应有的登记项见下）');
    return problems;
  } catch (error) {
    if (error instanceof Unsupported) return [`登记区里有无法识别的形状，不能核对：${error.message}`];
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// required/declared/<模块>.ts：结构化并集（生成结果，是否接受由 registryProblems(strict) 决定）

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

const pick3 = (ours, base, theirs, what) => {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  return unsupported(`${what}两边都改了且不同`);
};

const quote = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const showItem = (item) => (Array.isArray(item) ? `[${item.map(quote).join(', ')}]` : quote(item));

/** 并集（去重）：三份都有序则整体按码点排序，否则本分支顺序在前、main 新增在后。删除不在这里处理，由 strict 比较拒绝。 */
function unionItems(ours, base, theirs) {
  const seen = new Set();
  const merged = [...ours, ...theirs].filter((item) => {
    const id = itemId(item);
    if (seen.has(id)) return false;
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
 * 声明文件三方并集合并：返回 { text } 或 { error }（写法超出已知形状、头部 / 说明两边都改了且不同、strict 比较不通过）。
 * 属性顺序：本分支的在前，main 新增的种类追加在后；某种类合并后为空但任一侧写过它则保留空数组。
 */
export async function mergeDeclared(tools, file, { ours, base, theirs }) {
  try {
    const [o, b, t] = [ours, base, theirs].map((text) => parseDeclared(tools.ts, text));
    const find = (parsed, name) => parsed.keys.find((k) => k.name === name);
    const names = [...new Set([...o.keys, ...t.keys].map((k) => k.name))];
    const keys = names.map((name) => {
      const [ko, kb, kt] = [o, b, t].map((parsed) => find(parsed, name));
      return {
        name,
        comment: pick3(ko?.comment, kb?.comment, kt?.comment, `${name} 的说明`) ?? '',
        items: unionItems(ko?.items ?? [], kb?.items ?? [], kt?.items ?? []),
      };
    });
    const merged = {
      head: pick3(o.head, b.head, t.head, '文件头部（import / 说明 / 声明）'),
      tail: pick3(o.tail, b.tail, t.tail, '文件尾部'),
      keys,
    };
    const text = await formatDeclared(tools, file, emitDeclared(merged));
    const problems = registryProblems(tools, file, text, { ours, base, theirs }, { strict: true });
    return problems.length ? { error: problems.join('；') } : { text };
  } catch (error) {
    if (error instanceof Unsupported) return { error: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// 统一入口

/**
 * 登记类冲突文件的自动合并：versions = { ours, base, theirs }（三侧完整文件），diff3 = git merge-file --diff3 的输出（逐行登记文件用）。
 * 返回 { text } 或 { error }；error 表示留给人工（文件原样不动，由调用方列入业务冲突）。
 * 两类文件的接受条件相同：整份结果通过 registryProblems(strict)。
 */
export async function resolveRegistryFile(tools, file, { versions, diff3 }) {
  if (!isRegistryPath(file)) return { error: '不是登记类文件' };
  if (!tools) return { error: '缺少 typescript / prettier，无法解析登记区' };
  if (Object.values(versions).some((text) => text === undefined)) return { error: '一侧缺少该文件（新增 / 删除冲突）' };
  if (isDeclaredModulePath(file)) return mergeDeclared(tools, file, versions);
  if (diff3 === undefined) return { error: '一侧缺少该文件（新增 / 删除冲突）' };
  const resolved = resolveLineRegistry(file, diff3);
  if (!resolved || resolved.remaining)
    return { error: '冲突处不是纯新增的登记行（改了或删了已有条目，或夹有其他代码）' };
  const problems = registryProblems(tools, file, resolved.text, versions, { strict: true });
  return problems.length ? { error: problems.join('；') } : { text: resolved.text };
}
