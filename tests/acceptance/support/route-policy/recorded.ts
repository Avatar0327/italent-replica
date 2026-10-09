/**
 * recorded 事实的收集器与双向闭环（F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-10）。
 * 探测不到或代价过高的事实（审批八动作的命令内前提与盲审 Outcome、合同待办批量 perItem、固定键…）由证据用例
 * 经 `observe(res, snapshot)` 造观测，再 `recordFact(端点, 类别, 观测)` 收集；冻结在 baseline/recorded.json。
 * 证据用例与核对放在**同一个测试文件**（CI 三分片，跨文件收集不可靠），afterAll 调 checkRecorded 双向核对：
 *   收集到未冻结（含值不同）→ RECORDED_UNREGISTERED；冻结了未收集 → RECORDED_STALE（含端点已不存在）；
 *   precondition:* 与声明 write.preconditions 双向：recorded 有、声明无 → WEAKER:precondition；
 *   声明有、recorded 与静态原语都没有 → OVERDECLARED:precondition。
 * 局限：品牌类型与"实参不是字面量"的检查只是辅助，挡不住手工构造的伪响应；观测来源的最终保证是证据用例里对
 * 同一响应的独立 expect 断言加评审。
 */
import type { ManifestRoute } from '@italent/api';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './baseline.js';
import type { Finding } from './compare.js';
import type { ObservedContract } from './contract.js';
import { preconditionName } from './features.js';

export const RECORDED_PATH = path.resolve(
  process.cwd(),
  'tests/acceptance/support/route-policy/baseline/recorded.json',
);

export type RecordedCategory = `precondition:${string}` | 'outcome' | 'ledger' | 'fixedKeys';

declare const OBSERVED: unique symbol;
/** 只能由 observe() 构造（品牌类型）。 */
export interface Observation {
  readonly [OBSERVED]: true;
  readonly status: number;
  readonly code?: string;
  readonly reason?: string;
  /** 新增台账行的 response_status 多重集（升序）。 */
  readonly ledgerAdded?: readonly number[];
  /** 新增审计事件名多重集（升序）。 */
  readonly auditAdded?: readonly string[];
  /** 响应体顶层键（升序）。 */
  readonly keys?: readonly string[];
}

export interface Snapshot {
  readonly ledger?: { readonly before: readonly number[]; readonly after: readonly number[] };
  readonly audit?: { readonly before: readonly string[]; readonly after: readonly string[] };
}

/** 冻结值：观测去掉品牌，只留与类别相关的字段。 */
export type FactValue = Readonly<Record<string, unknown>>;
/** 端点 → 类别 → 事实列表：同端点同类别可有多条不同事实（成功 / 已提交 403 / 回滚…各一个证据用例），按规范化 JSON 升序、去重。 */
export type RecordedFacts = Readonly<Record<string, Readonly<Record<string, readonly FactValue[]>>>>;

const made = new WeakSet<object>();
const sameValue = (a: FactValue, b: FactValue) => canonicalJson(a) === canonicalJson(b);

function multisetAdded<T extends number | string>(before: readonly T[], after: readonly T[]): T[] {
  const left = new Map<T, number>();
  for (const item of before) left.set(item, (left.get(item) ?? 0) + 1);
  const added: T[] = [];
  for (const item of after) {
    const remaining = left.get(item) ?? 0;
    if (remaining > 0) left.set(item, remaining - 1);
    else added.push(item);
  }
  return added.sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
}

export async function observe(res: Response, snapshot: Snapshot = {}): Promise<Observation> {
  const text = await res.clone().text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined; // 非 JSON 响应（CSV 等）只记状态码
  }
  const error = (body as { error?: { code?: string; details?: { reason?: string } } } | undefined)?.error;
  const keys =
    body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as object).sort() : undefined;
  const observed = {
    status: res.status,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.details?.reason ? { reason: error.details.reason } : {}),
    ...(snapshot.ledger ? { ledgerAdded: multisetAdded(snapshot.ledger.before, snapshot.ledger.after) } : {}),
    ...(snapshot.audit ? { auditAdded: multisetAdded(snapshot.audit.before, snapshot.audit.after) } : {}),
    ...(keys ? { keys } : {}),
  } as unknown as Observation; // 品牌符号只存在于类型层，运行时登记在 made 里
  made.add(observed);
  return observed;
}

const CATEGORY = /^(outcome|ledger|fixedKeys|precondition:.+)$/;

function valueOf(category: string, observed: Observation): FactValue {
  const { status, code, reason, ledgerAdded, auditAdded, keys } = observed;
  const outcome = { status, ...(code ? { code } : {}), ...(reason ? { reason } : {}) };
  if (category === 'fixedKeys') {
    if (!keys) throw new Error('fixedKeys 类事实要求响应体是 JSON 对象');
    return { keys };
  }
  if (category === 'ledger') {
    if (!ledgerAdded) throw new Error('ledger 类事实必须带台账快照：observe(res, { ledger: { before, after } })');
    return { status, ledgerAdded };
  }
  return {
    ...outcome,
    ...(category === 'outcome' && ledgerAdded ? { ledgerAdded } : {}),
    ...(category === 'outcome' && auditAdded ? { auditAdded } : {}),
  };
}

export interface Recorder {
  recordFact(endpoint: string, category: RecordedCategory, observed: Observation): void;
  readonly facts: RecordedFacts;
}

