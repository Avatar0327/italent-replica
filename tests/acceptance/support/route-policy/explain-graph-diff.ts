/**
 * explain-graph-diff（F-072 PR-1，方案 §4.1、§4.4）：只读，不入 CI。把两份证据登记（merge-base 与当前）的差异，
 * 逐项对到本 PR 改过的源码文件上，列出“待说明项”：重算登记后，每个变化的节点都必须能由本 PR 的 diff 解释。
 *   ① 摘要变化：节点所在文件在 diff 里；绑定指纹 / 直接边变化：所在文件，或新旧解析链（每一跳）上任一文件在 diff 里；
 *   ② 新增节点：不限；
 *   ③ 删除节点：所在文件在 diff 里，或它在当前图里已不可达，且沿旧图能找到一条被删除的边、边的起点所在文件在 diff 里；
 *   ④ 不满足的项是待说明项，必须在 PR 描述里逐条说明。
 * 普通图只存绑定指纹（存完整清单会把登记体积翻一倍），所以绑定变化的新旧明细在这里从两份源码快照重算。
 * 命令行入口：scripts/explain-graph-diff.mjs。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type BoundaryEntry, EVIDENCE_BOUNDARY } from './evidence-boundary.js';
import { bindingsOf, type BindingLine, createClosureEnv, type SourceReader } from './evidence-closure.js';
import { fileOf, parseRegistry, type Registry } from './evidence-graph.js';
import { findUnitNode } from './evidence.js';

export type ExplainKind = 'digest' | 'binding' | 'edge' | 'added' | 'removed';

export interface ExplainItem {
  readonly node: string;
  readonly kind: ExplainKind;
  readonly explained: boolean;
  readonly reason: string;
  /** 绑定 / 边变化时，旧、新源码快照上的完整绑定清单。 */
  readonly old?: readonly string[];
  readonly new?: readonly string[];
}

export interface ExplainInput {
  readonly base: Registry;
  readonly head: Registry;
  /** 本 PR 改过的文件（仓库相对路径）。 */
  readonly diffFiles: ReadonlySet<string>;
  readonly readBase: SourceReader;
  readonly readHead: SourceReader;
  readonly boundary?: readonly BoundaryEntry[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const present = (registry: Registry, id: string) => id in registry.nodes || id in registry.unitBindings;
const digestOf = (registry: Registry, id: string) =>
  registry.nodes[id]?.[0] ?? registry.units[fileOf(id)]?.[id.slice(id.indexOf('#') + 1)];
const bindingOf = (registry: Registry, id: string) => registry.unitBindings[id] ?? registry.nodes[id]?.[1];

/** 解析链条目（`decl:文件#名字`、`文件#名字`、`namespace:文件`、`boundary:路径`…）里出现的文件。 */
function filesIn(lines: readonly BindingLine[]): string[] {
  const files = lines.flatMap((line) => line.resolved).map((hop) => hop.replace(/^(decl|namespace|boundary):/, ''));
  return files.map((hop) => (hop.includes('#') ? fileOf(hop) : hop)).filter((hop) => hop.endsWith('.ts'));
}

function bindingLines(read: SourceReader, boundary: readonly BoundaryEntry[], id: string): BindingLine[] {
  try {
    return [...bindingsOf(createClosureEnv(read, boundary, findUnitNode), id)];
  } catch {
    return [];
  }
}
const show = (line: BindingLine) => `${line.at}:${line.local} → ${line.resolved.join(' → ')}`;

/** 沿旧图，从被删除的边（起点所在文件在 diff 里）的终点可达的节点。 */
function removedByEdges(input: ExplainInput): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const [from, deps] of Object.entries(input.base.graph)) {
    if (!input.diffFiles.has(fileOf(from))) continue;
    for (const dep of deps.filter((d) => !(input.head.graph[from] ?? []).includes(d))) {
      const stack = [dep];
      while (stack.length) {
        const id = stack.pop()!;
        if (reasons.has(id)) continue;
        reasons.set(id, `沿被删除的边 ${from} → ${dep}（${fileOf(from)} 在 diff 里）`);
        stack.push(...(input.base.graph[id] ?? []));
      }
    }
  }
  return reasons;
}

export function explainGraphDiff(input: ExplainInput): { readonly items: readonly ExplainItem[] } {
  const boundary = input.boundary ?? EVIDENCE_BOUNDARY;
  const ids = new Set(
    [input.base, input.head].flatMap((r) => [...Object.keys(r.nodes), ...Object.keys(r.unitBindings)]),
  );
  const cut = removedByEdges(input);
  const items: ExplainItem[] = [];
  for (const id of [...ids].sort()) {
    const [was, now] = [present(input.base, id), present(input.head, id)];
    if (!was) items.push({ node: id, kind: 'added', explained: true, reason: '新增节点不限' });
    else if (!now) {
      const inDiff = input.diffFiles.has(fileOf(id));
      const reason = inDiff ? `所在文件 ${fileOf(id)} 在 diff 里` : cut.get(id);
      items.push({ node: id, kind: 'removed', explained: reason !== undefined, reason: reason ?? '无法解释的删除' });
    } else if (digestOf(input.base, id) !== digestOf(input.head, id)) {
      const explained = input.diffFiles.has(fileOf(id));
      items.push({
        node: id,
        kind: 'digest',
        explained,
        reason: explained ? `所在文件在 diff 里` : '未修改文件里的摘要变化',
      });
    } else {
      const edgesChanged = !sameSet(input.base.graph[id] ?? [], input.head.graph[id] ?? []);
      if (bindingOf(input.base, id) === bindingOf(input.head, id) && !edgesChanged) continue;
      const old = bindingLines(input.readBase, boundary, id);
      const next = bindingLines(input.readHead, boundary, id);
      const chain = [...new Set([fileOf(id), ...filesIn(old), ...filesIn(next)])];
      const hit = chain.filter((file) => input.diffFiles.has(file));
      items.push({
        node: id,
        kind: edgesChanged && bindingOf(input.base, id) === bindingOf(input.head, id) ? 'edge' : 'binding',
        explained: hit.length > 0,
        reason: hit.length ? `解析链上的 ${hit.join('、')} 在 diff 里` : '解析链上没有任何文件在 diff 里',
        old: old.map(show),
        new: next.map(show),
      });
    }
  }
  return { items };
}

