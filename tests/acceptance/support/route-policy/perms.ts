/**
 * 从声明树取**权限键**（F-039 PR-A 第 4 轮，DEC-348②；键的写法见 required/types.ts）。范围模式、字段、逐行路径、
 * 失败导入日志等是辅助元数据，不产生权限键（模型图准入与 optional.canEdit 共用 point 范围不构成冲突）。
 * 声明展开成析取范式：每个准入备选 = 一组同时成立的权限键；可选分支按名字各自展开成**自身**的析取范式，
 * 不参与准入（B-01：分支内的嵌套 optional 不计入，D1～D3 把位置 / 嵌套 / 名字当作结构错误报出）。
 * 每个键记下来源（节点路径 + 字段 + 该节点的范围），供 required-mutate.ts 在声明树上精确删除 / 移动，
 * 供 required.ts 把 `need` 绑定到提供权限的节点（B-03）。
 */
import type { RoutePolicy } from '@italent/api';
import type { Need } from './required/types.js';

/** 可选分支名（D3）：驼峰字母数字。节点路径按点号切分，名字里带点会找错分支（required-mutate.ts locate）。 */
export const OPTIONAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/** `missing` = byObject 里没有该对象也没有 `*`：范围缺失，不满足任何 need（不借用其他对象的范围）。 */
export type ScopeMode = 'point' | 'list' | 'see-all' | 'guard' | 'none' | 'missing';
/** 节点范围的签名：模式 + 名字（point = 定位器，list = 谓词，guard = 守卫名；see-all / none 无名字）。 */
export interface ScopeSig {
  readonly mode: ScopeMode;
  readonly name?: string;
}

/** 节点路径沿用 weakenings.ts：根 ''，`of[i].`、`optional.<名>.` 逐层拼接。 */
export interface PermSource {
  readonly path: string;
  readonly field:
    'kind' | 'operation' | 'button' | 'guards' | 'scope' | 'rows.operation' | 'rows.button' | 'rows.relation';
  /** 提供者是否承载范围（object / admin 节点）。 */
  readonly carrier: boolean;
  /** 该节点对这个权限适用的范围签名；按对象分范围时取该对象的，无法唯一确定则列出全部。 */
  readonly scopes: readonly ScopeSig[];
}

export type PermMap = Map<string, PermSource[]>;

export interface OptionalBranch {
  /** 分支节点路径，如 `optional.canApply.`。 */
  readonly path: string;
  /** 分支自身（不含嵌套 optional）的准入析取范式。 */
  readonly alternatives: PermMap[];
}

export interface LayoutViolation {
  readonly code: 'OPTIONAL_POSITION' | 'OPTIONAL_NESTED' | 'OPTIONAL_NAME';
  readonly name: string;
  readonly path: string;
}

export interface DeclaredPerms {
  readonly alternatives: PermMap[];
  /** 挂在声明根节点上的可选分支：名字 → 自身析取范式。 */
  readonly optional: Map<string, OptionalBranch>;
  /** D1～D3 的结构违规（整棵声明树扫描，含不在根上的分支）。 */
  readonly layout: LayoutViolation[];
}

type Node = Record<string, unknown>;
const DATA_OPERATIONS = new Set(['view', 'create', 'update', 'delete']);

function isNone(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'none' in (value as object);
}

const set = (values: readonly string[]) => {
  const unique = [...new Set(values)].sort();
  return unique.length === 1 ? unique[0]! : `{${unique.join(',')}}`;
};

/** 选择器的取值记号：静态值原样；参数 / 请求体 / 查询映射取值集合；映射函数与记录定位按名字。 */
function token(selector: unknown, value: (v: unknown) => string | undefined): string | undefined {
  if (selector === undefined || selector === null || isNone(selector)) return undefined;
  if (typeof selector !== 'object' || !('from' in (selector as object))) return value(selector);
  const s = selector as Node;
  if (s['from'] === 'mapper') return `{mapper:${String(s['mapper'])}}`;
  if (s['from'] === 'record') return `{record:${String(s['locator'])}.${String(s['attribute'])}}`;
  const values = Object.values((s['map'] as Node | undefined) ?? {})
    .map(value)
    .filter((v): v is string => v !== undefined);
  return values.length ? set(values) : undefined;
}

