/**
 * 从声明树提取"声明了哪些维度"（比较器与突变套件共用，F-039 PR-A §4.4 限定版）。
 * 维度口径与 primitives.ts 的基准维度一一对应：admin / object / button / scope / fieldsOut / fieldsIn / relation /
 * self / own / postcheck / failureAudit / write；守卫与前提按名字；选择器按分支域键集合。
 */
import type { FieldsPolicy, ObjectPolicy, RoutePolicy, RowsPolicy, ScopePolicy, WritePolicy } from '@italent/api';

export type Identity = 'public' | 'platform' | 'tenant';

export interface Features {
  readonly dims: Set<string>;
  readonly guards: Set<string>;
  readonly preconditions: Set<string>;
  /** 每个动态选择器的分支域（map 的键或 domain）。 */
  readonly selectors: string[][];
  identity: Identity;
  /** 准入是否要求成员身份之外的权限（admin / object / button / self / relation / exception / platform 或守卫）。 */
  privileged: boolean;
}

/** 只记台账 / 审计足迹、不是范围复核的 footprint 名（配置命令、权限命令、平台命令）。 */
export const LEDGER_ONLY_FOOTPRINTS =
  /^(config\.audited|permission\.adminCommand|permission\.platformUser|platform\.ledger)/;

export function newFeatures(): Features {
  return {
    dims: new Set(),
    guards: new Set(),
    preconditions: new Set(),
    selectors: [],
    identity: 'tenant',
    privileged: false,
  };
}

function isNone(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'none' in (value as object);
}

/** 出口字段策略随权限而定 = shape / projector / all（整对象可见也是对出口的承诺）；fixed（固定键 DTO）与 none 不算。 */
export function fieldsActive(fields: FieldsPolicy | undefined): boolean {
  return !!fields && (fields.mode === 'shape' || fields.mode === 'projector' || fields.mode === 'all');
}

export function scopeActive(scope: ObjectPolicy['scope'] | ScopePolicy | undefined): boolean {
  if (!scope) return false;
  if ('byObject' in scope) return Object.values(scope.byObject).some((s) => s.mode !== 'none');
  return scope.mode !== 'none';
}

/** 守卫式范围（mode guard）的守卫名也算声明的守卫。 */
function scopeGuards(scope: ObjectPolicy['scope'] | ScopePolicy | undefined, acc: Features): void {
  if (!scope) return;
  const scopes = 'byObject' in scope ? Object.values(scope.byObject) : [scope];
  for (const s of scopes) if (s.mode === 'guard') acc.guards.add(s.guard);
}

/** 前提名归一化：允许 `module.fn` 前缀写法，与基准里的真实函数名按最后一段比较。 */
export function preconditionName(name: string): string {
  return name.split('.').pop() ?? name;
}

function collectSelector(selector: unknown, acc: Features): void {
  if (!selector || typeof selector !== 'object' || !('from' in selector)) return;
  const s = selector as { from: string; map?: Record<string, unknown>; domain?: readonly string[] };
  if (s.map) acc.selectors.push(Object.keys(s.map).sort());
  else if (s.domain) acc.selectors.push([...s.domain].sort());
}

function collectWrite(write: WritePolicy, acc: Features): void {
  acc.dims.add('write');
  if (!isNone(write.fields)) acc.dims.add('fieldsIn');
  if (typeof write.footprint === 'string' && !LEDGER_ONLY_FOOTPRINTS.test(write.footprint)) acc.dims.add('postcheck');
  if (typeof write.result === 'string' || (!!write.result && 'generic' in write.result)) acc.dims.add('postcheck');
  for (const name of write.preconditions ?? []) acc.preconditions.add(preconditionName(name));
}

function collectRows(rows: RowsPolicy, acc: Features): void {
  if (!isNone(rows.fields)) acc.dims.add('fieldsIn');
  if (rows.button && !isNone(rows.button)) {
    acc.dims.add('button');
    collectSelector(rows.button, acc);
  }
  if (rows.relation) {
    acc.dims.add('relation');
    collectSelector(rows.relation, acc);
  }
  collectSelector(rows.operation, acc);
}

function merge(into: Features, from: Features): void {
  for (const d of from.dims) into.dims.add(d);
  for (const g of from.guards) into.guards.add(g);
  for (const p of from.preconditions) into.preconditions.add(p);
  into.selectors.push(...from.selectors);
  if (from.identity === 'public' || (from.identity === 'platform' && into.identity !== 'public'))
    into.identity = from.identity;
}

/** 递归收集；返回本节点（含分支）的特征。 */
export function features(policy: RoutePolicy, acc: Features = newFeatures()): Features {
  for (const guard of policy.guards ?? []) acc.guards.add(guard);
  if (policy.guards?.length) acc.privileged = true;
  if (policy.write) collectWrite(policy.write, acc);
  for (const branch of Object.values(policy.optional ?? {})) {
    const sub = features(branch);
    merge(acc, sub); // 可选分支不参与准入：不并入 privileged
  }
  switch (policy.kind) {
    case 'public':
      acc.identity = 'public';
      break;
    case 'platform':
      acc.identity = 'platform';
      acc.privileged = true;
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'member':
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'admin':
      acc.dims.add('admin');
      acc.privileged = true;
      scopeGuards(policy.scope, acc);
      if (scopeActive(policy.scope)) acc.dims.add('scope');
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'object':
      acc.privileged = true;
      if (policy.operation === 'button') acc.dims.add('button');
      else acc.dims.add('object');
      collectSelector(policy.object, acc);
      collectSelector(policy.operation, acc);
      if (!isNone(policy.button)) {
        acc.dims.add('button');
        collectSelector(policy.button, acc);
      }
      scopeGuards(policy.scope, acc);
      if (scopeActive(policy.scope)) acc.dims.add('scope');
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      if (policy.rows) collectRows(policy.rows, acc);
      if (policy.failureAudit) {
        acc.dims.add('failureAudit');
        collectSelector(policy.failureAudit.objectType, acc);
      }
      break;
    case 'button':
      acc.dims.add('button');
      acc.privileged = true;
      collectSelector(policy.object, acc);
      collectSelector(policy.button, acc);
      break;
    case 'self':
      acc.dims.add('self');
      acc.privileged = true;
      if (policy.button && !isNone(policy.button)) {
        acc.dims.add('button');
        collectSelector(policy.button, acc);
      }
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'own':
      acc.dims.add('own');
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'relation':
      acc.dims.add('relation');
      acc.privileged = true;
      collectSelector(policy.relation, acc);
      if (policy.rows) collectRows(policy.rows, acc);
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'exception':
      acc.dims.add('exception');
      acc.privileged = true;
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    case 'any': {
      const branches = policy.of.map((branch) => features(branch));
      for (const sub of branches) merge(acc, sub);
      acc.privileged = acc.privileged || branches.every((sub) => sub.privileged);
      break;
    }
    case 'all': {
      const branches = policy.of.map((branch) => features(branch));
      for (const sub of branches) merge(acc, sub);
      acc.privileged = acc.privileged || branches.some((sub) => sub.privileged);
      if (fieldsActive(policy.fields)) acc.dims.add('fieldsOut');
      break;
    }
  }
  return acc;
}
