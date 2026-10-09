/**
 * AC-PRM-FW-02（续，F-039 PR-B1 第 2 轮，#162 审查 P2-1 / P2-2 / P2-3 与 P3）：
 * - P2-1 范围按**实际对象**逐项选择，缺项即失败，不能借用其他对象的范围：byObject 没有该对象也没有 `*` → 范围缺失；
 *   动态对象（映射 / 域）逐个对象取范围，每个都要满足 need；
 * - P2-2 守卫内部 `when` 条件必须登记语义（含空数组 / 已有引用 / 新增引用），登记表与真实路由代码一致；
 * - P2-3 内部“或”备选的绑定：数据态备选不能承载带权限键的义务，权限备选必须含该权限；
 * - P3 覆盖断言补反向差集与统计；披露“或”组按分支逐个检查。
 */
import { type ManifestRoute, routeManifest, type RouteManifest, type RoutePolicy } from '@italent/api';
import { SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { coverageStats, expectedMutationKeys, extraCoverage } from './support/route-policy/required-coverage.js';
import { requiredMutants } from './support/route-policy/required-mutate.js';
import { checkRequired } from './support/route-policy/required.js';
import { GUARD_INNER_ALTS, INNER_CONDITIONS } from './support/route-policy/required/guard-inner.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';
import { disclosureWeakeningsOf } from './support/route-policy/weakenings.js';
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

type Node = Record<string, unknown>;
const route = (key: string): ManifestRoute => {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
};
const withPolicy = (base: ManifestRoute, policy: unknown): ManifestRoute => ({
  ...base,
  policy: policy as RoutePolicy,
});
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
const check = (routes: readonly ManifestRoute[], table: RequiredTable = REQUIRED) =>
  checkRequired(table, frozen, routes);
const entry = (key: string): readonly Obligation[] => REQUIRED[key] ?? [];
const withEntry = (key: string, obligations: readonly Obligation[]): RequiredTable => ({
  ...REQUIRED,
  [key]: obligations,
});
const clone = <T>(value: T): T => structuredClone(value);
const NONE_SCOPE = { mode: 'none', reason: '夹具' };

const NESTED_SUBSETS = 'GET /api/tenant/personnel/employees/:id';
const MODEL_IMAGE = 'GET /api/tenant/talent/criteria/:id/model-image';

describe('AC-PRM-FW-02 P2-1 范围按实际对象逐项选择（审查 #162 第 1 轮）', () => {
  it('人员详情 optional.nestedSubsets：只有 Education 保留 personScope、其余子集 *:none → DISCLOSURE_WEAK（范围不符）', () => {
    const base = route(NESTED_SUBSETS);
    const policy = clone(base.policy) as unknown as Node;
    const branch = (policy['optional'] as Record<string, Node>)['nestedSubsets']!;
    branch['scope'] = { byObject: { 'TenantBase.Education': branch['scope'], '*': clone(NONE_SCOPE) } };
    const found = check([withPolicy(base, policy)]).filter((f) => f.code === 'DISCLOSURE_WEAK');
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((f) => f.detail).join('\n')).toContain('范围不符');
  });

  it('模型图 optional.canEdit：范围只登记给无关的 EmployeeInformation → DISCLOSURE_WEAK', () => {
    const base = route(MODEL_IMAGE);
    const policy = clone(base.policy) as unknown as Node;
    const branch = (policy['optional'] as Record<string, Node>)['canEdit']!;
    branch['scope'] = { byObject: { 'TenantBase.EmployeeInformation': branch['scope'] } };
    expect(codes(check([withPolicy(base, policy)]))).toContain('DISCLOSURE_WEAK');
  });

  it('byObject 有 * 兜底时静态对象取兜底项；真实 byObject 声明（职务 :kind 等）仍零发现', () => {
    const jobRoutes = manifest.declared.filter((r) => JSON.stringify(r.policy).includes('"byObject"'));
    expect(jobRoutes.length).toBeGreaterThan(0);
    expect(check(jobRoutes)).toEqual([]);
  });

  it('生成弱化 scope→foreign-object（范围只登记给无关对象）：对每个“唯一满足 need 的来源节点”施加，全部报出', () => {
    const all = manifest.declared.flatMap((r) => disclosureWeakeningsOf(r, REQUIRED));
    const foreign = all.filter((w) => w.kind === 'scope→foreign-object');
    expect(new Set(foreign.map((w) => `${w.route.method} ${w.route.path}`)).size).toBeGreaterThanOrEqual(42);
    expect(foreign.length).toBeGreaterThanOrEqual(49);
    const missed = foreign.filter((w) => !check([w.route]).some((f) => f.code === w.expected));
    expect(
      missed.map((w) => `${w.route.method} ${w.route.path} @${w.at}`),
      '未报出',
    ).toEqual([]);
  });

  // 第 3 轮（#162 第 2 轮审查 P2-1 残项）：对象型 mapper 的 domain 是**输入键**（子集名），真实路由按
  // SUBSETS[kind].objectCode 判权与解析范围（personnel/routes.ts nestedSubsets）；范围必须按实际输出对象选择
  const nestedSubsetsWith = (keyed: (key: string, code: string) => string, fallbackNone: boolean) => {
    const base = route(NESTED_SUBSETS);
    const policy = clone(base.policy) as unknown as Node;
    const branch = (policy['optional'] as Record<string, Node>)['nestedSubsets']!;
    const selector = branch['object'] as { domain: readonly string[] };
    const original = branch['scope'];
    const byObject: Record<string, unknown> = Object.fromEntries(
      selector.domain.map((key) => [keyed(key, SUBSETS[key as keyof typeof SUBSETS].objectCode), clone(original)]),
    );
    if (fallbackNone) byObject['*'] = clone(NONE_SCOPE);
    branch['scope'] = { byObject };
    return withPolicy(base, policy);
  };

  it('对象型 mapper：byObject 用 13 个子集名（输入键）登记范围、其余 *:none → 13 个实际对象都落入 none，报 DISCLOSURE_WEAK', () => {
    const findings = check([nestedSubsetsWith((key) => key, true)]);
    const weak = findings.filter((f) => f.code === 'DISCLOSURE_WEAK');
    expect(weak.length, show(findings)).toBeGreaterThan(0);
    expect(weak.map((f) => f.detail).join('\n')).toContain('范围不符');
  });

  it('对象型 mapper：byObject 用 13 个实际对象编码完整登记同一范围 → 零发现（不误报）', () => {
    const findings = check([nestedSubsetsWith((_key, code) => code, false)]);
    expect(findings, show(findings)).toEqual([]);
  });

  it('对象型 mapper：只给 TenantBase.Education 登记范围、其余 *:none（按实际编码的部分对象）→ DISCLOSURE_WEAK', () => {
    const findings = check([
      nestedSubsetsWith((key, code) => (key === 'education' ? code : `Fixture.Skip.${key}`), true),
    ]);
    expect(codes(findings)).toContain('DISCLOSURE_WEAK');
  });

  it('对象型 mapper 未登记实际输出对象（或域里有未登记的输入键）→ OBJECT_MAPPER_UNMAPPED', () => {
    const base = route(NESTED_SUBSETS);
    const unknownMapper = clone(base.policy) as unknown as Node;
    const branchA = (unknownMapper['optional'] as Record<string, Node>)['nestedSubsets']!;
    branchA['object'] = { ...(branchA['object'] as Node), mapper: 'fixture.unknownMapper' };
    expect(codes(check([withPolicy(base, unknownMapper)]))).toContain('OBJECT_MAPPER_UNMAPPED');
    const unknownKey = clone(base.policy) as unknown as Node;
    const branchB = (unknownKey['optional'] as Record<string, Node>)['nestedSubsets']!;
    const selector = branchB['object'] as { domain: string[] };
    branchB['object'] = { ...(branchB['object'] as Node), domain: [...selector.domain, 'fixture-subset'] };
    expect(codes(check([withPolicy(base, unknownKey)]))).toContain('OBJECT_MAPPER_UNMAPPED');
  });

  it('弱化生成器按 mapper 实际输出对象生成 scope→partial-object：保留项的键是实际对象编码，且报出', () => {
    const partial = disclosureWeakeningsOf(route(NESTED_SUBSETS), REQUIRED).filter(
      (w) => w.kind === 'scope→partial-object',
    );
    expect(partial.length).toBeGreaterThan(0);
    for (const w of partial) {
      const branch = ((w.route.policy as unknown as Node)['optional'] as Record<string, Node>)['nestedSubsets']!;
      const keys = Object.keys((branch['scope'] as { byObject: Node }).byObject);
      expect(keys).toEqual([SUBSETS.education.objectCode, '*']);
      expect(codes(check([w.route]))).toContain(w.expected);
    }
  });

  it('生成弱化 scope→partial-object（动态对象只给部分对象保留范围，其余 *:none）：全部报出', () => {
    const partial = manifest.declared
      .flatMap((r) => disclosureWeakeningsOf(r, REQUIRED))
      .filter((w) => w.kind === 'scope→partial-object');
    const keys = new Set(partial.map((w) => `${w.route.method} ${w.route.path}`));
    for (const expected of [NESTED_SUBSETS, 'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind']) {
      expect(keys.has(expected), expected).toBe(true);
    }
    expect(keys.has('GET /api/tenant/talent/forms/:object')).toBe(true);
    const missed = partial.filter((w) => !check([w.route]).some((f) => f.code === w.expected));
    expect(missed.map((w) => `${w.route.method} ${w.route.path} @${w.at}`)).toEqual([]);
  });
});