const objectToken = (selector: unknown) => token(selector, (v) => (typeof v === 'string' ? v : undefined));
const operationToken = (selector: unknown) =>
  token(selector, (v) => (typeof v === 'string' && DATA_OPERATIONS.has(v) ? v : undefined));
const buttonToken = (selector: unknown) =>
  token(selector, (v) => {
    const ref = v as { code?: string; level?: string } | undefined;
    return ref?.code ? `${ref.code}@${ref.level}` : undefined;
  });

function scopeGuards(scope: unknown): string[] {
  if (!scope || typeof scope !== 'object') return [];
  const s = scope as Node;
  const all = 'byObject' in s ? Object.values(s['byObject'] as Node) : [s];
  return all.flatMap((one) => ((one as Node)['mode'] === 'guard' ? [String((one as Node)['guard'])] : []));
}

function sigOf(scope: unknown): ScopeSig {
  if (!scope || typeof scope !== 'object') return { mode: 'none' };
  const s = scope as Node;
  switch (s['mode']) {
    case 'point':
      return { mode: 'point', name: String(s['locator']) };
    case 'list':
      return { mode: 'list', name: String(s['predicate']) };
    case 'guard':
      return { mode: 'guard', name: String(s['guard']) };
    case 'see-all':
      return { mode: 'see-all' };
    default:
      return { mode: 'none' };
  }
}

/** 对象选择器能取到的全部对象编码：静态值；param / body / query 映射的取值；mapper / record 登记的域。 */
export function objectsOf(selector: unknown): string[] | undefined {
  if (typeof selector === 'string') return [selector];
  if (!selector || typeof selector !== 'object' || !('from' in selector)) return undefined;
  const s = selector as Node;
  if (s['from'] === 'mapper' || s['from'] === 'record') return [...((s['domain'] as string[] | undefined) ?? [])];
  const values = Object.values((s['map'] as Node | undefined) ?? {}).filter((v): v is string => typeof v === 'string');
  return [...new Set(values)];
}

/**
 * 节点对其对象的范围签名，**按实际对象逐项选择**（#162 审查 P2-1）：byObject 里取该对象的条目，缺则取 `*`，都没有就是
 * `missing`（不借用其他对象的范围）；动态对象逐个对象各取一项，满足 need 时要求每一项都满足。
 * 对象取不到（不是对象节点）时无法逐项选择，列出全部条目，同样要求每一项都满足。
 */
function scopesOf(node: Node): ScopeSig[] {
  const scope = node['scope'] as Node | undefined;
  if (!scope || typeof scope !== 'object' || !('byObject' in scope)) return [sigOf(scope)];
  const by = scope['byObject'] as Node;
  const objects = objectsOf(node['object']);
  if (!objects?.length) return Object.values(by).map(sigOf);
  return objects.map((object) => {
    const entry = by[object] ?? by['*'];
    return entry ? sigOf(entry) : { mode: 'missing', name: object };
  });
}

/** 节点自身（不含 of / optional 分支）授予的权限键。 */
export function nodePerms(node: Node, path: string): [string, PermSource][] {
  const out: [string, PermSource][] = [];
  const carrier = node['kind'] === 'object' || node['kind'] === 'admin';
  const scopes = scopesOf(node);
  const add = (perm: string | undefined, field: PermSource['field']) => {
    if (perm) out.push([perm, { path, field, carrier, scopes }]);
  };
  for (const guard of (node['guards'] as string[] | undefined) ?? []) add(`guard:${guard}`, 'guards');
  for (const guard of scopeGuards(node['scope'])) add(`guard:${guard}`, 'scope');
  const object = objectToken(node['object']);
  const rows = node['rows'] as Node | undefined;
  switch (node['kind']) {
    case 'admin':
      add(`admin:${String(node['capability'])}`, 'kind');
      break;
    case 'own':
      add(`own:${String(node['predicate'])}`, 'kind');
      break;
    case 'exception':
      add(`exception:${String(node['guard'])}`, 'kind');
      break;
    case 'self': {
      add('self', 'kind');
      const button = buttonToken(node['button']);
      if (button) add(`btn:self#${button}`, 'button');
      break;
    }
    case 'relation': {
      const relation = token(node['relation'], (v) => (typeof v === 'string' ? v : undefined));
      add(`rel:${relation}`, 'kind');
      break;
    }
    case 'button': {
      const button = buttonToken(node['button']);
      if (object && button) add(`btn:${object}#${button}`, 'kind');
      break;
    }
    case 'object': {
      const operation = operationToken(node['operation']);
      if (object && operation) add(`obj:${object}:${operation}`, 'operation');
      const button = buttonToken(node['button']);
      if (object && button) add(`btn:${object}#${button}`, 'button');
      break;
    }
  }
  if (rows) {
    const operation = operationToken(rows['operation']);
    if (object && operation) add(`obj:${object}:${operation}`, 'rows.operation');
    const button = buttonToken(rows['button']);
    if (button) add(`btn:${object ?? '*'}#${button}`, 'rows.button');
    const relation = token(rows['relation'], (v) => (typeof v === 'string' ? v : undefined));
    if (relation) add(`rel:${relation}`, 'rows.relation');
  }
  return out;
}

