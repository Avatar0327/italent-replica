/**
 * 从声明树提取“声明了什么”（比较器用，F-039 PR-A §4.4 限定版；实现审第 1 轮 P2-1 改为保留分支语义）。
 * 声明展开成**析取范式**：每个备选准入路径（alternative）是一组同时成立的义务——
 *   all = 各分支备选的笛卡尔积（义务取并）；any = 各分支备选的并列；叶子 = 一个备选；
 *   组合节点自身的守卫 / write 并入它下面的每个备选。
 * 比较器要求**每个**备选都不弱于基准，所以“删 all 的分支”“all → any”“any 的一个分支降成员”都会让某个备选缺义务。
 * 可选分支（optional）不参与准入，单独汇总，只用于出口类维度与过度声明判断。
 * 维度口径与 primitives.ts 的基准维度一一对应：admin / object / button / scope / scopePoint / fieldsOut / fieldsIn /
 * relation / self / own / postcheck / failureAudit / write；守卫与前提按名字；选择器按分支键集合，在路由级与基准绑定的域比较。
 */
import type { FieldsPolicy, ObjectPolicy, RoutePolicy, RowsPolicy, ScopePolicy, WritePolicy } from '@italent/api';

export type Identity = 'public' | 'platform' | 'tenant';

/** 一个备选准入路径的义务。 */
export interface Alternative {
  readonly dims: Set<string>;
  readonly guards: Set<string>;
  readonly preconditions: Set<string>;
  /** 对象节点覆盖的 `对象编码:数据操作`（选择器展开为各分支）。 */
  readonly objects: Set<string>;
  /** 准入是否要求成员身份之外的权限（admin / object / button / self / relation / exception / platform 或守卫）。 */
  privileged: boolean;
}

export interface Declared {
  identity: Identity;
  readonly alternatives: Alternative[];
  /** 可选分支（不参与准入）的义务并集。 */
  readonly optional: Alternative;
  /** 全部节点（含可选分支）的义务并集：用于路由级的写入口与过度声明判断。 */
  readonly union: Alternative;
  /** 每个动态选择器的分支键集合（含可选分支）。 */
  readonly selectors: string[][];
}

/** 只记台账 / 审计足迹、不是范围复核的 footprint 名（配置命令、权限命令、平台命令）。 */
export const LEDGER_ONLY_FOOTPRINTS =
  /^(config\.audited|permission\.adminCommand|permission\.platformUser|platform\.ledger)/;

export function newAlternative(): Alternative {
  return { dims: new Set(), guards: new Set(), preconditions: new Set(), objects: new Set(), privileged: false };
}

function isNone(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'none' in (value as object);
}

/** 出口字段策略随权限而定 = shape / projector / all（整对象可见也是对出口的承诺）；fixed（固定键 DTO）与 none 不算。 */
export function fieldsActive(fields: FieldsPolicy | undefined): boolean {
  return !!fields && (fields.mode === 'shape' || fields.mode === 'projector' || fields.mode === 'all');
}

function scopes(scope: ObjectPolicy['scope'] | ScopePolicy | undefined): ScopePolicy[] {
  if (!scope) return [];
  return 'byObject' in scope ? Object.values(scope.byObject) : [scope];
}

/** 范围：none 以外都算；点校验（point / 守卫式 guard / see-all）另记 scopePoint；守卫式范围的守卫名也算声明的守卫。 */
function collectScope(scope: ObjectPolicy['scope'] | ScopePolicy | undefined, acc: Alternative): void {
  for (const s of scopes(scope)) {
    if (s.mode === 'none') continue;
    acc.dims.add('scope');
    // 看全部（see-all）要求无限制范围，任何点校验都必然通过
    if (s.mode === 'point' || s.mode === 'guard' || s.mode === 'see-all') acc.dims.add('scopePoint');
    if (s.mode === 'guard') acc.guards.add(s.guard);
  }
}

/** 前提名归一化：允许 `module.fn` 前缀写法，与基准里的真实函数名按最后一段比较。 */
export function preconditionName(name: string): string {
  return name.split('.').pop() ?? name;
}

function selectorKeys(selector: unknown): string[] | undefined {
  if (!selector || typeof selector !== 'object' || !('from' in selector)) return undefined;
  const s = selector as { map?: Record<string, unknown>; domain?: readonly string[] };
  if (s.map) return Object.keys(s.map).sort();
  if (s.domain) return [...s.domain].sort();
  return undefined;
}

function collectWrite(write: WritePolicy, acc: Alternative): void {
  acc.dims.add('write');
  if (!isNone(write.fields)) acc.dims.add('fieldsIn');
  if (typeof write.footprint === 'string' && !LEDGER_ONLY_FOOTPRINTS.test(write.footprint)) acc.dims.add('postcheck');
  if (typeof write.result === 'string' || (!!write.result && 'generic' in write.result)) acc.dims.add('postcheck');
  for (const name of write.preconditions ?? []) acc.preconditions.add(preconditionName(name));
}

/** 逐行：字段、按钮、关系；逐行的数据操作选择器（rows.operation）也是对象 × 操作义务（按节点的对象展开）。 */
function collectRows(rows: RowsPolicy, acc: Alternative, codes: readonly string[]): void {
  if (!isNone(rows.fields)) acc.dims.add('fieldsIn');
  const ops = selectorValues(rows.operation).filter((op) => DATA_OPERATIONS.has(op));
  if (ops.length && codes.length) acc.dims.add('object');
  for (const code of codes) for (const op of ops) acc.objects.add(`${code}:${op}`);
  if (rows.button && !isNone(rows.button)) acc.dims.add('button');
  if (rows.relation) acc.dims.add('relation');
}

