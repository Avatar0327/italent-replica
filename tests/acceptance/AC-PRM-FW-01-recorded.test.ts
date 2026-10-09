/**
 * AC-PRM-FW-01（续，F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-10「recorded 事实的双向闭环」；DEC-356 / 359）：
 * recorded 收集器框架。证据用例用 `observe(res, snapshot)` 造观测，再 `recordFact(端点, 类别, 观测)` 收集；
 * 同一个测试文件的 afterAll 把收集结果与冻结的 baseline/recorded.json 双向核对（CI 三分片，跨文件收集不可靠）：
 *   收集到未冻结 → RECORDED_UNREGISTERED；冻结了未收集 → RECORDED_STALE；
 *   precondition:* 与声明的 write.preconditions 双向：前者有后者无 → WEAKER:precondition；
 *   后者有而 recorded 与静态原语都没有 → OVERDECLARED:precondition。
 * 本 PR 只交框架：首批真实事实随对应模块组（审批 B5e、合同 B5d）进入，recorded.json 此时为空。
 * 局限（审查 P3）：品牌类型与"实参不是字面量"只是辅助，挡不住手工构造的伪响应；观测来源的最终保证是证据用例里对
 * 同一响应的独立 expect 断言加评审。
 */
import { type ManifestRoute, routeManifest, type RoutePolicy } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, readFrozenContract } from './support/route-policy/baseline.js';
import type { Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import {
  checkRecorded,
  createRecorder,
  mergeRecorded,
  observe,
  RECORDED_PATH,
  readFrozenRecorded,
  type RecordedFacts,
  writeFrozenRecorded,
} from './support/route-policy/recorded.js';
import { preconditionName } from './support/route-policy/features.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

let routes: readonly ManifestRoute[];
let contract: ObservedContract;

beforeAll(() => {
  routes = routeManifest(tenantApi(testDb().db, { authorize: undefined }).app).declared;
  const stored = readFrozenContract();
  if (!stored) throw new Error('冻结基准不存在：先跑 AC-PRM-FW-02.test.ts 生成');
  contract = stored;
  // 本文件没有真实证据用例（首批事实随模块组），重新生成只保证文件存在、保留其他组已冻结的事实
  if (process.env.ROUTE_POLICY_UPDATE_BASELINE === '1') {
    writeFrozenRecorded(mergeRecorded(readFrozenRecorded(), {}, new Set()));
  }
});

const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const withPre = (route: ManifestRoute, names: readonly string[] | undefined): ManifestRoute => {
  const policy = route.policy as RoutePolicy & { write?: { preconditions?: readonly string[] } };
  const write = { ...(policy.write ?? {}), ...(names ? { preconditions: names } : {}) };
  if (!names) delete (write as { preconditions?: unknown }).preconditions;
  return { ...route, policy: { ...policy, write } as RoutePolicy };
};
/** 声明的前提全部被静态原语探测到的写端点（其前提不需要 recorded 补）。 */
const staticRoute = () =>
  routes.find((r) => {
    const names = (r.policy as { write?: { preconditions?: readonly string[] } }).write?.preconditions ?? [];
    const seen = new Set(
      (contract.routes[`${r.method} ${r.path}`]?.primitives['precondition'] ?? []).map(preconditionName),
    );
    return names.length > 0 && names.every((name) => seen.has(preconditionName(name)));
  })!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AC-PRM-FW-01 recorded：观测只能由 observe 构造', () => {
  it('observe 读 HTTP 响应：状态码、error.code、details.reason，以及台账 / 审计快照的增量', async () => {
    const res = json(403, { error: { code: 'FORBIDDEN', details: { reason: 'BLIND_REVIEW' } } });
    const observed = await observe(res, {
      ledger: { before: [200, 200], after: [200, 200, 403] },
      audit: { before: ['a'], after: ['a', 'approval.task.blind_review'] },
    });
    expect(observed).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      reason: 'BLIND_REVIEW',
      ledgerAdded: [403],
      auditAdded: ['approval.task.blind_review'],
    });
  });

  it('台账增量按多重集计算（待办三项 200 / 403 / 409 回滚：+2，状态 [200, 403]）；删行不会得到负增量', async () => {
    const observed = await observe(json(200, { items: [] }), {
      ledger: { before: [200], after: [200, 200, 403] },
    });
    expect(observed.ledgerAdded).toEqual([200, 403]);
    const shrunk = await observe(json(200, {}), { ledger: { before: [200, 403], after: [200] } });
    expect(shrunk.ledgerAdded).toEqual([]);
  });

  it('固定键：响应顶层键排序后进入观测', async () => {
    const observed = await observe(json(200, { b: 1, a: 2 }));
    expect(observed.keys).toEqual(['a', 'b']);
  });

  it('recordFact 传字面量 → 类型检查失败（品牌类型）', () => {
    const recorder = createRecorder();
    expect(() =>
      // @ts-expect-error 观测只能由 observe(res, snapshot) 构造，字面量没有品牌
      recorder.recordFact('GET /x', 'outcome', { status: 403 }),
    ).toThrow(/observe/); // 运行时同样拒绝：未经 observe 的对象不入库
    expect(recorder.facts['GET /x']).toBeUndefined();
  });

  it('类别只能是 precondition:<名> / outcome / ledger / fixedKeys；ledger 类必须带台账快照', async () => {
    const recorder = createRecorder();
    const observed = await observe(json(200, {}));
    expect(() =>
      // @ts-expect-error 不是合法类别
      recorder.recordFact('GET /x', 'bogus', observed),
    ).toThrow(/类别/);
    expect(() => recorder.recordFact('POST /x', 'ledger', observed)).toThrow(/台账/);
  });
});