function merge(...maps: PermMap[]): PermMap {
  const out: PermMap = new Map();
  for (const map of maps) {
    for (const [perm, sources] of map) out.set(perm, [...(out.get(perm) ?? []), ...sources]);
  }
  return out;
}

function own(node: Node, path: string): PermMap {
  const out: PermMap = new Map();
  for (const [perm, source] of nodePerms(node, path)) out.set(perm, [...(out.get(perm) ?? []), source]);
  return out;
}

/** 析取范式：any = 各分支备选并列；all = 各分支备选的笛卡尔积；组合节点自身的键并入每个备选。 */
function alternatives(node: Node, path: string): PermMap[] {
  const self = own(node, path);
  const branches = (node['of'] as Node[] | undefined) ?? [];
  if (node['kind'] === 'any') {
    return branches.flatMap((branch, i) => alternatives(branch, `${path}of[${i}].`)).map((alt) => merge(self, alt));
  }
  if (node['kind'] === 'all') {
    let product: PermMap[] = [self];
    branches.forEach((branch, i) => {
      const options = alternatives(branch, `${path}of[${i}].`);
      product = product.flatMap((acc) => options.map((alt) => merge(acc, alt)));
    });
    return product;
  }
  return [self];
}

/** 扫描整棵声明树的可选分支：D1 只挂根、D2 不嵌套、D3 名字字符集。 */
function layoutOf(node: Node, path: string, inBranch: boolean, out: LayoutViolation[]): void {
  for (const [name, branch] of Object.entries((node['optional'] as Record<string, Node> | undefined) ?? {})) {
    const at = `${path}optional.${name}.`;
    if (!OPTIONAL_NAME_PATTERN.test(name)) out.push({ code: 'OPTIONAL_NAME', name, path: at });
    if (inBranch) out.push({ code: 'OPTIONAL_NESTED', name, path: at });
    else if (path !== '') out.push({ code: 'OPTIONAL_POSITION', name, path: at });
    layoutOf(branch, at, true, out);
  }
  ((node['of'] as Node[] | undefined) ?? []).forEach((b, i) => layoutOf(b, `${path}of[${i}].`, inBranch, out));
}

export function declaredPerms(policy: RoutePolicy): DeclaredPerms {
  const root = policy as unknown as Node;
  const optional = new Map<string, OptionalBranch>();
  for (const [name, branch] of Object.entries((root['optional'] as Record<string, Node> | undefined) ?? {})) {
    const path = `optional.${name}.`;
    optional.set(name, { path, alternatives: alternatives(branch, path) });
  }
  const layout: LayoutViolation[] = [];
  layoutOf(root, '', false, layout);
  return { alternatives: alternatives(root, ''), optional, layout };
}

/** 可选分支各备选授予的权限键并集。 */
export function branchPerms(branch: OptionalBranch): Set<string> {
  return new Set(branch.alternatives.flatMap((alt) => [...alt.keys()]));
}

/** 签名集合是否**每一项**都满足 need：模式相等，且 need 写了名字就要相等（`missing` 永不满足）。 */
export function scopeMatches(scopes: readonly ScopeSig[], need: Need | undefined): boolean {
  if (!need) return true;
  const wanted = need.locator ?? need.predicate ?? need.guard;
  return scopes.every((sig) => sig.mode === need.scope && (wanted === undefined || sig.name === wanted));
}

/** 备选里是否有提供 perm 且范围满足 need 的来源节点。 */
export function provides(alt: PermMap, perm: string, need?: Need): boolean {
  return (alt.get(perm) ?? []).some((source) => scopeMatches(source.scopes, need));
}
