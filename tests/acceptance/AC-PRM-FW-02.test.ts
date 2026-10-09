/**
 * AC-PRM-FW-02（F-039 PR-A，docs/08_设计/F-039_权限框架强制_设计.md §4.2 / §4.4 限定版；DEC-300 / DEC-303）：
 * 现状必测基准与声明的反向比较。基准**不读声明**，由三部分生成并冻结在 support/route-policy/baseline/observed-contract.json：
 *   (a) 处理函数及其模块内辅助函数闭包的静态原语探测（按钮 / 范围 / 字段 / 关系 / 本人 / 管理员 / 对象 / 前提 / 守卫 / 命令）；
 *   (b) 中间件层 HTTP 边界探测（匿名 / 非成员 / 仅成员，占位标识与空请求体）；
 *   (c) 分支域常量（职务对象、人员子集、合同操作 × 模式、导入模式、调动发起人、审批业务对象、经理页签）。
 * 声明弱于基准 → 失败；声明多于基准 → 过度声明也失败；突变套件保证第 5 轮列出的每类削弱都被报出。
 * 依赖多维身份探测（范围外样本、字段探针、denied 码）与 recorded 事实防删减的部分按 DEC-303 移到 §10 PR-B。
 */
import { createApp, defineTable, RoutePolicyError, routeManifest, type RouteManifest } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROBE_POLICY_ENTRIES, probeRoutes } from './support/probe-routes.js';
import {
  BASELINE_PATH,
  canonicalJson,
  type ObservedContract,
  observeContract,
  readFrozenContract,
  writeFrozenContract,
} from './support/route-policy/baseline.js';
import { compareDeclarations, type Finding } from './support/route-policy/compare.js';
import { domainConstants } from './support/route-policy/domains.js';
import { MUTATIONS, mutantsOf } from './support/route-policy/mutate.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

let manifest: RouteManifest;
let fresh: ObservedContract;
let frozen: ObservedContract;

beforeAll(async () => {
  const api = tenantApi(testDb().db, { authorize: undefined });
  manifest = routeManifest(api.app);
  fresh = await observeContract(testDb().db, api, manifest);
  if (process.env.ROUTE_POLICY_UPDATE_BASELINE === '1') writeFrozenContract(fresh);
  const stored = readFrozenContract();
  if (!stored) throw new Error(`冻结基准不存在：先用 ROUTE_POLICY_UPDATE_BASELINE=1 生成 ${BASELINE_PATH}`);
  frozen = stored;
});

function codes(findings: readonly Finding[]): string[] {
  return findings.map((f) => f.code);
}

const OPERATOR_REQUIRED = { status: 403, code: 'FORBIDDEN', reason: 'PLATFORM_OPERATOR_REQUIRED' };

describe('AC-PRM-FW-02 现状必测基准（独立于声明）', () => {
  it('基准条目只有 module / edge / primitives，不含任何声明字段', () => {
    const entries = Object.values(fresh.routes);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(['edge', 'module', 'primitives']);
    expect(canonicalJson(fresh)).not.toMatch(/"kind"/);
  });

  it('基准覆盖全部已声明端点（493），键是 METHOD 最终路径', () => {
    const declared = manifest.declared.map((r) => `${r.method} ${r.path}`).sort();
    expect(Object.keys(fresh.routes).sort()).toEqual(declared);
    expect(declared).toHaveLength(493);
  });

  it('边界探测：租户接口匿名 401、非成员 403；平台非运营 403；360 链接无令牌 404；/healthz 200', () => {
    for (const [key, entry] of Object.entries(fresh.routes)) {
      if (key.startsWith('GET /healthz')) {
        expect(entry.edge.anonymous.status, key).toBe(200);
        expect(entry.edge.nonMember.status, key).toBe(200);
        expect(entry.edge.member.status, key).toBe(200);
        continue;
      }
      if (key.includes(' /api/survey360/link') || key.includes(' /api/survey360/report-link')) {
        // 360 链接作答 / 报告收件人链接不经成员中间件：没有令牌（或令牌不对）三种身份都是 404，不泄露链接是否存在
        for (const edge of [entry.edge.anonymous, entry.edge.nonMember, entry.edge.member]) {
          expect(edge, key).toEqual({ status: 404, code: 'NOT_FOUND' });
        }
        continue;
      }
      expect(entry.edge.anonymous, key).toEqual({ status: 401, code: 'UNAUTHENTICATED' });
      if (key.includes(' /api/platform/')) {
        expect(entry.edge.nonMember, key).toEqual(OPERATOR_REQUIRED);
        expect(entry.edge.member, key).toEqual(OPERATOR_REQUIRED);
      } else {
        expect(entry.edge.nonMember, key).toEqual({ status: 403, code: 'TENANT_NOT_MEMBER' });
      }
    }
  });

  it('分支域来自域常量：基准 domains 与 @italent/domain / 模块常量逐项相等', () => {
    expect(fresh.domains).toEqual(domainConstants());
    expect(Object.keys(fresh.domains)).toEqual(
      expect.arrayContaining([
        'job.kind',
        'personnel.subset',
        'contracts.operation',
        'contracts.commandButton',
        'contracts.importMode',
        'transfer.initiator',
        'approval.taskObject',
        'approval.businessType',
        'manager.tab',
      ]),
    );
  });

  it('基准新鲜：重新探测与冻结文件逐字节相等（改动须 ROUTE_POLICY_UPDATE_BASELINE=1 重新生成并随 PR 评审）', () => {
    expect(canonicalJson(fresh)).toBe(readFileSync(BASELINE_PATH, 'utf8'));
    expect(fresh).toEqual(frozen);
  });
});