export function createRecorder(): Recorder {
  const facts: Record<string, Record<string, FactValue[]>> = {};
  return {
    facts,
    recordFact(endpoint, category, observed) {
      if (!made.has(observed)) throw new Error('recordFact 只接受 observe(res, snapshot) 构造的观测，不接受字面量');
      if (!CATEGORY.test(category)) throw new Error(`recorded 类别不合法：${category}`);
      const value = valueOf(category, observed);
      const list = ((facts[endpoint] ??= {})[category] ??= []);
      // 后写不覆盖前写：不同的观测全部保留，完全相同的重复登记只算一条
      if (!list.some((existing) => sameValue(existing, value))) {
        list.push(value);
        list.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
      }
    },
  };
}

export interface RecordedCheck {
  readonly collected: RecordedFacts;
  readonly frozen: RecordedFacts;
  /** 本测试文件负责的端点；范围外的冻结事实留给各自的模块组文件核对。 */
  readonly scope: ReadonlySet<string>;
  /** 全部已声明端点（判断冻结的端点是否还存在，并取声明的前提）。 */
  readonly routes: readonly ManifestRoute[];
  readonly contract: ObservedContract;
}

const PRECONDITION_PREFIX = 'precondition:';

export function checkRecorded({ collected, frozen, scope, routes, contract }: RecordedCheck): Finding[] {
  const findings: Finding[] = [];
  const declared = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
  const report = (route: string, code: string, detail: string) => findings.push({ route, code, detail });

  for (const endpoint of Object.keys(frozen)) {
    if (!declared.has(endpoint)) report(endpoint, 'RECORDED_STALE', '冻结的 recorded 事实所属端点已不存在');
  }
  const covered = new Set([...scope, ...Object.keys(collected)]);
  for (const endpoint of covered) {
    const have = collected[endpoint] ?? {};
    const frozenHere = frozen[endpoint] ?? {};
    for (const [category, values] of Object.entries(have)) {
      const stored = frozenHere[category] ?? [];
      for (const value of values) {
        if (stored.some((existing) => sameValue(existing, value))) continue;
        const detail = stored.length
          ? `${category} 的收集值不在冻结值里：${canonicalJson(value).trim()}`
          : `收集到 ${category}，但没有冻结（先重新生成并随 PR 评审）`;
        report(endpoint, 'RECORDED_UNREGISTERED', detail);
      }
    }
    if (declared.has(endpoint)) {
      for (const [category, stored] of Object.entries(frozenHere)) {
        for (const value of stored) {
          if ((have[category] ?? []).some((existing) => sameValue(existing, value))) continue;
          report(
            endpoint,
            'RECORDED_STALE',
            `冻结了 ${category}：${canonicalJson(value).trim()}，但本次没有证据用例收集到它`,
          );
        }
      }
    }
  }
  for (const endpoint of scope) {
    const route = declared.get(endpoint);
    if (!route) continue;
    checkPreconditions(endpoint, route, collected[endpoint] ?? {}, contract, report);
  }
  return findings;
}

function checkPreconditions(
  endpoint: string,
  route: ManifestRoute,
  collected: Readonly<Record<string, readonly FactValue[]>>,
  contract: ObservedContract,
  report: (route: string, code: string, detail: string) => void,
): void {
  const policy = route.policy as { write?: { preconditions?: readonly string[] } };
  const declared = new Map((policy.write?.preconditions ?? []).map((name) => [preconditionName(name), name]));
  const recorded = Object.keys(collected)
    .filter((category) => category.startsWith(PRECONDITION_PREFIX))
    .map((category) => category.slice(PRECONDITION_PREFIX.length));
  const recordedNames = new Set(recorded.map(preconditionName));
  const staticNames = new Set((contract.routes[endpoint]?.primitives['precondition'] ?? []).map(preconditionName));
  for (const name of recorded) {
    if (!declared.has(preconditionName(name)))
      report(endpoint, 'WEAKER:precondition', `recorded 有前提 ${name}，声明没有`);
  }
  for (const [normalized, name] of declared) {
    if (!recordedNames.has(normalized) && !staticNames.has(normalized)) {
      report(endpoint, 'OVERDECLARED:precondition', `声明了前提 ${name}，recorded 与静态原语都没有证据`);
    }
  }
}

/** 本文件负责的端点用本次收集替换，其余模块组的冻结事实原样保留（重新生成用）。 */
export function mergeRecorded(
  frozen: RecordedFacts,
  collected: RecordedFacts,
  scope: ReadonlySet<string>,
): RecordedFacts {
  const out: Record<string, Readonly<Record<string, readonly FactValue[]>>> = {};
  for (const [endpoint, facts] of Object.entries(frozen)) if (!scope.has(endpoint)) out[endpoint] = facts;
  for (const [endpoint, facts] of Object.entries(collected)) out[endpoint] = facts;
  return out;
}

export function readFrozenRecorded(): RecordedFacts {
  if (!existsSync(RECORDED_PATH)) return {};
  return JSON.parse(readFileSync(RECORDED_PATH, 'utf8')) as RecordedFacts;
}

export function writeFrozenRecorded(facts: RecordedFacts): void {
  mkdirSync(path.dirname(RECORDED_PATH), { recursive: true });
  writeFileSync(RECORDED_PATH, canonicalJson(facts));
}