/** 去掉序号后做多重集差：旧清单里没有对应的新行 / 新清单里没有对应的旧行（序号会因插入引用整体后移，不比较）。 */
function changedBindings(item: ExplainItem): { readonly old: string[]; readonly new: string[] } {
  const strip = (line: string) => line.replace(/^\d+:/, '');
  const minus = (from: readonly string[], other: readonly string[]) => {
    const rest = [...other.map(strip)];
    return from.map(strip).filter((line) => {
      const at = rest.indexOf(line);
      if (at < 0) return true;
      rest.splice(at, 1);
      return false;
    });
  };
  return { old: minus(item.old ?? [], item.new ?? []), new: minus(item.new ?? [], item.old ?? []) };
}

/** 命令行输出：先汇总，再列待说明项，最后列全部绑定 / 直接依赖变化的新旧目标（可解释的也要给人看到）。 */
export function formatExplanation(items: readonly ExplainItem[]): string {
  const count = (explained: boolean) => items.filter((i) => i.explained === explained).length;
  const head = (item: ExplainItem) =>
    `${item.explained ? '可解释' : '待说明'} ${item.kind} ${item.node}：${item.reason}`;
  const detail = (item: ExplainItem) => {
    const changed = changedBindings(item);
    return [...changed.old.map((l) => `    旧 ${l}`), ...changed.new.map((l) => `    新 ${l}`)];
  };
  const unexplained = items.filter((i) => !i.explained);
  const bindings = items.filter((i) => i.explained && (i.kind === 'binding' || i.kind === 'edge'));
  return [
    `可解释 ${count(true)} 项，待说明 ${count(false)} 项（待说明项必须在 PR 描述里逐条说明）`,
    ...unexplained.flatMap((item) => [head(item), ...detail(item)]),
    ...(bindings.length ? ['', `绑定 / 直接依赖变化 ${bindings.length} 项（新旧目标，请核对是否符合预期）：`] : []),
    ...bindings.flatMap((item) => [head(item), ...detail(item)]),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// 命令行：对比 merge-base 与工作区
// ---------------------------------------------------------------------------------------------------------------

const DIGESTS_DIR = 'tests/acceptance/support/route-policy/required/digests';
const runGit = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: 'pipe' });

/** `git show <ref>:<file>`；文件不存在时返回 undefined。 */
function gitShow(root: string, ref: string, file: string): string | undefined {
  try {
    return runGit(root, ['show', `${ref}:${file}`]);
  } catch {
    return undefined;
  }
}

function registryAt(read: (file: string) => string | undefined, graphFiles: readonly string[]): Registry {
  const files: Record<string, string> = {};
  for (const name of ['units.ts', 'nodes.ts']) files[name] = read(`${DIGESTS_DIR}/${name}`) ?? '';
  for (const name of graphFiles) files[`graph/${name}`] = read(`${DIGESTS_DIR}/graph/${name}`) ?? '';
  return parseRegistry(files);
}

const names = (output: string) =>
  output
    .split('\n')
    .filter(Boolean)
    .map((file) => path.basename(file));

/** 工作区里的登记：按目录实际内容枚举区域文件（含未跟踪、不含已删除）。 */
export function worktreeRegistry(root: string): Registry {
  const graphDir = path.join(root, DIGESTS_DIR, 'graph');
  const graphFiles = existsSync(graphDir) ? readdirSync(graphDir).filter((name) => name.endsWith('.ts')) : [];
  const read = (file: string) =>
    existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : undefined;
  return registryAt(read, graphFiles);
}

/**
 * 对比 `ref`（缺省 merge-base）与工作区。工作区侧按目录实际内容枚举区域文件：重算后、`git add` 之前，
 * 新增（未跟踪）与删除的区域文件都要读对；本分支改过的文件 = 与 ref 的差异 + 未跟踪文件。
 */
export function explainFromGit(root: string, baseRef?: string): { readonly items: readonly ExplainItem[] } {
  const ref = baseRef ?? runGit(root, ['merge-base', 'origin/main', 'HEAD']).trim();
  const diffFiles = new Set([
    ...runGit(root, ['diff', '--name-only', ref]).split('\n'),
    ...runGit(root, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ]);
  const readHead = (file: string) => readFileSync(path.join(root, file), 'utf8');
  return explainGraphDiff({
    base: registryAt(
      (file) => gitShow(root, ref, file),
      names(runGit(root, ['ls-tree', '--name-only', ref, `${DIGESTS_DIR}/graph/`])),
    ),
    head: worktreeRegistry(root),
    diffFiles,
    readBase: (file) => {
      const text = gitShow(root, ref, file);
      if (text === undefined) throw new Error(`${ref} 上没有 ${file}`);
      return text;
    },
    readHead,
  });
}
