/**
 * 证据依赖闭包的登记结构与存储（F-072 PR-1，docs/08_设计/F-072_闭包边界降噪_方案.md §4）。
 * 旧形态 `required/digests.ts` 把“证据单元 → 依赖 → 摘要”平铺（同一依赖的摘要在几百个单元下各存一份）。
 * 新形态把共享的东西只存一份：
 *   units.ts      证据单元（根）→ 摘要，与根的绑定指纹
 *   nodes.ts      依赖节点 → [摘要, 绑定指纹]
 *   graph/<区域>  节点（含只作根的单元）→ 直接依赖列表（字典序），按节点所在文件分区域，减少并行 PR 的冲突
 * 闭包在校验时由图推出（closureFromGraph），不再存平铺闭包。本文件只管数据形状、渲染与解析，不读源码。
 */
import ts from 'typescript';
import { compareText, walk, type Walk } from './evidence-closure.js';
import type { Digests } from './required/types.js';

export type NodeRecord = readonly [digest: string, bindings: string];
export type Graph = Readonly<Record<string, readonly string[]>>;

export interface Registry {
  /** 证据单元（根）→ 摘要，按 文件 → 单元名（`DIGESTS`）。 */
  readonly units: Digests;
  /** 证据单元（根）→ 绑定指纹（`UNIT_BINDINGS`）；同时是“根的闭包已登记”的标记。 */
  readonly unitBindings: Readonly<Record<string, string>>;
  /** 依赖节点 → [摘要, 绑定指纹]（`NODE_DIGESTS`）。 */
  readonly nodes: Readonly<Record<string, NodeRecord>>;
  /** 节点 → 直接依赖（`GRAPH`；没有依赖的叶子不登记）。 */
  readonly graph: Graph;
}

/** 由登记图推出一个根的闭包：节点 → 上一跳，加最大层数与 depth-limit 节点（遍历与登记同为字典序）。 */
export function closureFromGraph(graph: Graph, root: string): Walk & { readonly deps: ReadonlyMap<string, string> } {
  const result = walk(root, (id) => graph[id] ?? []);
  return { ...result, deps: result.parents };
}

const fileOf = (id: string) => id.slice(0, id.indexOf('#'));

/** 登记里同文件的依赖写成 `#名字`（约四成直接边在同一文件内）；读入时还原成完整节点 id。 */
export function expandGraph(graph: Graph): Graph {
  return Object.fromEntries(
    Object.entries(graph).map(([id, deps]) => [id, deps.map((dep) => (dep.startsWith('#') ? fileOf(id) + dep : dep))]),
  );
}
const compactDeps = (id: string, deps: readonly string[]) =>
  deps.map((dep) => (fileOf(dep) === fileOf(id) ? dep.slice(dep.indexOf('#')) : dep));

const slug = (part: string) => part.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** 节点所在区域（graph/ 下的文件名）：模块各自一个区域，其余按顶层子目录；包根与 api 根各一个。 */
export function areaOf(id: string): string {
  const parts = fileOf(id).split('/');
  if (parts[0] === 'apps' && parts[1] === 'api' && parts[2] === 'src') {
    const rest = parts.slice(3);
    if (rest[0] === 'modules' && rest.length >= 3) return `api-modules-${slug(rest[1]!)}`;
    return rest.length === 1 ? 'api-root' : `api-${slug(rest[0]!)}`;
  }
  if (parts[0] === 'packages' && parts[2] === 'src') {
    const rest = parts.slice(3);
    return rest.length === 1 ? `${parts[1]}-root` : `${parts[1]}-${slug(rest[0]!)}`;
  }
  return parts[0] === 'tests' ? 'tests' : 'other';
}

// ---------------------------------------------------------------------------------------------------------------
// 渲染：与 prettier 的输出一致（单引号、能不加引号的键不加、超过 120 列的数组逐行、过长的字符串值换行），
// 生成后无需再跑 prettier，重复生成字节相同。
// ---------------------------------------------------------------------------------------------------------------

const WIDTH = 120;

function quote(text: string): string {
  const escaped = text.replaceAll('\\', '\\\\');
  return escaped.includes("'") && !escaped.includes('"') ? `"${escaped}"` : `'${escaped.replaceAll("'", "\\'")}'`;
}
const keyOf = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name));

function stringEntry(indent: string, name: string, value: string): string[] {
  const line = `${indent}${keyOf(name)}: ${quote(value)},`;
  return line.length <= WIDTH ? [line] : [`${indent}${keyOf(name)}:`, `${indent}  ${quote(value)},`];
}

function arrayEntry(indent: string, name: string, items: readonly string[]): string[] {
  const head = `${indent}${keyOf(name)}: [`;
  // 键本身过长时 prettier 在冒号后换行，数组缩进一层
  const [lead, pad] = head.length > WIDTH ? [[`${indent}${keyOf(name)}:`], `${indent}  `] : [[], indent];
  const inline = `${lead.length ? pad : `${indent}${keyOf(name)}: `}[${items.map(quote).join(', ')}],`;
  if (inline.length <= WIDTH) return [...lead, inline];
  const open = lead.length ? `${pad}[` : head;
  return [...lead, open, ...items.map((item) => `${pad}  ${quote(item)},`), `${pad}],`];
}

const sorted = <T>(entries: Iterable<[string, T]>) => [...entries].sort(([a], [b]) => compareText(a, b));
const HEADER_NOTE =
  ' * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。';
const header = (title: string) => ['/**', ` * ${title}`, HEADER_NOTE, ' */'];

