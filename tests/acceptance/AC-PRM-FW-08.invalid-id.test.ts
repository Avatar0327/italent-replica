/**
 * AC-PRM-FW-08（续，F-039 PR-B4a 第 3 轮，#163 第 2 轮审查 P2-R2-1 与 P3）：非法标识检查（P3）的适用性必须由
 * **本端点的实际行为**证明，不能凭“端点在证据表里”判定。
 * - 占位请求与非法标识请求的观测按“状态码 + 错误码 + reason + 错误体指纹（message / details）”比较：
 *   不同 → 标识确实影响了结果，P3 适用；相同 → 两次失败在别处（请求体先验、标识校验被删），未达，不能当作已验证。
 * - 适用性与冻结事实相比发生变化 → PROBE_ID_APPLICABILITY_CHANGED（删掉标识校验、改成请求体先验都会触发复核）。
 * - 非法标识观测到 5xx → PROBE_ID_SERVER_ERROR（标识没有被校验）。
 * - P3：账本证据锚点规范化后为空（纯注释）→ 报错，检查不能恒真。
 */
import type { ManifestRoute, RoutePolicy, TenantRouteModule } from '@italent/api';
import { AppError, defineTable } from '@italent/api';
import { isUuid } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Finding } from './support/route-policy/compare.js';
import {
  checkDiscovery,
  checkIdApplicabilityDrift,
  createRig,
  discoverAll,
  discoverRoute,
  type EndpointDiscovery,
  p3Applicable,
  readFrozenProbes,
} from './support/route-policy/discovery.js';
import { checkEvidenceRefs, KNOWN_GAPS } from './support/route-policy/probe-known-gaps.js';
import { REDUNDANT_OBSERVATIONS } from './support/route-policy/probe-redundant.js';
import { REQUIRED } from './support/route-policy/required/index.js';

const testDb = useTestDb();
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const key = (r: ManifestRoute) => `${r.method} ${r.path}`;

const GOALS = 'POST /api/tenant/idp/plans/:id/goals';

let frozen: Record<string, EndpointDiscovery>;
let goalsRoute: ManifestRoute;

beforeAll(async () => {
  frozen = readFrozenProbes();
  const { manifest } = await createRig(testDb().db);
  goalsRoute = manifest.declared.find((r) => key(r) === GOALS)!;
});

describe('AC-PRM-FW-08 P3 适用性由实际行为证明（#163 第 2 轮 P2-R2-1）', () => {
  it('真实 IDP 目标新增：占位与非法标识的错误体不同（标识校验先于请求体）→ 适用，不依赖证据表', () => {
    const found = frozen[GOALS]!;
    expect(found.invalidId?.status).toBe(400);
    expect(found.invalidId).not.toEqual(found.all);
    expect(p3Applicable(GOALS, found)).toBe(true);
  });

  it('删除标识校验：非法标识与占位请求在同一处（请求体）失败、错误体相同 → 未达，且与冻结事实相比报 PROBE_ID_APPLICABILITY_CHANGED', () => {
    const before = frozen[GOALS]!;
    const removed: EndpointDiscovery = { ...before, invalidId: { ...before.all } };
    expect(p3Applicable(GOALS, removed)).toBe(false);
    expect(codes(checkIdApplicabilityDrift({ [GOALS]: removed }, { [GOALS]: before }))).toEqual([
      'PROBE_ID_APPLICABILITY_CHANGED',
    ]);
  });

  it('改为先验请求体、随后对非法标识返回 404：正确的 404 声明不被误报 MISMATCH:invalidId', () => {
    const before = frozen[GOALS]!;
    const bodyFirst: EndpointDiscovery = { ...before, invalidId: { ...before.all } };
    const policy = { ...goalsRoute.policy, invalidId: { status: 404, code: 'NOT_FOUND' } } as RoutePolicy;
    const findings = checkDiscovery({ [GOALS]: bodyFirst }, REQUIRED, [{ ...goalsRoute, policy }]);
    expect(codes(findings)).not.toContain('MISMATCH:invalidId');
  });

  it('全部端点：适用性与冻结事实一致（零漂移）；观测相同的端点一律不适用', () => {
    expect(checkIdApplicabilityDrift(frozen, frozen)).toEqual([]);
    for (const [k, found] of Object.entries(frozen)) {
      if (found.invalidId && JSON.stringify(found.invalidId) === JSON.stringify(found.all)) {
        expect(p3Applicable(k, found), k).toBe(false);
      }
    }
  });

  it('非法标识观测到 5xx → PROBE_ID_SERVER_ERROR（标识没有被校验）', () => {
    const before = frozen[GOALS]!;
    const crashed: EndpointDiscovery = { ...before, invalidId: { status: 500, code: 'INTERNAL_ERROR' } };
    expect(codes(checkDiscovery({ [GOALS]: crashed }, REQUIRED, [goalsRoute]))).toContain('PROBE_ID_SERVER_ERROR');
  });
});