describe('AC-PRM-FW-01 recorded：收集 ↔ 冻结 双向核对', () => {
  const GUARDED = 'POST /api/tenant/approval/tasks/:id/approve';
  const guarded = () => routes.find((r) => `${r.method} ${r.path}` === GUARDED)!;

  async function collect(categories: readonly string[]): Promise<RecordedFacts> {
    const recorder = createRecorder();
    const forbidden = await observe(json(403, { error: { code: 'FORBIDDEN' } }));
    for (const category of categories) {
      recorder.recordFact(GUARDED, category as 'outcome', forbidden);
    }
    return recorder.facts;
  }

  it('收集与冻结完全一致 → 零发现', async () => {
    const facts = await collect(['outcome', 'precondition:approval.assertOpen']);
    const findings = checkRecorded({
      collected: facts,
      frozen: facts,
      scope: new Set([GUARDED]),
      routes: [withPre(guarded(), ['approval.assertOpen'])],
      contract,
    });
    expect(findings).toEqual([]);
  });

  it('同删 recorded 事实与声明前提 → 仍收集到、没冻结 → RECORDED_UNREGISTERED', async () => {
    const collected = await collect(['precondition:approval.assertOpen']);
    const findings = checkRecorded({
      collected,
      frozen: {},
      scope: new Set([GUARDED]),
      routes: [withPre(guarded(), undefined)],
      contract,
    });
    expect(codes(findings)).toContain('RECORDED_UNREGISTERED');
  });

  it('删证据用例 → 冻结了没收集到 → RECORDED_STALE', async () => {
    const frozen = await collect(['outcome']);
    const findings = checkRecorded({
      collected: {},
      frozen,
      scope: new Set([GUARDED]),
      routes: [withPre(guarded(), undefined)],
      contract,
    });
    expect(codes(findings)).toEqual(['RECORDED_STALE']);
  });

  it('冻结值与收集值不同（状态码变了）→ 视为收集到的事实没有被冻结 → RECORDED_UNREGISTERED', async () => {
    const frozen = await collect(['outcome']);
    const recorder = createRecorder();
    recorder.recordFact(GUARDED, 'outcome', await observe(json(404, { error: { code: 'NOT_FOUND' } })));
    const findings = checkRecorded({
      collected: recorder.facts,
      frozen,
      scope: new Set([GUARDED]),
      routes: [withPre(guarded(), undefined)],
      contract,
    });
    expect(codes(findings)).toEqual(['RECORDED_UNREGISTERED']);
  });

  it('只核对本文件负责的端点：范围外的冻结事实不报 STALE', async () => {
    const frozen = await collect(['outcome']);
    const findings = checkRecorded({ collected: {}, frozen, scope: new Set(), routes: [guarded()], contract });
    expect(findings).toEqual([]);
  });

  it('冻结了不存在的端点 → RECORDED_STALE（不论范围）', async () => {
    const frozen: RecordedFacts = { 'GET /api/nope': (await collect(['outcome']))[GUARDED]! };
    const findings = checkRecorded({ collected: {}, frozen, scope: new Set(), routes: [guarded()], contract });
    expect(codes(findings)).toEqual(['RECORDED_STALE']);
  });

  it('recorded 有前提、声明没有 → WEAKER:precondition', async () => {
    const facts = await collect(['precondition:approval.assertOpen']);
    const findings = checkRecorded({
      collected: facts,
      frozen: facts,
      scope: new Set([GUARDED]),
      routes: [withPre(guarded(), undefined)],
      contract,
    });
    expect(codes(findings)).toEqual(['WEAKER:precondition']);
  });

  it('声明有前提、recorded 与静态原语都没有 → OVERDECLARED:precondition；静态原语探测得到的前提不需要 recorded', async () => {
    const over = checkRecorded({
      collected: {},
      frozen: {},
      scope: new Set([GUARDED]),
      routes: [withPre(guarded(), ['approval.neverChecked'])],
      contract,
    });
    expect(codes(over)).toEqual(['OVERDECLARED:precondition']);
    const base = staticRoute();
    const key = `${base.method} ${base.path}`;
    const covered = checkRecorded({ collected: {}, frozen: {}, scope: new Set([key]), routes: [base], contract });
    expect(covered, key).toEqual([]);
  });

  it('前提名按最后一段比较（module.fn 与 fn 等价），与 PR-A 比较器同一归一化', async () => {
    const facts = await collect(['precondition:assertOpen']);
    const findings = checkRecorded({
      collected: facts,
      frozen: facts,
      scope: new Set([GUARDED]),
      routes: [withPre(guarded(), ['approval.assertOpen'])],
      contract,
    });
    expect(findings).toEqual([]);
  });
});

