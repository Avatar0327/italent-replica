/**
 * AC-PRM-FW-02（续，F-039 PR-B1，设计 docs/08_设计/F-039_PR-B_设计.md B-01 / B-03；DEC-356 / DEC-359 / DEC-362）：
 * 披露语义与范围绑定。零行为变化——只改比较器、显式表与测试支撑，不动任何处理函数。
 * - B-01 披露分支按自身析取范式逐备选比较：D1（只挂根）/ D2（不嵌套）/ D3（名字字符集）、R2 修订（同权“准入 + 披露”复用）、
 *   R3 逐备选（DISCLOSURE_WEAK）；
 * - B-03 准入与披露义务的范围绑定到提供权限的节点：`need` 参与“或”满足、R1c（NEED_UNBOUND）、R3c（DISCLOSURE_NEED_UNBOUND）、
 *   范围证据（NEED_EVIDENCE_MISSING）；
 * - 守卫内部义务登记内部角色 `inner`（GUARD_ROLE_UNBOUND）与不经授权器的内部备选 GUARD_INNER_ALTS；
 * - 结构弱化 6 类按声明结构与表的披露义务生成，不经比较器筛选，断言“生成数 = 报出数”。
 */
import { type ManifestRoute, routeManifest, type RouteManifest, type RoutePolicy } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { checkStored } from './support/route-policy/evidence.js';
import { gateEvidence } from './support/route-policy/evidence-gate.js';
import { declaredPerms, OPTIONAL_NAME_PATTERN } from './support/route-policy/perms.js';
import { locate } from './support/route-policy/required-mutate.js';
import { checkRequired } from './support/route-policy/required.js';
import { GUARD_INNER_ALTS } from './support/route-policy/required/guard-inner.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';
import { DISCLOSURE_WEAKENING_KINDS, disclosureWeakeningsOf } from './support/route-policy/weakenings.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

let manifest: RouteManifest;
let frozen: ObservedContract;

beforeAll(() => {
  manifest = routeManifest(tenantApi(testDb().db, { authorize: undefined }).app);
  const stored = readFrozenContract();
  if (!stored) throw new Error('冻结基准不存在：先跑 AC-PRM-FW-02.test.ts 生成');
  frozen = stored;
});

const MANAGER = 'GET /api/tenant/employment/transfers/manager';
const ISSUE = 'POST /api/tenant/idp/plans/tasks/issue';
const COPY = 'POST /api/tenant/idp/templates/:id/copy';
const GOALS = 'POST /api/tenant/idp/plans/:id/goals';
const APPROVAL_PROCESSES = 'GET /api/tenant/idp/approval-processes';
const AUTO_APPRAISERS = 'POST /api/tenant/survey360/activities/:id/objects/:objectId/appraisers/auto';
const MODULE_VIEW = 'obj:IDP.IDPTemplateModule:view';

function route(key: string): ManifestRoute {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
}

type Node = Record<string, unknown>;
const withPolicy = (base: ManifestRoute, policy: unknown): ManifestRoute => ({
  ...base,
  policy: policy as RoutePolicy,
});
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
const check = (routes: readonly ManifestRoute[], table: RequiredTable = REQUIRED) =>
  checkRequired(table, frozen, routes);
const entry = (key: string): readonly Obligation[] => {
  const found = REQUIRED[key];
  if (!found) throw new Error(`表里没有 ${key}`);
  return found;
};
const withEntry = (key: string, obligations: readonly Obligation[]): RequiredTable => ({
  ...REQUIRED,
  [key]: obligations,
});
const MEMBER = { kind: 'member', reason: '夹具', fields: { mode: 'none', reason: '夹具' } };
const clone = <T>(value: T): T => structuredClone(value);
const isDisclosure = (o: Obligation) => o.purpose?.startsWith('disclosure:') ?? false;
/** 表里的披露分支（端点 × 分支名）。设计 §1.3 实测 33 个，之后随新模块增加（任职资格 +6）。 */
const disclosureBranches = () =>
  Object.entries(REQUIRED).flatMap(([key, os]) => [
    ...new Set(os.filter(isDisclosure).map((o) => `${key}|${o.purpose}`)),
  ]);