/** 夹具端点：同一请求体校验，分别是“标识先验”“删掉标识校验”“请求体先验再对非法标识 404”。 */
const FIXTURE_BASE = '/api/tenant/fw-invalid-id';
const parseName = async (c: { req: { json: () => Promise<unknown> } }) => {
  const body = (await c.req.json()) as { name?: unknown };
  if (typeof body.name !== 'string') throw new AppError('VALIDATION_FAILED', '夹具请求体不合法');
  return body.name;
};
const fixtureRoutes: TenantRouteModule = (router) => {
  router.post(`${FIXTURE_BASE}/checked/:id`, async (c) => {
    if (!isUuid(c.req.param('id'))) throw new AppError('VALIDATION_FAILED', '夹具标识必须为 UUID');
    await parseName(c);
    throw new AppError('NOT_FOUND', '夹具对象不存在');
  });
  router.post(`${FIXTURE_BASE}/removed/:id`, async (c) => {
    await parseName(c);
    if (!isUuid(c.req.param('id'))) throw new Error('夹具：标识未校验');
    throw new AppError('NOT_FOUND', '夹具对象不存在');
  });
  router.post(`${FIXTURE_BASE}/body-first/:id`, async (c) => {
    await parseName(c);
    if (!isUuid(c.req.param('id'))) throw new AppError('NOT_FOUND', '夹具对象不存在');
    throw new AppError('NOT_FOUND', '夹具对象不存在');
  });
};
const fixturePolicy = (status: 400 | 404): RoutePolicy =>
  ({
    kind: 'member',
    reason: '夹具',
    fields: { mode: 'none', reason: '夹具' },
    write: {
      fields: { none: true, reason: '夹具' },
      footprint: { none: true, reason: '夹具' },
      result: { none: true, reason: '夹具' },
    },
    invalidId: { status, code: status === 400 ? 'VALIDATION_FAILED' : 'NOT_FOUND' },
  }) as RoutePolicy;
const FIXTURE_POLICIES = defineTable('fw-invalid-id', {
  [`POST ${FIXTURE_BASE}/checked/:id`]: fixturePolicy(400),
  [`POST ${FIXTURE_BASE}/removed/:id`]: fixturePolicy(400),
  [`POST ${FIXTURE_BASE}/body-first/:id`]: fixturePolicy(404),
});

describe('AC-PRM-FW-08 P3 夹具端点（真实 HTTP）：标识先验 / 删校验 / 请求体先验', () => {
  it('标识先验 → 适用且零发现；删校验与请求体先验 → 未达、不误报；删校验相对“标识先验”的事实报适用性变化', async () => {
    const { rig, manifest } = await createRig(testDb().db, {
      tenantRoutes: [fixtureRoutes],
      routePolicies: [FIXTURE_POLICIES],
    });
    const routes = manifest.declared.filter((r) => r.path.startsWith(FIXTURE_BASE));
    expect(routes).toHaveLength(3);
    const found = await discoverAll(rig, routes, {});
    const at = (name: string) => `POST ${FIXTURE_BASE}/${name}/:id`;
    expect(p3Applicable(at('checked'), found[at('checked')]!)).toBe(true);
    expect(p3Applicable(at('removed'), found[at('removed')]!)).toBe(false);
    expect(p3Applicable(at('body-first'), found[at('body-first')]!)).toBe(false);
    expect(checkDiscovery(found, {}, routes)).toEqual([]);
    const drift = checkIdApplicabilityDrift(
      { [at('checked')]: found[at('removed')]! },
      { [at('checked')]: found[at('checked')]! },
    );
    expect(codes(drift)).toEqual(['PROBE_ID_APPLICABILITY_CHANGED']);
    expect(await discoverRoute(rig, routes[0]!, {})).toEqual(found[key(routes[0]!)]);
  });
});

describe('AC-PRM-FW-08 账本证据锚点不能是纯注释（#163 第 2 轮 P3）', () => {
  it('规范化后为空的锚点报错，不能恒真', () => {
    const group = { id: 'fixture#1', evidence: [{ file: 'apps/api/src/app.ts', anchor: '// 只是注释' }] };
    expect(codes(checkEvidenceRefs([group], 'PROBE_KNOWN_GAP_EVIDENCE'))).toEqual(['PROBE_KNOWN_GAP_EVIDENCE']);
  });

  it('真实账本：已知缺口与冗余观测的证据锚点都有实际代码记号；冗余观测账本已清空（F-075 去掉原审定的 41 项，F-075b 去掉 #125 的 18 项）', () => {
    expect(checkEvidenceRefs(KNOWN_GAPS, 'PROBE_KNOWN_GAP_EVIDENCE')).toEqual([]);
    expect(checkEvidenceRefs(REDUNDANT_OBSERVATIONS, 'PROBE_REDUNDANT_EVIDENCE')).toEqual([]);
    // 原审定的 41 项（survey360#1～#3、qualification#1～#5、idp#1～#2）在 F-075（DEC-369）去掉冗余调用并从账本删除；
    // #125 新增的套卷模板 / 报告模板入口 18 项（survey360.allActivities#4）在 F-075b（DEC-373①）去掉并从账本删除
    expect(REDUNDANT_OBSERVATIONS.map((g) => g.id)).toEqual([]);
    expect(REDUNDANT_OBSERVATIONS.flatMap((g) => g.pairs)).toHaveLength(0);
  });
});