describe('AC-PRM-FW-01 recorded：冻结文件', () => {
  it('baseline/recorded.json 存在、是规范化 JSON、键都是已声明端点（本 PR 为空，首批事实随模块组）', () => {
    const frozen = readFrozenRecorded();
    expect(canonicalJson(frozen)).toBe(readFileSync(RECORDED_PATH, 'utf8'));
    const declared = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const key of Object.keys(frozen)) expect(declared.has(key), key).toBe(true);
    // 真实冻结文件对真实声明的核对（本文件不负责任何端点，只核对冻结的端点还存在）
    const findings = checkRecorded({ collected: {}, frozen, scope: new Set(), routes, contract });
    expect(findings).toEqual([]);
  });

  it('mergeRecorded：只替换本文件负责的端点，其余模块组的冻结事实原样保留', async () => {
    const mine = createRecorder();
    mine.recordFact('GET /a', 'outcome', await observe(json(200, {})));
    const other = createRecorder();
    other.recordFact('GET /b', 'outcome', await observe(json(403, {})));
    const merged = mergeRecorded(other.facts, mine.facts, new Set(['GET /a']));
    expect(Object.keys(merged).sort()).toEqual(['GET /a', 'GET /b']);
    const replaced = mergeRecorded(merged, {}, new Set(['GET /a']));
    expect(Object.keys(replaced)).toEqual(['GET /b']);
  });
});

