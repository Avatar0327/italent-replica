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
import type { ManifestRoute, RoutePolicy } from '@italent/api';
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
  p3Applicable,
  probeFilePath,
  PROBE_DIR,
  UNREACHED_REASONS,
  writeFrozenProbes,
} from './support/route-policy/discovery.js';
import type { Finding } from './support/route-policy/compare.js';
import { KNOWN_UNCLAIMED } from './support/route-policy/probe-known-gaps.js';
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
const checkAll = () => checkDiscovery(fresh, REQUIRED, manifest.declared, KNOWN_UNCLAIMED);
const withPolicy = (base: ManifestRoute, policy: RoutePolicy): ManifestRoute => ({ ...base, policy });
const withTable = (k: string, obligations: readonly Obligation[]): RequiredTable => ({ ...REQUIRED, [k]: obligations });

describe('AC-PRM-FW-08 发现探测：冻结与覆盖', () => {
  it('覆盖全部已声明端点（438），每个模块一个冻结文件，条目数与模块端点数一致', () => {
    expect(Object.keys(fresh).sort()).toEqual(manifest.declared.map(key).sort());
    expect(manifest.declared).toHaveLength(438);
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
  it('全部端点零发现（P0 认领、P3 非法标识、映射）；已发现的 134 个表漏登只经 KNOWN_UNCLAIMED 钉死登记', () => {
    const findings = checkAll();
    expect(findings, show(findings)).toEqual([]);
  });

  it('不带登记检查：恰好 134 个"端点 × 请求键"表漏登，全部被 KNOWN_UNCLAIMED 的 5 类规则覆盖（每类写明归属与原因）', () => {
    const open = check(manifest.declared);
    expect(codes(open).every((c) => c === 'PROBE_ADMISSION_UNCLAIMED')).toBe(true);
    expect(open).toHaveLength(134);
    expect(KNOWN_UNCLAIMED.reduce((sum, gap) => sum + gap.count, 0)).toBe(134);
    for (const gap of KNOWN_UNCLAIMED) {
      expect(gap.owner.length, gap.id).toBeGreaterThan(5);
      expect(gap.why.length, gap.id).toBeGreaterThan(20);
    }
  });

  it('棘轮：表补上一条认领 → 规则命中数少于登记 → PROBE_KNOWN_GAP_STALE（必须同 PR 删规则）', () => {
    const k = 'GET /api/tenant/org/person-candidates';
    const claimed = withTable(k, [...REQUIRED[k]!, { perm: 'obj:TenantBase.Organization:{create,update}', at: [] }]);
    const findings = checkDiscovery(fresh, claimed, manifest.declared, KNOWN_UNCLAIMED);
    expect(codes(findings)).toEqual(['PROBE_KNOWN_GAP_STALE']);
    expect(findings[0]!.route).toBe('known-gap:org.personCandidates');
  });

  it('棘轮：规则不吸收新漏登——登记范围之外的端点 / 请求键照常报 PROBE_ADMISSION_UNCLAIMED', () => {
    const k = 'GET /api/tenant/employment/transfers/manager';
    const dropped = REQUIRED[k]!.filter((o) => !permClaims(o.perm, fresh[k]!.trace[0]!));
    const findings = checkDiscovery(fresh, withTable(k, dropped), manifest.declared, KNOWN_UNCLAIMED);
    expect(codes(findings)).toEqual(['PROBE_ADMISSION_UNCLAIMED']);
    expect(findings[0]!.route).toBe(k);
  });

  it('棘轮：规则数量被多命中（来了新的同类漏登）→ PROBE_KNOWN_GAP_STALE，不能靠改数字消化', () => {
    const k = 'GET /api/tenant/survey360/roles';
    expect(fresh[k], '前提：端点存在').toBeDefined();
    const bumped = KNOWN_UNCLAIMED.map((gap) =>
      gap.id === 'survey360.allActivities' ? { ...gap, count: gap.count - 1 } : gap,
    );
    const findings = checkDiscovery(fresh, REQUIRED, manifest.declared, bumped);
    expect(codes(findings)).toEqual(['PROBE_KNOWN_GAP_STALE']);
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

  it('gap 只记"表里有授权器类义务（任意用途）却没问到"的端点；原因取自观测状态（400 validation / 404 not-found / 其他 not-asked）', () => {
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
  const hrRoute = () =>
    Object.keys(fresh).find((k) => fresh[k]!.trace.includes(HR) && REQUIRED[k]!.some((o) => o.perm === HR));
  /** 轨迹里某个键只被非准入义务（披露 / 守卫内部 / 条件准入）认领的端点。 */
  const nonAdmissionOnly = () => {
    for (const [k, found] of Object.entries(fresh)) {
      for (const requested of found.trace) {
        const claimers = REQUIRED[k]!.filter((o) => permClaims(o.perm, requested));
        if (claimers.length && claimers.every((o) => o.purpose !== undefined)) return { k, requested, claimers };
      }
    }
    return undefined;
  };

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
    const found = nonAdmissionOnly();
    expect(found, '前提：存在只被非准入义务认领的授权请求').toBeDefined();
    expect(found!.claimers.every((o) => o.purpose !== undefined)).toBe(true);
    expect(codes(check([route(found!.k)])), found!.k).toEqual([]);
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
  /** P3 适用：验参类观测（400 / 404）且不同于占位请求的结果。 */
  const applicable = () => manifest.declared.filter((r) => p3Applicable(fresh[key(r)]!));
  const declaredApplicable = () => applicable().filter((r) => r.policy.invalidId !== undefined);

  it('真实声明：适用的端点登记的 invalidId 都等于观测码；没登记的没有观测到 400 / 404', () => {
    expect(declaredApplicable().length).toBeGreaterThan(100);
    expect(
      applicable()
        .filter((r) => r.policy.invalidId === undefined)
        .map(key),
    ).toEqual([]);
  });

  it('不适用的观测不报：平台非运营 / 自助未绑定的 403、360 链接令牌先于标识校验的 404（等于占位结果）', () => {
    const platform = fresh['GET /api/platform/tenants/:tenantId']!;
    expect(platform.invalidId).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(p3Applicable(platform)).toBe(false);
    const link = fresh['GET /api/survey360/link/tasks/:relationId/questionnaires/:questionnaireId']!;
    expect(link.invalidId).toEqual(link.all);
    expect(p3Applicable(link)).toBe(false);
    const selfService = fresh['GET /api/tenant/self-service/applications/:id']!;
    expect(p3Applicable(selfService)).toBe(false);
  });

  it('invalidId 改码（400 → 404 / 404 → 400）→ MISMATCH:invalidId', () => {
    const picks = [
      declaredApplicable().find((r) => r.policy.invalidId!.status === 400)!,
      declaredApplicable().find((r) => r.policy.invalidId!.status === 404)!,
    ];
    for (const r of picks) {
      const declared = r.policy.invalidId!;
      const flipped =
        declared.status === 400
          ? { status: 404 as const, code: 'NOT_FOUND' as const }
          : { status: 400 as const, code: 'VALIDATION_FAILED' as const };
      const findings = check([withPolicy(r, { ...r.policy, invalidId: flipped } as RoutePolicy)]);
      expect(codes(findings), key(r)).toContain('MISMATCH:invalidId');
    }
  });

  it('改 error.code 不改状态码也报（400 VALIDATION_FAILED → 400 REVISION_REQUIRED）', () => {
    const r = declaredApplicable().find((x) => x.policy.invalidId!.code === 'VALIDATION_FAILED')!;
    const changed = { ...r.policy, invalidId: { status: 400 as const, code: 'REVISION_REQUIRED' as const } };
    expect(codes(check([withPolicy(r, changed as RoutePolicy)])), key(r)).toContain('MISMATCH:invalidId');
  });

  it('没写 invalidId 但观测到 400 / 404：删掉声明里的 invalidId → MISMATCH:invalidId', () => {
    const victims = declaredApplicable();
    expect(victims.length).toBeGreaterThan(100);
    for (const r of victims.filter((_x, i) => i % 15 === 0)) {
      const { invalidId: _drop, ...rest } = r.policy;
      expect(codes(check([withPolicy(r, rest as RoutePolicy)])), key(r)).toContain('MISMATCH:invalidId');
    }
  });

  it('没有 id 参数的端点没有观测，不做 P3', () => {
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