describe('AC-PRM-FW-02 P2-2 守卫内部 when 条件：登记语义，与真实路由代码一致', () => {
  const conditionOf = (key: string, perm: string, carrier: string): string | undefined => {
    const inner = entry(key).find((o) => o.perm === perm && o.purpose === `guard:${carrier}`)?.inner;
    return inner?.role === 'when' ? inner.condition : undefined;
  };
  const Q = '/api/tenant/qualification';
  const T = '/api/tenant/talent';

  it.each([
    [
      `PUT ${Q}/standards/:id/channels`,
      'obj:Qualification.EmploymentCategory:view',
      'ql.referenced(category)',
      'channels.nonEmpty',
    ],
    [
      `PUT ${Q}/standards/:id/channels`,
      'obj:Qualification.EmploymentLevel:view',
      'ql.referenced(level)',
      'channels.nonEmpty',
    ],
    [`PATCH ${Q}/targets/:id`, 'obj:Qualification.GradeScheme:view', 'ql.referenced(gradeScheme)', 'grade.changed'],
    [`POST ${Q}/targets`, 'obj:Qualification.GradeScheme:view', 'ql.referenced(gradeScheme)', 'evalMode=grade'],
    [`POST ${T}/criteria`, 'obj:TalentCenter.Dimension:view', 'talent.referenced(dimension)', 'dimensions.nonEmpty'],
    [
      `PATCH ${T}/criteria/:id`,
      'obj:TalentCenter.Dimension:view',
      'talent.referenced(dimension)',
      'dimensions.newReference',
    ],
    [`POST ${Q}/standards`, 'obj:Qualification.Target:view', 'ql.referenced(target)', 'details.targetReference'],
    [`PATCH ${Q}/standards/:id`, 'obj:Qualification.Target:view', 'ql.referenced(target)', 'details.targetReference'],
  ])('%s %s 的条件是 %s', (key, perm, carrier, expected) => {
    expect(conditionOf(key, perm, carrier)).toBe(expected);
  });

  it('每个 when 条件都登记了语义（含空数组 / 已有引用 / 新增引用的说明）；表里用到的条件都已登记', () => {
    const used = new Set(
      Object.values(REQUIRED)
        .flat()
        .flatMap((o) => (o.inner?.role === 'when' ? [o.inner.condition] : [])),
    );
    expect([...used].filter((name) => !INNER_CONDITIONS[name])).toEqual([]);
    for (const name of ['channels.nonEmpty', 'grade.changed', 'dimensions.nonEmpty', 'dimensions.newReference']) {
      expect(INNER_CONDITIONS[name], name).toMatch(/空数组|已有|新增|变更/);
    }
    expect(INNER_CONDITIONS['details.targetReference']).toContain('空数组');
    expect(INNER_CONDITIONS['dimensions.newReference']).toContain('weight');
  });

  it('when 条件未登记 → GUARD_INNER_CONDITION_UNREGISTERED', () => {
    const key = `PATCH ${T}/criteria/:id`;
    const wrong = entry(key).map((o) =>
      o.inner?.role === 'when' && o.inner.condition === 'dimensions.newReference'
        ? { ...o, inner: { role: 'when' as const, condition: 'payload.dimensions' } }
        : o,
    );
    expect(codes(check([route(key)], withEntry(key, wrong)))).toContain('GUARD_INNER_CONDITION_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 P2-3 内部“或”备选绑定：数据态备选不能承载权限，权限备选须含该权限', () => {
  const ors = Object.entries(REQUIRED).flatMap(([key, os]) =>
    os.filter((o) => o.inner?.role === 'or').map((o) => [key, o] as const),
  );

  it('现表的内部“或”义务：审批 canOpen 管理员按钮 6 条 + IDP 执行人计划查看权 9 条，全部登记', () => {
    expect(ors.filter(([, o]) => o.purpose === 'guard:approval.canOpen')).toHaveLength(6);
    expect(ors.filter(([, o]) => o.purpose === 'guard:idp.executor')).toHaveLength(9);
  });

  it('逐条把 inner.alt 改成同组的其他备选（含数据态 participant / initiator）→ 都报 GUARD_INNER_ALT_UNREGISTERED', () => {
    let tried = 0;
    for (const [key, o] of ors) {
      const carrier = o.purpose!.slice('guard:'.length);
      const registered = GUARD_INNER_ALTS[carrier]!;
      for (const alt of Object.keys(registered.alts).filter((name) => name !== (o.inner as { alt: string }).alt)) {
        const mutated = entry(key).map((x) =>
          x === o ? { ...x, inner: { role: 'or' as const, group: registered.group, alt } } : x,
        );
        const found = check([route(key)], withEntry(key, mutated));
        expect(codes(found), `${key} ${o.perm} → ${alt}\n${show(found)}`).toContain('GUARD_INNER_ALT_UNREGISTERED');
        tried += 1;
      }
    }
    expect(tried).toBeGreaterThanOrEqual(15);
  });

  it('审批管理员按钮的 inner.alt 从 adminTransfer 改成 participant 必须报出（审查原文反例）', () => {
    const key = 'GET /api/tenant/approval/instances/:id';
    const mutated = entry(key).map((o) =>
      o.perm === 'btn:TenantBase.ApprovalInstance#adminTransfer@detail' && o.purpose === 'guard:approval.canOpen'
        ? { ...o, inner: { role: 'or' as const, group: 'canOpen', alt: 'participant' } }
        : o,
    );
    expect(codes(check([route(key)], withEntry(key, mutated)))).toContain('GUARD_INNER_ALT_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 P3 覆盖断言反向差集与统计；披露“或”组按分支逐个检查', () => {
  it('B-05 反向差集：actual − expected 为空；夹具里多生成一个无来源的突变会被报出', () => {
    const expected = manifest.declared.flatMap((r) => expectedMutationKeys(r, REQUIRED));
    const mutants = manifest.declared.flatMap((r) => requiredMutants(r, REQUIRED));
    expect(extraCoverage(expected, mutants)).toEqual([]);
    const fake = { ...mutants.find((m) => m.kind === 'required→none')!, coverageKey: 'GET /fixture|obj:X:view|1|' };
    expect(extraCoverage(expected, [...mutants, fake])).toEqual(['required→none|GET /fixture|obj:X:view|1|']);
  });

  it('B-05 统计：类 × 用途 × 端点数，每类至少一个端点，合计等于突变总数', () => {
    const mutants = manifest.declared.flatMap((r) => requiredMutants(r, REQUIRED));
    const stats = coverageStats(mutants);
    expect(stats.length).toBeGreaterThan(0);
    for (const row of stats) {
      expect(row.endpoints, `${row.kind}/${row.purpose}`).toBeGreaterThan(0);
      expect(['admission', 'disclosure', 'when']).toContain(row.purpose);
    }
    expect(stats.reduce((sum, row) => sum + row.mutants, 0)).toBe(mutants.length);
  });

  it('披露“或”组跨分支同名：第二个分支降成普通成员也要报（不能只检查首个分支）', () => {
    const key = 'GET /api/tenant/employment/transfers/manager';
    const base = route(key);
    const apply = entry(key).find((o) => o.purpose === 'disclosure:canApply')!;
    const view = entry(key).find((o) => o.purpose === 'disclosure:canViewReporting')!;
    const others = entry(key).filter((o) => o !== apply && o !== view);
    const table = withEntry(key, [...others, { ...apply, or: 'local:a' }, { ...view, or: 'local:b' }]);
    expect(check([base], table)).toEqual([]);
    const policy = clone(base.policy) as unknown as Node;
    const optional = policy['optional'] as Record<string, Node>;
    optional['canViewReporting'] = {
      kind: 'member',
      reason: '夹具',
      fields: { mode: 'none', reason: '夹具' },
    };
    const found = check([withPolicy(base, policy)], table);
    expect(codes(found), show(found)).toContain('DISCLOSURE_WEAK');
  });
});