/** 有超过 120 列的行（长路径键）才需要豁免 max-len；没有时加指令会触发“未使用的 disable 指令”警告。 */
const finish = (lines: readonly string[]): string => {
  const text = [...lines];
  if (text.some((line) => line.length > WIDTH)) {
    text.splice(text.indexOf(' */') + 1, 0, '/* eslint-disable max-len -- 生成文件，键含完整路径 */');
  }
  return text.join('\n');
};

function unitsFile(registry: Registry): string {
  const digests = sorted(Object.entries(registry.units)).flatMap(([file, names]) => [
    `  ${keyOf(file)}: {`,
    ...sorted(Object.entries(names)).flatMap(([name, digest]) => stringEntry('    ', name, digest)),
    '  },',
  ]);
  const bindings = sorted(Object.entries(registry.unitBindings)).flatMap(([unit, fp]) => stringEntry('  ', unit, fp));
  return finish([
    ...header('证据单元（闭包的根）的规范化摘要，与根的绑定指纹（evidence.ts；见 evidence-graph.ts）。'),
    "import type { Digests } from '../types.js';",
    '',
    'export const DIGESTS: Digests = {',
    ...digests,
    '};',
    '',
    '/** 根的绑定指纹：局部标识符 → 解析目标的按序清单的摘要（别名交换、转导出改指、遮蔽全局都会改变它）。 */',
    'export const UNIT_BINDINGS: Readonly<Record<string, string>> = {',
    ...bindings,
    '};',
    '',
  ]);
}

function nodesFile(registry: Registry): string {
  const entries = sorted(Object.entries(registry.nodes)).flatMap(([id, record]) => arrayEntry('  ', id, record));
  return finish([
    ...header('依赖节点的规范化摘要与绑定指纹（每个节点一行；共享依赖改实现只改这里的 1 行）。'),
    "import type { NodeRecord } from '../../evidence-graph.js';",
    '',
    'export const NODE_DIGESTS: Readonly<Record<string, NodeRecord>> = {',
    ...entries,
    '};',
    '',
  ]);
}

const GRAPH_TYPE_IMPORT = "import type { Graph } from '../../../evidence-graph.js';";

function areaFile(area: string, graph: Graph): string {
  const entries = sorted(Object.entries(graph)).flatMap(([id, deps]) => arrayEntry('  ', id, compactDeps(id, deps)));
  return finish([
    ...header(`直接依赖图：区域 ${area}（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。`),
    GRAPH_TYPE_IMPORT,
    '',
    'export const GRAPH: Graph = {',
    ...entries,
    '};',
    '',
  ]);
}

const identifierOf = (area: string) => area.replaceAll('-', '_');

function graphIndexFile(areas: readonly string[]): string {
  return finish([
    ...header('直接依赖图汇总：按区域文件拼成一张图（区域由生成器决定，新增区域时一并重写）。'),
    GRAPH_TYPE_IMPORT,
    ...areas.map((area) => `import { GRAPH as ${identifierOf(area)} } from './${area}.js';`),
    '',
    'export const GRAPH: Graph = {',
    ...areas.map((area) => `  ...${identifierOf(area)},`),
    '};',
    '',
  ]);
}

/** 登记 → 文件内容（键 = 相对 required/digests/ 的路径，不含手写的 index.ts）。 */
export function renderRegistry(registry: Registry): Record<string, string> {
  const byArea = new Map<string, Record<string, readonly string[]>>();
  for (const [id, deps] of Object.entries(registry.graph)) {
    const area = areaOf(id);
    byArea.set(area, { ...byArea.get(area), [id]: deps });
  }
  const areas = [...byArea.keys()].sort(compareText);
  return {
    'units.ts': unitsFile(registry),
    'nodes.ts': nodesFile(registry),
    ...Object.fromEntries(areas.map((area) => [`graph/${area}.ts`, areaFile(area, byArea.get(area)!)])),
    'graph/index.ts': graphIndexFile(areas),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 解析（explain-graph-diff 读 merge-base 上的登记；渲染往返测试）
// ---------------------------------------------------------------------------------------------------------------

type Literal = string | readonly Literal[] | { readonly [key: string]: Literal };

function literalOf(node: ts.Expression): Literal {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalOf);
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, Literal> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error('登记文件只允许字面量属性');
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) throw new Error('登记文件的键必须是标识符或字符串');
      out[name.text] = literalOf(property.initializer);
    }
    return out;
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return literalOf(node.expression);
  }
  throw new Error(`登记文件只允许字符串 / 数组 / 对象字面量：${node.getText()}`);
}

/** 文件里的 `export const NAME = { … }` → NAME → 字面量。 */
function constantsOf(name: string, text: string): Record<string, Literal> {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
  const out: Record<string, Literal> = {};
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        out[declaration.name.text] = literalOf(declaration.initializer);
      }
    }
  }
  return out;
}

/** 渲染结果（或 git 上同路径的文本）→ 登记。`graph/index.ts` 只是汇总，不读。 */
export function parseRegistry(files: Readonly<Record<string, string>>): Registry {
  const units = constantsOf('units.ts', files['units.ts'] ?? '');
  const nodes = constantsOf('nodes.ts', files['nodes.ts'] ?? '');
  const graph: Record<string, readonly string[]> = {};
  for (const [name, text] of Object.entries(files)) {
    if (!name.startsWith('graph/') || name === 'graph/index.ts') continue;
    Object.assign(graph, constantsOf(name, text)['GRAPH']);
  }
  return {
    units: (units['DIGESTS'] ?? {}) as Digests,
    unitBindings: (units['UNIT_BINDINGS'] ?? {}) as Readonly<Record<string, string>>,
    nodes: (nodes['NODE_DIGESTS'] ?? {}) as Readonly<Record<string, NodeRecord>>,
    graph: expandGraph(graph),
  };
}