describe('AC-PRM-FW-02 B-01 披露分支：位置 / 嵌套 / 名字（D1～D3）与逐备选比较（R3）', () => {
  it('真实声明 × 真实表零发现；披露位置全部挂在根节点，名字合 D3，数量等于表里的披露分支数', () => {
    expect(check(manifest.declared), show(check(manifest.declared))).toEqual([]);
    const branches = manifest.declared.flatMap((r) => [...declaredPerms(r.policy).optional]);
    expect(branches).toHaveLength(disclosureBranches().length);
    expect(branches.length).toBeGreaterThanOrEqual(33);
    for (const [name, branch] of branches) {
      expect(OPTIONAL_NAME_PATTERN.test(name), name).toBe(true);
      expect(branch.path, name).toBe(`optional.${name}.`);
    }
    expect(manifest.declared.flatMap((r) => declaredPerms(r.policy).layout)).toEqual([]);
  });

  it('审查原文例一：canViewReporting → any([HR 按钮, 普通成员]) → DISCLOSURE_WEAK，指出第几个备选', () => {
    const base = route(MANAGER);
    const policy = clone(base.policy) as unknown as Node;
    const optional = policy['optional'] as Record<string, Node>;
    optional['canViewReporting'] = { kind: 'any', of: [optional['canViewReporting'], clone(MEMBER)] };
    const findings = check([withPolicy(base, policy)]);
    const weak = findings.filter((f) => f.code === 'DISCLOSURE_WEAK');
    expect(weak.length, show(findings)).toBeGreaterThan(0);
    expect(weak[0]!.detail).toContain('第 2 个备选');
  });

  it('审查原文例二：按钮下沉进嵌套 optional → OPTIONAL_NESTED 与 DISCLOSURE_MISSING', () => {
    const base = route(MANAGER);
    const policy = clone(base.policy) as unknown as Node;
    const optional = policy['optional'] as Record<string, Node>;
    optional['canViewReporting'] = { ...clone(MEMBER), optional: { hr: optional['canViewReporting'] } };
    const found = codes(check([withPolicy(base, policy)]));
    expect(found).toContain('OPTIONAL_NESTED');
    expect(found).toContain('DISCLOSURE_MISSING');
  });

  it('披露义务的“或”组语义同准入：分支每个备选至少满足组内一个备选，全不满足 → DISCLOSURE_WEAK', () => {
    const base = route(MANAGER);
    const hr = entry(MANAGER).find((o) => o.purpose === 'disclosure:canViewReporting')!;
    const others = entry(MANAGER).filter((o) => o !== hr);
    const grouped = (second: string) =>
      withEntry(MANAGER, [...others, { ...hr, or: 'g:hr' }, { ...hr, perm: second, or: 'g:other' }]);
    expect(check([base], grouped('btn:TenantBase.EmploymentRecord#Transfer.Manager@detail'))).toEqual([]);
    const policy = clone(base.policy) as unknown as Node;
    const optional = policy['optional'] as Record<string, Node>;
    optional['canViewReporting'] = { kind: 'any', of: [optional['canViewReporting'], clone(MEMBER)] };
    const found = check([withPolicy(base, policy)], grouped('btn:TenantBase.EmploymentRecord#Transfer.Manager@detail'));
    expect(codes(found)).toContain('DISCLOSURE_WEAK');
    expect(found.find((f) => f.code === 'DISCLOSURE_WEAK')!.detail).toContain('“或”组');
  });

  it('D1：可选分支挂在 all.of[0] 上 → OPTIONAL_POSITION（可选分支只能挂声明根节点）', () => {
    const base = route(ISSUE);
    const policy = clone(base.policy) as unknown as Node;
    (policy['of'] as Node[])[0] = { ...(policy['of'] as Node[])[0], optional: { misplaced: clone(MEMBER) } };
    expect(codes(check([withPolicy(base, policy)]))).toContain('OPTIONAL_POSITION');
  });

  it('D3：分支名含点 → OPTIONAL_NAME；locate 对含点的路径抛错而不是错位到别的分支', () => {
    const base = route(MANAGER);
    const policy = clone(base.policy) as unknown as Node;
    (policy['optional'] as Record<string, Node>)['bad.name'] = clone(MEMBER);
    expect(codes(check([withPolicy(base, policy)]))).toContain('OPTIONAL_NAME');
    expect(OPTIONAL_NAME_PATTERN.test('nestedSubProcess')).toBe(true);
    expect(OPTIONAL_NAME_PATTERN.test('nested.SubProcess')).toBe(false);
    const root = { optional: { a: { optional: { b: { id: 'b' } } } } } as unknown as Node;
    expect(locate(root, 'optional.a.optional.b.')).toEqual({ id: 'b' });
    expect(() => locate(root, 'optional.a.b.')).toThrow();
  });
});