describe('AC-PRM-FW-01 recorded：同端点同类别的多条事实全部保留（第 2 轮 P2-5）', () => {
  const GUARDED = 'POST /api/tenant/approval/tasks/:id/approve';
  /** 前提类别要求声明里有同名前提（否则另报 WEAKER:precondition），其他类别不声明前提。 */
  const routeFor = (category: string) =>
    withPre(
      routes.find((r) => `${r.method} ${r.path}` === GUARDED)!,
      category.startsWith('precondition:') ? ['approval.assertOpen'] : undefined,
    );
  const CATEGORIES = ['outcome', 'ledger', 'fixedKeys', 'precondition:approval.assertOpen'] as const;

  /** 同一审批同意入口：已提交的盲审 403（台账 +1）与普通 404 回滚（台账 +0），两个不同的证据用例。 */
  async function twoObservations() {
    const first = await observe(json(403, { error: { code: 'FORBIDDEN' }, a: 1 }), {
      ledger: { before: [], after: [403] },
    });
    const second = await observe(json(404, { error: { code: 'NOT_FOUND' }, b: 2 }), {
      ledger: { before: [], after: [] },
    });
    return { first, second };
  }
  const check = (category: string, collected: RecordedFacts, frozen: RecordedFacts) =>
    checkRecorded({ collected, frozen, scope: new Set([GUARDED]), routes: [routeFor(category)], contract });

  it.each(CATEGORIES)(
    '%s：先后两条不同事实都保留；一致 → 零发现；删掉先登记的证据 → RECORDED_STALE',
    async (category) => {
      const { first, second } = await twoObservations();
      const both = createRecorder();
      both.recordFact(GUARDED, category, first);
      both.recordFact(GUARDED, category, second);
      expect(both.facts[GUARDED]![category], '两条都保留').toHaveLength(2);
      const frozen = both.facts;
      expect(check(category, frozen, frozen)).toEqual([]);

      const onlySecond = createRecorder();
      onlySecond.recordFact(GUARDED, category, second);
      const stale = check(category, onlySecond.facts, frozen);
      expect(codes(stale), `${category}：删前一证据`).toEqual(['RECORDED_STALE']);

      const onlyFirst = createRecorder();
      onlyFirst.recordFact(GUARDED, category, first);
      expect(codes(check(category, onlyFirst.facts, frozen)), `${category}：删后一证据`).toEqual(['RECORDED_STALE']);
    },
  );

  it.each(CATEGORIES)(
    '%s：新增一条冻结里没有的事实 → RECORDED_UNREGISTERED；同一事实重复登记只算一条',
    async (category) => {
      const { first, second } = await twoObservations();
      const frozenRecorder = createRecorder();
      frozenRecorder.recordFact(GUARDED, category, first);
      const collected = createRecorder();
      collected.recordFact(GUARDED, category, first);
      collected.recordFact(GUARDED, category, first);
      expect(collected.facts[GUARDED]![category]).toHaveLength(1);
      expect(check(category, collected.facts, frozenRecorder.facts)).toEqual([]);
      collected.recordFact(GUARDED, category, second);
      expect(codes(check(category, collected.facts, frozenRecorder.facts))).toEqual(['RECORDED_UNREGISTERED']);
    },
  );

  it('冻结文件里事实按类别是数组且顺序稳定：登记顺序不同、内容相同 → 规范化后相等', async () => {
    const { first, second } = await twoObservations();
    const a = createRecorder();
    a.recordFact(GUARDED, 'outcome', first);
    a.recordFact(GUARDED, 'outcome', second);
    const b = createRecorder();
    b.recordFact(GUARDED, 'outcome', second);
    b.recordFact(GUARDED, 'outcome', first);
    expect(canonicalJson(a.facts)).toBe(canonicalJson(b.facts));
  });
});
