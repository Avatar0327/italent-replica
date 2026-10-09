/**
 * AC-PRM-FW-08（F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-08 步骤一「发现探测」；DEC-356 / 359 / 362）：
 * Tier 0 发现探测。全允许的授权替身对全部已声明端点各发一次占位请求（路径参数占位、写请求体 `{}`），得到结果 O*
 * 与授权请求轨迹 T*；再把第一个 id 参数换成 `not-a-uuid` 观测非法标识。全允许只用于**发现**，不下结论。
 *   P0：T* 的每个授权器请求必须被本端点显式表里某条义务（任意用途）认领，否则 PROBE_ADMISSION_UNCLAIMED；
 *   P3：非法标识的观测码与根节点 invalidId 相等，没写却观测到 400 / 404 也是 MISMATCH:invalidId；
 *   映射不了的授权动作 → PROBE_ACTION_UNMAPPED。
 * 发现事实按模块冻结在 support/route-policy/baseline/probe/<模块>.json（逐字节比较，
 * ROUTE_POLICY_UPDATE_BASELINE=1 重新生成并随 PR 评审）；步骤二（按备选的最小对照）留给 PR-B4b。
 */
import { type ManifestRoute, routeManifest, type RoutePolicy } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from './support/route-policy/baseline.js';
import { createAuthorizerDouble } from './support/route-policy/double.js';
import {
  checkDiscovery,
  createRig,
  discoverAll,
  discoverRoute,
  type EndpointDiscovery,
  groupByModule,
  probeFilePath,
  PROBE_DIR,
  UNREACHED_REASONS,
  writeFrozenProbes,
} from './support/route-policy/discovery.js';
import type { Finding } from './support/route-policy/compare.js';
import { permClaims } from './support/route-policy/request-perms.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';

const testDb = useTestDb();

let manifest: { declared: readonly ManifestRoute[] };
let fresh: Record<string, EndpointDiscovery>;
let requestsSent = 0;

beforeAll(async () => {
  const { rig, manifest: m } = await createRig(testDb().db);
  manifest = m;
  fresh = await discoverAll(rig, m.declared);
  requestsSent = rig.sent;
  if (process.env.ROUTE_POLICY_UPDATE_BASELINE === '1') writeFrozenProbes(fresh);
}, 600_000);

const key = (r: ManifestRoute) => `${r.method} ${r.path}`;
const route = (k: string): ManifestRoute => {
  const found = manifest.declared.find((r) => key(r) === k);
  if (!found) throw new Error(`没有声明 ${k}`);
  return found;
};
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
const check = (routes: readonly ManifestRoute[], table: RequiredTable = REQUIRED, found = fresh) =>
  checkDiscovery(found, table, routes);
const withPolicy = (base: ManifestRoute, policy: RoutePolicy): ManifestRoute => ({ ...base, policy });
const withTable = (k: string, obligations: readonly Obligation[]): RequiredTable => ({ ...REQUIRED, [k]: obligations });