describe('AC-PRM-FW-02 B-01 R2 修订：同权“准入 + 披露”复用（IDP 模板复制入口）', () => {
  const nested = (): Node => ({
    kind: 'object',
    object: 'IDP.IDPTemplateModule',
    operation: 'view',
    button: { none: true, reason: '夹具' },
    scope: { mode: 'none', reason: '夹具' },
    fields: { mode: 'none', reason: '夹具' },
  });
  const withNested = (): ManifestRoute => {
    const base = route(COPY);
    return withPolicy(base, { ...clone(base.policy), optional: { nestedTemplateModule: nested() } });
  };
  const disclosure: Obligation = {
    perm: MODULE_VIEW,
    purpose: 'disclosure:nestedTemplateModule',
    need: { scope: 'none' },
    at: entry(COPY)[0]!.at,
  };

  it('表里有同权披露义务：复制入口准入与披露并存，零发现', () => {
    expect(check([withNested()], withEntry(COPY, [...entry(COPY), disclosure]))).toEqual([]);
  });

  it('夹具中某准入权限进了没有对应披露义务的分支 → REQUIRED_IN_OPTIONAL', () => {
    expect(codes(check([withNested()]))).toContain('REQUIRED_IN_OPTIONAL');
  });

  it('只剩 optional、准入里删掉模板模块查看 → REQUIRED_MISSING（放宽 R2 不削弱准入）', () => {
    const base = withNested();
    const policy = clone(base.policy) as unknown as Node;
    policy['of'] = (policy['of'] as Node[]).filter((b) => b['object'] !== 'IDP.IDPTemplateModule');
    const found = codes(check([withPolicy(base, policy)], withEntry(COPY, [...entry(COPY), disclosure])));
    expect(found).toContain('REQUIRED_MISSING');
  });

  it('披露义务的权限与准入权限不同时仍不放行：分支里放另一个准入权限 → REQUIRED_IN_OPTIONAL', () => {
    const base = withNested();
    const policy = clone(base.policy) as unknown as Node;
    (policy['optional'] as Record<string, Node>)['nestedTemplateModule']!['object'] = 'IDP.IDPTemplateCommonGoal';
    const table = withEntry(COPY, [...entry(COPY), disclosure]);
    expect(codes(check([withPolicy(base, policy)], table))).toContain('REQUIRED_IN_OPTIONAL');
  });
});