const DATA_OPERATIONS: ReadonlySet<string> = new Set(['view', 'create', 'update', 'delete']);

/** 静态值，或选择器的全部分支值（map 的值 / domain）。 */
function selectorValues(selector: unknown): string[] {
  if (typeof selector === 'string') return [selector];
  if (!selector || typeof selector !== 'object' || !('from' in selector)) return [];
  const s = selector as { map?: Record<string, unknown>; domain?: readonly string[] };
  if (s.map) return Object.values(s.map).filter((v): v is string => typeof v === 'string');
  return [...(s.domain ?? [])];
}

function collectObjects(policy: Extract<RoutePolicy, { kind: 'object' }>, acc: Alternative): void {
  const ops = selectorValues(policy.operation).filter((op) => DATA_OPERATIONS.has(op));
  for (const code of selectorValues(policy.object)) for (const op of ops) acc.objects.add(`${code}:${op}`);
}

function mergeInto(into: Alternative, from: Alternative): Alternative {
  for (const d of from.dims) into.dims.add(d);
  for (const o of from.objects) into.objects.add(o);
  for (const g of from.guards) into.guards.add(g);
  for (const p of from.preconditions) into.preconditions.add(p);
  into.privileged = into.privileged || from.privileged;
  return into;
}

const merged = (...parts: Alternative[]) => parts.reduce((acc, part) => mergeInto(acc, part), newAlternative());

/** 叶子节点（或组合节点自身）的义务，不含 of / optional 里的分支。 */
function own(policy: RoutePolicy): Alternative {
  const acc = newAlternative();
  for (const guard of policy.guards ?? []) acc.guards.add(guard);
  if (policy.guards?.length) acc.privileged = true;
  if (policy.write) collectWrite(policy.write, acc);
  switch (policy.kind) {
    case 'public':
    case 'any':
      break;
    case 'platform':
      acc.privileged = true;
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'member':
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'admin':
      acc.dims.add('admin');
      acc.privileged = true;
      collectScope(policy.scope, acc);
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'object':
      acc.privileged = true;
      acc.dims.add(policy.operation === 'button' ? 'button' : 'object');
      collectObjects(policy, acc);
      if (!isNone(policy.button)) acc.dims.add('button');
      collectScope(policy.scope, acc);
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      if (policy.rows) collectRows(policy.rows, acc, selectorValues(policy.object));
      if (policy.failureAudit) acc.dims.add('failureAudit');
      break;
    case 'button':
      acc.dims.add('button');
      acc.privileged = true;
      break;
    case 'self':
      acc.dims.add('self');
      acc.privileged = true;
      if (policy.button && !isNone(policy.button)) acc.dims.add('button');
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'own':
      acc.dims.add('own');
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'relation':
      acc.dims.add('relation');
      acc.privileged = true;
      if (policy.rows) collectRows(policy.rows, acc, []);
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'exception':
      acc.dims.add('exception');
      acc.privileged = true;
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'all':
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
  }
  return acc;
}

/** 析取范式：返回本节点的全部备选准入路径（不含可选分支）。 */
export function alternatives(policy: RoutePolicy): Alternative[] {
  const self = own(policy);
  if (policy.kind === 'any') return policy.of.flatMap((branch) => alternatives(branch)).map((alt) => merged(self, alt));
  if (policy.kind === 'all') {
    let product: Alternative[] = [self];
    for (const branch of policy.of) {
      const options = alternatives(branch);
      product = product.flatMap((acc) => options.map((alt) => merged(acc, alt)));
    }
    return product;
  }
  return [self];
}

function optionalBranches(policy: RoutePolicy): RoutePolicy[] {
  const nested = 'of' in policy ? policy.of.flatMap(optionalBranches) : [];
  return [...Object.values(policy.optional ?? {}), ...nested];
}

/** 声明树里的全部节点（含可选分支）。 */
function allNodes(policy: RoutePolicy): RoutePolicy[] {
  const children = [...('of' in policy ? policy.of : []), ...Object.values(policy.optional ?? {})];
  return [policy, ...children.flatMap(allNodes)];
}

/** 身份只看准入节点（可选分支不参与准入）。 */
function admissionNodes(policy: RoutePolicy): RoutePolicy[] {
  return [policy, ...('of' in policy ? policy.of.flatMap(admissionNodes) : [])];
}

function identityOf(policy: RoutePolicy): Identity {
  const kinds = admissionNodes(policy).map((node) => node.kind);
  if (kinds.includes('public')) return 'public';
  if (kinds.includes('platform')) return 'platform';
  return 'tenant';
}

function selectorsOf(policy: RoutePolicy): string[][] {
  const out: string[][] = [];
  for (const node of allNodes(policy)) {
    const record = node as unknown as Record<string, unknown>;
    for (const key of ['object', 'operation', 'button', 'relation']) {
      const keys = selectorKeys(record[key]);
      if (keys) out.push(keys);
    }
    const rows = record['rows'] as Record<string, unknown> | undefined;
    for (const key of ['operation', 'button', 'relation']) {
      const keys = selectorKeys(rows?.[key]);
      if (keys) out.push(keys);
    }
    const audit = record['failureAudit'] as Record<string, unknown> | undefined;
    const keys = selectorKeys(audit?.['objectType']);
    if (keys) out.push(keys);
  }
  return out;
}

export function declared(policy: RoutePolicy): Declared {
  const optional = merged(...optionalBranches(policy).flatMap((branch) => alternatives(branch)));
  const alts = alternatives(policy);
  return {
    identity: identityOf(policy),
    alternatives: alts,
    optional,
    union: merged(...alts, optional),
    selectors: selectorsOf(policy),
  };
}
