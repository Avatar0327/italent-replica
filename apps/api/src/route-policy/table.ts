/**
 * 策略登记表：按 `METHOD path` 键登记每条路由的现状 policy（§3.7：声明集中放在模块级 policy.ts，不改处理函数）。
 * path 是注册时写的本地路径（子应用为挂载前的本地路径），与 `router.get(path, …)` 的实参逐字相同。
 */
import type { HttpMethod, RoutePolicy } from './types.js';

export interface PolicyHit {
  readonly module: string;
  readonly policy: RoutePolicy;
}

export interface PolicyTable {
  /** 登记表名（模块名或合并表名），只用于统计与报错。 */
  readonly name: string;
  lookup(key: string): PolicyHit | undefined;
  keys(): readonly string[];
}

export const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function policyKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function assertKey(key: string, table: string): void {
  const space = key.indexOf(' ');
  const method = space > 0 ? key.slice(0, space) : '';
  const path = key.slice(space + 1);
  if (!METHODS.has(method) || !path.startsWith('/')) {
    throw new Error(`策略表 ${table} 的键必须是 "METHOD /path"，收到：${key}`);
  }
}

/**
 * `write.ledger = 'none'` 必须带非空 `ledgerReason`，其他取值不得带（DEC-377③）。类型层已强制，
 * 这里在模块加载时再查一次，覆盖绕过类型的写法，并沿 any / all 的 of 与 optional 递归。
 */
function assertLedgerReason(policy: RoutePolicy, key: string, table: string): void {
  const write = policy.write;
  if (write) {
    const reason = write.ledgerReason;
    if (write.ledger === 'none' ? typeof reason !== 'string' || reason.trim() === '' : reason !== undefined) {
      throw new Error(
        `策略表 ${table} 的 ${key}：ledger 为 none 时必须带非空 ledgerReason，其他取值不得带 ledgerReason`,
      );
    }
  }
  const children = [...('of' in policy ? policy.of : []), ...Object.values(policy.optional ?? {})];
  for (const child of children) assertLedgerReason(child, key, table);
}

/** 定义一个模块的登记表；键格式与重复在模块加载时就报错。 */
export function defineTable(module: string, entries: Readonly<Record<string, RoutePolicy>>): PolicyTable {
  const map = new Map<string, PolicyHit>();
  for (const [key, policy] of Object.entries(entries)) {
    assertKey(key, module);
    assertLedgerReason(policy, key, module);
    map.set(key, { module, policy });
  }
  return {
    name: module,
    lookup: (key) => map.get(key),
    keys: () => [...map.keys()],
  };
}

/** 合并多个模块的登记表（直接挂在同一路由器上的模块共用一张表）；键重叠即报错。 */
export function mergeTables(name: string, tables: readonly PolicyTable[]): PolicyTable {
  const map = new Map<string, PolicyHit>();
  for (const table of tables) {
    for (const key of table.keys()) {
      const hit = table.lookup(key);
      if (!hit) continue;
      const existing = map.get(key);
      if (existing) throw new Error(`策略表 ${name}：${key} 同时登记在 ${existing.module} 与 ${hit.module}`);
      map.set(key, hit);
    }
  }
  return { name, lookup: (key) => map.get(key), keys: () => [...map.keys()] };
}