describe('AC-PRM-FW-02 B-03 范围绑定（need）：与“或”满足合并、R1c / R3c / 范围证据', () => {
  it('360 自动添加评价者：Relation:create 的点范围换给员工信息节点 → REQUIRED_MISSING，明细写“范围不符”', () => {
    const base = route(AUTO_APPRAISERS);
    const policy = clone(base.policy) as unknown as Node;
    const [first, second] = policy['of'] as Node[];
    [first!['scope'], second!['scope']] = [second!['scope'], first!['scope']];
    const findings = check([withPolicy(base, policy)]).filter((f) => f.code === 'REQUIRED_MISSING');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.detail).join('\n')).toContain('范围不符');
  });

  it.each([
    ['DELETE /api/tenant/idp/processes/:id', 'IDP.IDPProcess'],
    ['DELETE /api/tenant/idp/templates/:id', 'IDP.IDPTemplate'],
    ['DELETE /api/tenant/idp/plans/:id', 'IDP.Idp'],
  ])('IDP 删除 %s：主对象的点范围挪给子对象 → REQUIRED_MISSING（范围不符）', (key, main) => {
    const base = route(key);
    const policy = clone(base.policy) as unknown as Node;
    const nodes = policy['of'] as Node[];
    expect(nodes[0]!['object']).toBe(main);
    [nodes[0]!['scope'], nodes[1]!['scope']] = [nodes[1]!['scope'], nodes[0]!['scope']];
    const findings = check([withPolicy(base, policy)]).filter((f) => f.code === 'REQUIRED_MISSING');
    expect(findings.map((f) => f.detail).join('\n')).toContain('范围不符');
  });

  it('GET /idp/approval-processes（view AND (create OR update)）：need 随所属组内备选参与“或”，零发现', () => {
    expect(check([route(APPROVAL_PROCESSES)])).toEqual([]);
    const needs = entry(APPROVAL_PROCESSES).map((o) => o.need);
    expect(needs.every((n) => n !== undefined)).toBe(true);
  });

  it('“或”组 need：备选 {view, create} 里 create 的范围与 need 不符时，不被同组另一支（update）顶替 → REQUIRED_MISSING', () => {
    const base = route(APPROVAL_PROCESSES);
    const table = withEntry(
      APPROVAL_PROCESSES,
      entry(APPROVAL_PROCESSES).map((o) => (o.or ? { ...o, need: { scope: 'point' as const, locator: 'x.byId' } } : o)),
    );
    expect(codes(check([base], table))).toContain('REQUIRED_MISSING');
  });

  it('R1c：含 ≥2 个承载节点的准入备选，其 obj: / admin: 准入义务缺 need → NEED_UNBOUND（设计 §1.3 实测 20 条端点）', () => {
    const stripped: RequiredTable = Object.fromEntries(
      Object.entries(REQUIRED).map(([key, os]) => [key, os.map(({ need: _need, ...rest }) => rest as Obligation)]),
    );
    const unbound = check(manifest.declared, stripped).filter((f) => f.code === 'NEED_UNBOUND');
    const multi = manifest.declared.filter((r) =>
      declaredPerms(r.policy).alternatives.some((alt) => {
        const carriers = [...alt].flatMap(([perm, sources]) =>
          /^(obj|admin):/.test(perm) ? sources.filter((s) => s.carrier).map((s) => s.path) : [],
        );
        return new Set(carriers).size >= 2;
      }),
    );
    expect(multi).toHaveLength(20);
    expect(new Set(unbound.map((f) => f.route))).toEqual(new Set(multi.map((r) => `${r.method} ${r.path}`)));
  });

  it('R3c：披露义务缺 need → DISCLOSURE_NEED_UNBOUND（每条披露义务一条）', () => {
    const base = route(MANAGER);
    const table = withEntry(
      MANAGER,
      entry(MANAGER).map(({ need: _need, ...rest }) => rest as Obligation),
    );
    const found = check([base], table).filter((f) => f.code === 'DISCLOSURE_NEED_UNBOUND');
    expect(found).toHaveLength(entry(MANAGER).filter(isDisclosure).length);
    const all = Object.values(REQUIRED).flat().filter(isDisclosure);
    expect(all.every((o) => o.need !== undefined)).toBe(true);
  });

  it('NEED_EVIDENCE_MISSING：need.scope 不是 none 的义务必须有 role: scope 的证据', () => {
    const scoped = Object.entries(REQUIRED).filter(([, os]) => os.some((o) => o.need && o.need.scope !== 'none'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const [key, os] of scoped) {
      const noEvidence = os.map((o) => ({ ...o, at: o.at.filter((e) => e.role !== 'scope') }));
      const found = check([route(key)], withEntry(key, noEvidence)).filter((f) => f.code === 'NEED_EVIDENCE_MISSING');
      expect(found.length, key).toBeGreaterThan(0);
    }
    expect(check(manifest.declared).filter((f) => f.code === 'NEED_EVIDENCE_MISSING')).toEqual([]);
  });

  it('删一条 need（准入 / 披露）→ NEED_UNBOUND / DISCLOSURE_NEED_UNBOUND', () => {
    const base = route(AUTO_APPRAISERS);
    const dropped = entry(AUTO_APPRAISERS).map(({ need: _need, ...rest }) => rest as Obligation);
    expect(codes(check([base], withEntry(AUTO_APPRAISERS, dropped)))).toContain('NEED_UNBOUND');
    const canEdit = 'GET /api/tenant/talent/criteria/:id/model-image';
    const noDisclosureNeed = entry(canEdit).map((o) =>
      isDisclosure(o) ? ({ ...o, need: undefined } as Obligation) : o,
    );
    expect(codes(check([route(canEdit)], withEntry(canEdit, noDisclosureNeed)))).toContain('DISCLOSURE_NEED_UNBOUND');
  });
});