describe('AC-PRM-FW-08 发现探测：冻结与覆盖', () => {
  it('覆盖全部已声明端点（387），每个模块一个冻结文件，条目数与模块端点数一致', () => {
    expect(Object.keys(fresh).sort()).toEqual(manifest.declared.map(key).sort());
    expect(manifest.declared).toHaveLength(387);
    const groups = groupByModule(fresh);
    const files = readdirSync(PROBE_DIR).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(
      Object.keys(groups)
        .map((m) => `${m}.json`)
        .sort(),
    );
    for (const [module, entries] of Object.entries(groups)) {
      const stored = JSON.parse(readFileSync(probeFilePath(module), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(stored).sort(), module).toEqual(Object.keys(entries).sort());
    }
  });

  it('冻结新鲜：重新发现与冻结文件逐字节相等（改动须 ROUTE_POLICY_UPDATE_BASELINE=1 重新生成并随 PR 评审）', () => {
    for (const [module, entries] of Object.entries(groupByModule(fresh))) {
      expect(existsSync(probeFilePath(module)), module).toBe(true);
      expect(canonicalJson(entries), module).toBe(readFileSync(probeFilePath(module), 'utf8'));
    }
  });

  it('请求数 = 端点数 + 带 id 参数的端点数（非法标识各多一次）；探测可重复（两次结果相同）', async () => {
    const withId = Object.values(fresh).filter((d) => d.invalidId !== undefined).length;
    expect(requestsSent).toBe(manifest.declared.length + withId);
    expect(withId).toBeGreaterThan(100);
    const { rig } = await createRig(testDb().db);
    const sample = manifest.declared.filter((_r, i) => i % 40 === 0);
    for (const r of sample) expect(await discoverRoute(rig, r), key(r)).toEqual(fresh[key(r)]);
  }, 120_000);

  it('发现事实只含 O* / T* / 范围与字段查询 / 非法标识 / 未达原因，不含声明字段', () => {
    const allowed = new Set(['all', 'trace', 'scopeQueries', 'fieldQueries', 'invalidId', 'unmapped', 'gap']);
    for (const [k, d] of Object.entries(fresh)) {
      for (const field of Object.keys(d)) expect(allowed.has(field), `${k}.${field}`).toBe(true);
      expect(JSON.stringify(d), k).not.toMatch(/"kind"/);
    }
  });
});

describe('AC-PRM-FW-08 P0 / P3：真实声明 + 显式表零发现', () => {
  it('全部端点零发现（P0 认领、P3 非法标识、映射）', () => {
    const findings = check(manifest.declared);
    expect(findings, show(findings)).toEqual([]);
  });

  it('轨迹里确有授权器请求：多数端点触达了授权点（统计），无映射失败', () => {
    const reached = Object.values(fresh).filter((d) => d.trace.length > 0).length;
    expect(reached).toBeGreaterThan(150);
    for (const [k, d] of Object.entries(fresh)) expect(d.unmapped ?? [], k).toEqual([]);
  });

  it('占位请求验参失败、轨迹为空的端点记 gap（validation）：IDP 新增目标 `{}` → 400 VALIDATION_FAILED（审查二-2 回归）', () => {
    const goals = fresh['POST /api/tenant/idp/plans/:id/goals']!;
    expect(goals.all).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(goals.trace).toEqual([]);
    expect(goals.gap).toEqual({ reason: 'validation' });
    expect(codes(check([route('POST /api/tenant/idp/plans/:id/goals')]))).toEqual([]); // 未达不是失败
  });

  it('gap 只记"表里有授权器类准入义务却没问到"的端点；原因取自观测状态（400 validation / 404 not-found / 其他 not-asked）', () => {
    expect(UNREACHED_REASONS).toEqual(
      expect.arrayContaining([
        'validation',
        'not-found',
        'not-asked',
        'inner-branch-unknown',
        'inner-branch-unsampled',
        'inner-branch-not-standalone',
      ]),
    );
    for (const [k, d] of Object.entries(fresh)) {
      if (!d.gap) continue;
      expect(d.trace, k).toEqual([]);
      const reason = d.all.status === 400 ? 'validation' : d.all.status === 404 ? 'not-found' : 'not-asked';
      expect(d.gap.reason, k).toBe(reason);
    }
  });
});

describe('AC-PRM-FW-08 P0 反例：表漏登 / 错登', () => {
  /** 轨迹含 Transfer.Hr 按钮的端点（经理页 canViewReporting 的披露判定）。 */
  const HR = 'btn:TenantBase.EmploymentRecord#Transfer.Hr@detail';
  const MANAGER_BTN = 'btn:TenantBase.EmploymentRecord#Transfer.Manager@detail';
  const hrRoute = () => Object.keys(fresh).find((k) => fresh[k]!.trace.includes(HR));

  it('表把 Transfer.Hr 错登成 Transfer.Manager → PROBE_ADMISSION_UNCLAIMED（审查原文例）', () => {
    const k = hrRoute();
    expect(k, '没有端点的轨迹含 Transfer.Hr').toBeDefined();
    const wrong = REQUIRED[k!]!.map((o) => (o.perm === HR ? { ...o, perm: MANAGER_BTN } : o));
    const findings = check([route(k!)], withTable(k!, wrong));
    expect(codes(findings)).toContain('PROBE_ADMISSION_UNCLAIMED');
    expect(findings.find((f) => f.code === 'PROBE_ADMISSION_UNCLAIMED')!.detail).toContain(HR);
  });

  it('表漏登一条被问到的授权（删掉认领它的全部义务）→ PROBE_ADMISSION_UNCLAIMED，只报被删的那个键', () => {
    const k = Object.keys(fresh).find((x) => fresh[x]!.trace.length >= 2)!;
    const dropped = fresh[k]!.trace[0]!;
    const kept = REQUIRED[k]!.filter((o) => !permClaims(o.perm, dropped));
    expect(kept.length, '前提：确有义务认领该键').toBeLessThan(REQUIRED[k]!.length);
    const findings = check([route(k)], withTable(k, kept));
    expect(codes(findings)).toContain('PROBE_ADMISSION_UNCLAIMED');
  });

  it('任何用途都认领：纯披露 / 守卫内部 / 条件准入的权限同样算已登记（不因用途报 P0）', () => {
    const k = hrRoute()!;
    const purposes = REQUIRED[k]!.filter((o) => o.perm === HR).map((o) => o.purpose);
    expect(
      purposes.some((p) => p?.startsWith('disclosure:')),
      '前提：该端点把 Hr 登成披露',
    ).toBe(true);
    expect(codes(check([route(k)]))).toEqual([]);
  });

  it('轨迹为空的端点 P0 不适用：表即使多登义务也不在这里报', () => {
    const k = 'POST /api/tenant/idp/plans/:id/goals';
    const extra: Obligation = { perm: 'admin:audit_log', at: [] };
    expect(codes(check([route(k)], withTable(k, [...REQUIRED[k]!, extra])))).toEqual([]);
  });

  it('缺发现事实 → PROBE_DISCOVERY_MISSING（不静默放过）', () => {
    const k = key(manifest.declared[0]!);
    const { [k]: _omitted, ...rest } = fresh;
    expect(codes(check([route(k)], REQUIRED, rest))).toEqual(['PROBE_DISCOVERY_MISSING']);
  });
});

describe('AC-PRM-FW-08 P3 非法标识：观测码与根节点 invalidId 相等', () => {
  const declaredInvalid = () =>
    manifest.declared.filter((r) => r.policy.invalidId !== undefined && fresh[key(r)]!.invalidId !== undefined);
  const undeclaredButObserved = () =>
    manifest.declared.filter((r) => {
      const seen = fresh[key(r)]!.invalidId;
      return r.policy.invalidId === undefined && (seen?.status === 400 || seen?.status === 404);
    });

  it('真实声明：登记了 invalidId 的端点观测码相等；没登记的没有观测到 400 / 404', () => {
    expect(declaredInvalid().length).toBeGreaterThan(20);
    expect(undeclaredButObserved().map(key)).toEqual([]);
  });

  it('invalidId 改码（400 → 404 / 404 → 400）→ MISMATCH:invalidId', () => {
    for (const r of declaredInvalid().slice(0, 6)) {
      const declared = r.policy.invalidId!;
      const flipped =
        declared.status === 400
          ? { status: 404 as const, code: 'NOT_FOUND' as const }
          : { status: 400 as const, code: 'VALIDATION_FAILED' as const };
      const findings = check([withPolicy(r, { ...r.policy, invalidId: flipped } as RoutePolicy)]);
      expect(codes(findings), key(r)).toContain('MISMATCH:invalidId');
    }
  });

  it('没写 invalidId 但观测到 400 / 404：删掉声明里的 invalidId → MISMATCH:invalidId', () => {
    const victims = declaredInvalid().filter((r) => [400, 404].includes(fresh[key(r)]!.invalidId!.status));
    expect(victims.length).toBeGreaterThan(10);
    for (const r of victims.slice(0, 6)) {
      const { invalidId: _drop, ...rest } = r.policy;
      expect(codes(check([withPolicy(r, rest as RoutePolicy)])), key(r)).toContain('MISMATCH:invalidId');
    }
  });

  it('没有 id 参数的端点不做 P3（没有观测就不报）', () => {
    const plain = manifest.declared.find((r) => fresh[key(r)]!.invalidId === undefined)!;
    const withInvalid = withPolicy(plain, {
      ...plain.policy,
      invalidId: { status: 404, code: 'NOT_FOUND' },
    } as RoutePolicy);
    expect(codes(check([withInvalid]))).toEqual([]);
  });
});

describe('AC-PRM-FW-08 映射失败与接口预留', () => {
  const miniRig = (action: string) => {
    const double = createAuthorizerDouble();
    return {
      double,
      sent: 0,
      send: async () => {
        await double.authorize({ tenantId: 't', userId: 'u', action, resource: 'X' });
        return new Response('{"ok":true}', { status: 200 });
      },
    };
  };
  const fixtureRoute = (): ManifestRoute => ({ ...manifest.declared[0]!, path: '/fixture', method: 'GET' });

  it('处理函数发出映射不了的授权动作 → 发现事实记 unmapped，检查报 PROBE_ACTION_UNMAPPED', async () => {
    const found = await discoverRoute(miniRig('survey360.sheet.delete'), fixtureRoute());
    expect(found.unmapped).toEqual(['survey360.sheet.delete']);
    const findings = checkDiscovery({ 'GET /fixture': found }, { 'GET /fixture': [] }, [fixtureRoute()]);
    expect(codes(findings)).toEqual(['PROBE_ACTION_UNMAPPED']);
  });

  it('可映射的动作进入轨迹；表里没有 → P0；范围查询与字段查询单独记，不进轨迹也不被 P0 认领', async () => {
    const found = await discoverRoute(miniRig('object.view'), fixtureRoute());
    expect(found.trace).toEqual(['obj:X:view']);
    expect(codes(checkDiscovery({ 'GET /fixture': found }, { 'GET /fixture': [] }, [fixtureRoute()]))).toEqual([
      'PROBE_ADMISSION_UNCLAIMED',
    ]);
    const scope = await discoverRoute(miniRig('data.scope.all'), fixtureRoute());
    expect(scope.trace).toEqual([]);
    expect(scope.scopeQueries).toEqual(['scope:data.scope.all:X']);
  });

  it('PR-B4b 的接口：冻结条目可带 denialShift / 未达原因，检查器不因这些预留字段报错', () => {
    const k = 'POST /api/tenant/idp/plans/:id/goals';
    const withFacts: Record<string, EndpointDiscovery> = {
      ...fresh,
      [k]: {
        ...fresh[k]!,
        denialShift: '403/IDP_NODE_BUTTON_DENIED → 404/NOT_FOUND',
        gap: { reason: 'inner-branch-not-standalone' },
      },
    };
    expect(codes(check([route(k)], REQUIRED, withFacts))).toEqual([]);
  });
});
