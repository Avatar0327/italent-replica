/**
 * AC-PRM-FW-02（续，F-039 PR-A 实现审第 1 轮 P2-1 / P2-2）：必须施加的弱化反例。
 * - 审查复现的四个弱化（人员子集列表删点范围分支、同一声明 all → any、职务 :kind 换成合同域、IDP 计划详情参与人
 *   分支降为普通成员）在比较里都必须报出；
 * - 独立登记的结构弱化（support/route-policy/weakenings.ts：删 all 分支、all → any、any 分支降成员、关系降成员、
 *   选择器换域）对全部真实声明逐个施加，不经比较器筛选，每一个都必须报出；
 * - 审批任务的业务对象 / 业务类型域从运行时适配器生成（含 IDP），审批声明与之相等。
 * 只读冻结基准，不重新探测（新鲜度由 AC-PRM-FW-02.test.ts 负责）。
 */
import { type ManifestRoute, routeManifest, type RouteManifest, type RoutePolicy } from '@italent/api';
import { APPROVAL_TYPES, SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { compareDeclarations, type Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { domainConstants } from './support/route-policy/domains.js';
import { WEAKENING_KINDS, weakeningsOf } from './support/route-policy/weakenings.js';
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

function route(key: string): ManifestRoute {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
}

function withPolicy(base: ManifestRoute, policy: RoutePolicy): ManifestRoute {
  return { ...base, policy };
}

const reported = (findings: readonly Finding[]) => findings.some((f) => /^(WEAKER|MISMATCH):/.test(f.code));
const describeFindings = (findings: readonly Finding[]) => findings.map((f) => `${f.code}: ${f.detail}`).join('\n');

type Combinator = Extract<RoutePolicy, { kind: 'all' | 'any' }>;
function combinator(policy: RoutePolicy): Combinator {
  if (policy.kind !== 'all' && policy.kind !== 'any') throw new Error(`不是组合声明：${policy.kind}`);
  return policy;
}

const SUBSET_LIST = 'GET /api/tenant/personnel/employees/:employeeId/subsets/:kind';
const PLAN_DETAIL = 'GET /api/tenant/idp/plans/:id';

describe('AC-PRM-FW-02 审查复现的四个弱化都被报出', () => {
  it('人员子集列表：删 all 的 employeeId 点范围分支 → 报出', () => {
    const base = route(SUBSET_LIST);
    const policy = combinator(base.policy);
    expect(policy.kind).toBe('all');
    const mutated = withPolicy(base, { ...policy, of: [policy.of[0]!] } as RoutePolicy);
    const findings = compareDeclarations(frozen, [mutated]);
    expect(reported(findings), describeFindings(findings)).toBe(true);
  });

  it('人员子集列表：同一声明 all → any → 报出', () => {
    const base = route(SUBSET_LIST);
    const mutated = withPolicy(base, { ...combinator(base.policy), kind: 'any' } as RoutePolicy);
    const findings = compareDeclarations(frozen, [mutated]);
    expect(reported(findings), describeFindings(findings)).toBe(true);
  });

  it('职务 :kind 八个分支换成合同模式域 direct / application → 报出', () => {
    const base = route('GET /api/tenant/job/:kind');
    const policy = base.policy as Extract<RoutePolicy, { kind: 'object' }>;
    const selector = policy.object as { from: 'param'; path: string; map: Record<string, string> };
    expect(Object.keys(selector.map)).toHaveLength(8);
    const [code] = Object.values(selector.map);
    const swapped = { ...selector, map: { direct: code!, application: code! } };
    const findings = compareDeclarations(frozen, [withPolicy(base, { ...policy, object: swapped })]);
    expect(reported(findings), describeFindings(findings)).toBe(true);
  });

  it('IDP 计划详情：参与人关系分支改成普通 member → 报出', () => {
    const base = route(PLAN_DETAIL);
    const policy = combinator(base.policy);
    const index = policy.of.findIndex((branch) => branch.kind === 'relation');
    expect(index).toBeGreaterThanOrEqual(0);
    const memberBranch: RoutePolicy = { kind: 'member', reason: '弱化', fields: { mode: 'none', reason: '弱化' } };
    const of = policy.of.map((branch, i) => (i === index ? memberBranch : branch));
    const findings = compareDeclarations(frozen, [withPolicy(base, { ...policy, of } as RoutePolicy)]);
    expect(reported(findings), describeFindings(findings)).toBe(true);
  });
});

describe('AC-PRM-FW-02 必需准入分支不能移进 optional（实现审第 2 轮 P2-1 残项）', () => {
  it('IDP 任务发放：必需的计划查看分支从 all.of 移进 optional → 报出', () => {
    const base = route('POST /api/tenant/idp/plans/tasks/issue');
    const policy = combinator(base.policy);
    expect(policy.kind).toBe('all');
    const index = policy.of.findIndex((branch) => JSON.stringify(branch).includes('"IDP.Idp"'));
    expect(index).toBeGreaterThanOrEqual(0);
    const moved: RoutePolicy = {
      ...policy,
      of: policy.of.filter((_b, i) => i !== index),
      optional: { ...(policy.optional ?? {}), planView: policy.of[index]! },
    } as RoutePolicy;
    const findings = compareDeclarations(frozen, [withPolicy(base, moved)]);
    expect(reported(findings), describeFindings(findings)).toBe(true);
  });

  it('经理汇报关系页：只把必需的 Transfer.Hr 按钮这一个叶子移进 optional → 报出（实现审第 3 轮）', () => {
    const base = route('GET /api/tenant/employment/transfers/manager/reporting');
    const policy = base.policy as Extract<RoutePolicy, { kind: 'object' }>;
    expect(JSON.stringify(policy.button)).toContain('Transfer.Hr');
    const moved = {
      ...policy,
      button: { none: true as const, reason: '弱化' },
      optional: {
        ...(policy.optional ?? {}),
        hr: {
          kind: 'object' as const,
          object: policy.object,
          operation: 'button' as const,
          button: policy.button,
          scope: { mode: 'none' as const, reason: '弱化' },
          fields: { mode: 'none' as const, reason: '弱化' },
        },
      },
    } as RoutePolicy;
    const findings = compareDeclarations(frozen, [withPolicy(base, moved)]);
    expect(reported(findings), describeFindings(findings)).toBe(true);
  });

  it('同一个布尔授权函数按调用点区分：经理入口 canViewReporting 是披露，汇报关系页的 403 判定是准入', () => {
    const entry = frozen.routes['GET /api/tenant/employment/transfers/manager']!.primitives;
    const reporting = frozen.routes['GET /api/tenant/employment/transfers/manager/reporting']!.primitives;
    expect(entry['disclose']).toContain('button');
    expect(entry['button']).toBeUndefined();
    expect(reporting['button']?.length).toBeGreaterThan(0);
    expect(reporting['disclose'] ?? []).not.toContain('button');
  });

  it('360 评价者导入：员工信息查看只在 sync=true 时校验，登记为条件守卫而不是无条件 AND', () => {
    const policy = route('POST /api/tenant/survey360/activities/:id/appraisers/import').policy;
    expect(JSON.stringify(policy)).toContain('"survey360.syncEmployees"');
    const admission = policy.kind === 'all' ? policy.of : [policy];
    expect(JSON.stringify(admission)).not.toContain('"TenantBase.EmployeeInformation"');
  });
});

describe('AC-PRM-FW-02 独立登记的结构弱化：全部真实声明逐个施加，每个都被报出', () => {
  for (const kind of WEAKENING_KINDS) {
    it(`${kind}`, () => {
      const weakenings = manifest.declared.flatMap((r) => weakeningsOf(r, frozen)).filter((w) => w.kind === kind);
      expect(weakenings.length, `没有任何真实声明能施加 ${kind}`).toBeGreaterThan(0);
      const missed = weakenings.filter((w) => !reported(compareDeclarations(frozen, [w.route])));
      expect(
        missed.map((w) => `${w.route.method} ${w.route.path} @${w.at}`),
        `${kind} 未被报出`,
      ).toEqual([]);
    });
  }

  it('突变套件不用比较器自身的可检测性筛选（mutate.ts 不引用比较器）', () => {
    const source = readFileSync(new URL('./support/route-policy/mutate.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '\.\/compare\.js'/);
    expect(source).not.toMatch(/\bdetectable\(/);
  });
});

describe('AC-PRM-FW-02 审批任务业务域来自运行时适配器（含 IDP）', () => {
  it('approval.businessType = ADAPTERS 的键；approval.taskObject 覆盖每个适配器的字段对象', () => {
    const domains = domainConstants();
    expect(domains['approval.businessType']).toEqual(Object.keys(ADAPTERS).sort());
    expect(domains['approval.businessType']).toContain('idp');
    const typeObjects = Object.values(APPROVAL_TYPES)
      .filter((type) => Object.hasOwn(ADAPTERS, type.adapter) && type.adapter !== 'personnel_change')
      .map((type) => type.objectCode);
    const subsetObjects = Object.values(SUBSETS).map((subset) => subset.objectCode);
    expect(domains['approval.taskObject']).toEqual([...new Set([...typeObjects, ...subsetObjects])].sort());
    expect(domains['approval.taskObject']).toContain('IDP.Idp');
  });

  it('审批五个任务入口的业务对象选择器与域相等（含 IDP.Idp）', () => {
    const expected = [...domainConstants()['approval.taskObject']!].sort();
    for (const action of ['approve', 'disagree', 'reject', 'add-sign', 'edit']) {
      const key = `POST /api/tenant/approval/tasks/:id/${action}`;
      const text = JSON.stringify(route(key).policy);
      expect(text, key).toContain('"IDP.Idp"');
      const domains = [...text.matchAll(/"locator":"approval\.taskObject","attribute":"[^"]+","domain":(\[[^\]]*\])/g)];
      expect(domains.length, key).toBeGreaterThan(0);
      for (const [, domain] of domains) expect([...(JSON.parse(domain!) as string[])].sort(), key).toEqual(expected);
    }
  });
});