describe('AC-PRM-FW-02 B-01 / B-03 结构弱化：按声明结构与表的披露义务生成，生成数 = 报出数', () => {
  const all = () => manifest.declared.flatMap((r) => disclosureWeakeningsOf(r, REQUIRED));

  it('6 类弱化都至少施加一次，且没有未知类别', () => {
    const kinds = new Set(all().map((w) => w.kind));
    for (const kind of DISCLOSURE_WEAKENING_KINDS) expect(kinds.has(kind), `没有任何声明能施加 ${kind}`).toBe(true);
    expect([...kinds].filter((k) => !DISCLOSURE_WEAKENING_KINDS.includes(k))).toEqual([]);
  });

  for (const kind of DISCLOSURE_WEAKENING_KINDS) {
    it(`${kind}：每一个都报出期望码`, () => {
      const weakenings = all().filter((w) => w.kind === kind);
      const missed = weakenings.filter((w) => !check([w.route]).some((f) => f.code === w.expected));
      expect(
        missed.map((w) => `${w.route.method} ${w.route.path} @${w.at}`),
        `${kind}：生成 ${weakenings.length} 个，未报出 ${missed.length}`,
      ).toEqual([]);
      if (kind.includes('scope')) {
        const detail = weakenings.map((w) => check([w.route]).find((f) => f.code === w.expected)!.detail).join('\n');
        expect(detail, kind).toContain('范围不符');
      }
    });
  }

  it('disclosure→moved 对无 of 的端点不生成；disclosure→any-member 的生成数 = 披露分支数', () => {
    const moved = all().filter((w) => w.kind === 'disclosure→moved');
    expect(moved.every((w) => ['all', 'any'].includes((w.route.policy as { kind: string }).kind))).toBe(true);
    expect(all().filter((w) => w.kind === 'disclosure→any-member')).toHaveLength(disclosureBranches().length);
  });
});

describe('AC-PRM-FW-02 守卫内部义务：内部角色 inner、GUARD_INNER_ALTS 与 GUARD_ROLE_UNBOUND', () => {
  const guards = Object.entries(REQUIRED).flatMap(([key, os]) =>
    os.filter((o) => o.purpose?.startsWith('guard:')).map((o) => [key, o] as const),
  );

  it('现表全部守卫内部义务（PR-A 台账 45 条 + 任职资格 18 条）都登记 inner；角色只取 required / or / when', () => {
    expect(guards.length).toBeGreaterThanOrEqual(45);
    for (const [key, o] of guards) {
      expect(['required', 'or', 'when'], `${key} ${o.perm}`).toContain(o.inner?.role);
    }
  });

  it('删 inner → GUARD_ROLE_UNBOUND（逐条）', () => {
    const stripped: RequiredTable = Object.fromEntries(
      Object.entries(REQUIRED).map(([key, os]) => [
        key,
        os.map((o) => (o.purpose?.startsWith('guard:') ? ({ ...o, inner: undefined } as Obligation) : o)),
      ]),
    );
    const found = check(manifest.declared, stripped).filter((f) => f.code === 'GUARD_ROLE_UNBOUND');
    expect(found).toHaveLength(guards.length);
  });

  it('idp.executor 的内部“或”：HR（权限）或参与人（数据态，不经授权器），带证据', () => {
    const executor = GUARD_INNER_ALTS['idp.executor'];
    expect(executor).toBeDefined();
    expect(Object.keys(executor!.alts).sort()).toEqual(['hr', 'participant']);
    expect(executor!.alts['hr']).toEqual(['obj:IDP.Idp:view']);
    expect(executor!.alts['participant']).toBe('data:idp.planParticipant');
    const synthetic: RequiredTable = Object.fromEntries(
      Object.entries(GUARD_INNER_ALTS).map(([carrier, registered]) => [
        `inner ${carrier}`,
        [{ perm: `guard:${carrier}`, at: registered.at }],
      ]),
    );
    const found = gateEvidence(checkStored(synthetic), '守卫内部备选证据');
    expect(found, show(found)).toEqual([]);
  });

  it('idp.executor 的 9 个执行入口内部角色为 or（hr 备选）；登记错了备选名 → GUARD_INNER_ALT_UNREGISTERED', () => {
    const inner = entry(GOALS).find((o) => o.purpose === 'guard:idp.executor')!.inner;
    expect(inner).toEqual({ role: 'or', group: 'executor', alt: 'hr' });
    const wrong = entry(GOALS).map((o) =>
      o.purpose === 'guard:idp.executor' ? { ...o, inner: { role: 'or' as const, group: 'executor', alt: 'x' } } : o,
    );
    expect(codes(check([route(GOALS)], withEntry(GOALS, wrong)))).toContain('GUARD_INNER_ALT_UNREGISTERED');
  });
});
