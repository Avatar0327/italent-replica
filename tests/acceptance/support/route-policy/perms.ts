/**
 * 从声明树取**权限键**（F-039 PR-A 第 4 轮，DEC-348②；键的写法见 required/types.ts）。范围模式、字段、逐行路径、
 * 失败导入日志等是辅助元数据，不产生权限键（模型图准入与 optional.canEdit 共用 point 范围不构成冲突）。
 * 声明展开成析取范式：每个准入备选 = 一组同时成立的权限键；可选分支按名字各自汇总，不参与准入。
 * 每个键记下来源（节点路径 + 字段），供 required-mutate.ts 在声明树上精确删除 / 移动。
 */
import type { RoutePolicy } from '@italent/api';

/** 节点路径沿用 weakenings.ts：根 ''，`of[i].`、`optional.<名>.` 逐层拼接。 */
export interface PermSource {
  readonly path: string;
  readonly field:
    'kind' | 'operation' | 'button' | 'guards' | 'scope' | 'rows.operation' | 'rows.button' | 'rows.relation';
}

export type PermMap = Map<string, PermSource[]>;

export interface DeclaredPerms {
  readonly alternatives: PermMap[];
  /** 可选分支名 → 该分支（含其嵌套节点）授予的权限键。 */
  readonly optional: Map<string, PermMap>;
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

/** 节点自身（不含 of / optional 分支）授予的权限键。 */
export function nodePerms(node: Node, path: string): [string, PermSource][] {
  const out: [string, PermSource][] = [];
  const add = (perm: string | undefined, field: PermSource['field']) => {
    if (perm) out.push([perm, { path, field }]);
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

/** 一个可选分支（含其 of 与嵌套 optional）授予的全部键。 */
function branchPerms(node: Node, path: string): PermMap {
  const nested = Object.entries((node['optional'] as Record<string, Node> | undefined) ?? {}).map(([name, b]) =>
    branchPerms(b, `${path}optional.${name}.`),
  );
  const children = ((node['of'] as Node[] | undefined) ?? []).map((b, i) => branchPerms(b, `${path}of[${i}].`));
  return merge(own(node, path), ...children, ...nested);
}

/** 准入树里每个节点挂的可选分支（嵌套在 any / all 分支里的也算），按名字汇总。 */
function optionalBranches(node: Node, path: string, out: Map<string, PermMap>): void {
  for (const [name, branch] of Object.entries((node['optional'] as Record<string, Node> | undefined) ?? {})) {
    out.set(name, merge(out.get(name) ?? new Map(), branchPerms(branch, `${path}optional.${name}.`)));
  }
  ((node['of'] as Node[] | undefined) ?? []).forEach((b, i) => optionalBranches(b, `${path}of[${i}].`, out));
}

export function declaredPerms(policy: RoutePolicy): DeclaredPerms {
  const root = policy as unknown as Node;
  const optional = new Map<string, PermMap>();
  optionalBranches(root, '', optional);
  return { alternatives: alternatives(root, ''), optional };
}