describe('AC-PRM-FW-02 声明 vs 基准比较', () => {
  it('真实声明不弱于基准，也不多于基准（双向零发现）', () => {
    const findings = compareDeclarations(frozen, manifest.declared);
    expect(findings, findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n')).toEqual([]);
  });

  it('过度声明：给没有守卫的路由加 guards → OVERDECLARED:guard；public 改成 member → 身份不符', () => {
    const health = manifest.declared.find((r) => r.path === '/healthz');
    const plain = manifest.declared.find((r) => !('guards' in r.policy) && r.policy.kind === 'admin');
    if (!health || !plain) throw new Error('缺少 /healthz 或无守卫的 admin 路由');
    const guarded = { ...plain, policy: { ...plain.policy, guards: ['permission.personLinksReadOnly'] } };
    expect(codes(compareDeclarations(frozen, [guarded]))).toContain('OVERDECLARED:guard');
    const memberHealth = {
      ...health,
      policy: { kind: 'member' as const, reason: '突变', fields: { mode: 'none' as const, reason: '突变' } },
    };
    expect(codes(compareDeclarations(frozen, [memberHealth]))).toContain('MISMATCH:identity');
  });

  it('删整条声明：夹具登记表少一键 → createApp 抛 ROUTE_UNDECLARED', () => {
    const { 'GET /api/tenant/probes': _dropped, ...rest } = PROBE_POLICY_ENTRIES;
    const partial = defineTable('probe', rest);
    expect(() => createApp({ db: testDb().db, tenantRoutes: [probeRoutes], routePolicies: [partial] })).toThrow(
      RoutePolicyError,
    );
  });
});

describe('AC-PRM-FW-02 突变套件：第 5 轮列出的每类削弱都被报出', () => {
  it('突变目录覆盖 PR-A 范围内的削弱种类', () => {
    expect(MUTATIONS.map((m) => m.name)).toEqual(
      expect.arrayContaining([
        'button→none',
        'scope→none',
        'fields→none',
        'write.fields→none',
        'delete-write',
        'postcheck→none',
        'delete-precondition',
        'delete-guard',
        'delete-branch',
        'delete-optional',
        'kind→member',
        'domain-drop-value',
      ]),
    );
  });

  for (const mutation of MUTATIONS) {
    it(`${mutation.name} → ${mutation.expected}`, () => {
      const mutants = manifest.declared.flatMap((route) =>
        mutantsOf(route, frozen).filter((m) => m.name === mutation.name),
      );
      expect(mutants.length, `没有任何真实声明能施加突变 ${mutation.name}`).toBeGreaterThan(0);
      const undetected = mutants.filter(
        (m) =>
          !codes(compareDeclarations(frozen, [m.route])).some((code) =>
            mutation.expected.split('|').some((expected) => code.startsWith(expected)),
          ),
      );
      expect(
        undetected.map((m) => `${m.route.method} ${m.route.path}`),
        `${mutation.name} 未被报出`,
      ).toEqual([]);
    });
  }

  it('统计（供 PR 描述）：基准事实数、比较项数、突变数', () => {
    const facts = Object.values(frozen.routes).reduce(
      (sum, entry) => sum + 3 + Object.values(entry.primitives).reduce((n, names) => n + names.length, 0),
      0,
    );
    const mutants = manifest.declared.flatMap((route) => mutantsOf(route, frozen));
    const byName = Object.fromEntries(MUTATIONS.map((m) => [m.name, mutants.filter((x) => x.name === m.name).length]));
    const summary = { routes: manifest.declared.length, facts, domains: Object.keys(frozen.domains).length };
    console.info(JSON.stringify({ ...summary, mutants: mutants.length, byName }));
    expect(facts).toBeGreaterThan(375 * 3);
    expect(mutants.length).toBeGreaterThan(375);
  });
});
