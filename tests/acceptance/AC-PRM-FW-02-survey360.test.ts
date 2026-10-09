/**
 * AC-PRM-FW-02（续，F-073：F-039 survey360 组补表 / 声明，#163 已知缺口账本里 survey360 的 87 项）：
 * 全允许探测在 survey360 管理端问到的 `obj:Survey360.Activity:view` / `btn:Survey360.Activity#viewAll@list`
 * 是 allActivities（360 系统管理员，context.ts allActivitiesOf）的判定，它决定活动 / 人员**可见范围的广度**，
 * 会让结果变成 404 / 403 或整体放宽，所以**按实际用途分别登记**，不整体放进 optional：
 *   - 活动资源守卫（requireActivity 的内部“或”：全部活动 或 本人创建 / 被授权）：36 个 `/activities/:id…` 端点，
 *     承载者 guard:survey360.activityScope；
 *   - 人员资源守卫（visiblePerson：全部活动 或 精细化关闭 或 人员在范围内）：GET / PUT /people/:id，承载者 personVisible；
 *   - 精细化条件守卫（requireUnrestricted / requireCreatable：全部活动 或 精细化关闭）：关联日志、同步冲突清单与处理（承载者
 *     unrestricted）、新建人员（承载者 personCreatable）；
 *   - 列表范围披露 / 写范围与披露（只决定响应范围的广度，不拒绝请求）：GET /activities、GET /people、POST /people/sync，
 *     optional.allActivities 披露分支。
 * 每补一项，从已知缺口账本删掉对应的“端点 × 请求键”（精确集合）；冗余观测账本不动。零行为变化。
 */
import { type ManifestRoute, routeManifest, type RouteManifest } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { checkEvidence } from './support/route-policy/evidence.js';
import { declaredPerms } from './support/route-policy/perms.js';
import { KNOWN_GAPS } from './support/route-policy/probe-known-gaps.js';
import { REDUNDANT_OBSERVATIONS } from './support/route-policy/probe-redundant.js';
import { checkRequired } from './support/route-policy/required.js';
import { GUARD_INNER_ALTS } from './support/route-policy/required/guard-inner.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';
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

const BASE = '/api/tenant/survey360';
const VIEW = 'obj:Survey360.Activity:view';
const VIEW_ALL = 'btn:Survey360.Activity#viewAll@list';
const route = (key: string): ManifestRoute => {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
};
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
const check = (routes: readonly ManifestRoute[], table: RequiredTable = REQUIRED) =>
  checkRequired(table, frozen, routes);
const entry = (key: string): readonly Obligation[] => REQUIRED[key] ?? [];
const withEntry = (key: string, obligations: readonly Obligation[]): RequiredTable => ({
  ...REQUIRED,
  [key]: obligations,
});
const inners = (key: string, carrier: string) => entry(key).filter((o) => o.purpose === `guard:${carrier}`);

const ACTIVITY_ENDPOINTS = () =>
  manifest.declared
    .map((r) => `${r.method} ${r.path}`)
    .filter((k) => k.split(' ')[1]!.startsWith(`${BASE}/activities/:id`))
    .sort();

describe('AC-PRM-FW-02 F-073 已知缺口账本：survey360 的 87 项精确删除，其余账不动', () => {
  it('账本里不再有 survey360 组；org / idp 两类共 29 项（任职资格已由 F-074 补完）与冗余观测 59 项不变', () => {
    expect(KNOWN_GAPS.filter((g) => g.id.startsWith('survey360'))).toEqual([]);
    expect(KNOWN_GAPS.flatMap((g) => g.pairs)).toHaveLength(29);
    expect(REDUNDANT_OBSERVATIONS.flatMap((g) => g.pairs)).toHaveLength(59);
  });
});

describe('AC-PRM-FW-02 F-073 活动资源守卫：36 个 /activities/:id… 端点（allActivities 或 本人创建 / 被授权）', () => {
  it('端点集合：36 个，全部有承载者 guard:survey360.activityScope（声明与表一致）', () => {
    const endpoints = ACTIVITY_ENDPOINTS();
    expect(endpoints).toHaveLength(36);
    for (const key of endpoints) {
      expect(
        entry(key).some((o) => o.perm === 'guard:survey360.activityScope' && !o.purpose),
        key,
      ).toBe(true);
      expect(JSON.stringify(route(key).policy), key).toContain('survey360.activityScope');
    }
  });

  it('allActivities 的两个请求登记为守卫内部“或”备选（不整体 optional）：obj 查看 + 全部活动按钮', () => {
    for (const key of ACTIVITY_ENDPOINTS()) {
      const found = inners(key, 'survey360.activityScope');
      expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
      for (const o of found) {
        expect(o.inner, `${key} ${o.perm}`).toEqual({ role: 'or', group: 'activityVisible', alt: 'allActivities' });
      }
      expect(declaredPerms(route(key).policy).optional.has('allActivities'), `${key} 不得整体 optional`).toBe(false);
    }
  });

  it('GUARD_INNER_ALTS 登记两支：allActivities（权限，含两个键）与 本人创建 / 被授权（数据态，不经授权器）', () => {
    const registered = GUARD_INNER_ALTS['survey360.activityScope'];
    expect(registered?.group).toBe('activityVisible');
    expect(registered?.alts['allActivities']).toEqual([VIEW, VIEW_ALL]);
    expect(registered?.alts['ownerOrGranted']).toBe('data:survey360.activityOwnerOrGrant');
    const synthetic: RequiredTable = Object.fromEntries(
      Object.entries(GUARD_INNER_ALTS).map(([carrier, one]) => [
        `inner ${carrier}`,
        [{ perm: `guard:${carrier}`, at: one.at }],
      ]),
    );
    expect(checkEvidence(synthetic), show(checkEvidence(synthetic))).toEqual([]);
  });

  it('反例：删声明里的承载者守卫 → REQUIRED_MISSING；把 inner 的备选改成数据态 ownerOrGranted → GUARD_INNER_ALT_UNREGISTERED', () => {
    const key = `DELETE ${BASE}/activities/:id`;
    const base = route(key);
    const stripped = JSON.parse(JSON.stringify(base.policy)) as { guards?: string[] };
    stripped.guards = (stripped.guards ?? []).filter((g) => g !== 'survey360.activityScope');
    expect(codes(check([{ ...base, policy: stripped as never }]))).toContain('REQUIRED_MISSING');
    const wrong = entry(key).map((o) =>
      o.purpose === 'guard:survey360.activityScope'
        ? { ...o, inner: { role: 'or' as const, group: 'activityVisible', alt: 'ownerOrGranted' } }
        : o,
    );
    expect(codes(check([base], withEntry(key, wrong)))).toContain('GUARD_INNER_ALT_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 F-073 人员 / 列表用途分别登记', () => {
  it('人员资源守卫：GET / PUT /people/:id → personVisible，内部“或”：全部活动 / 精细化关闭 / 人员在范围内', () => {
    for (const key of [`GET ${BASE}/people/:id`, `PUT ${BASE}/people/:id`]) {
      const found = inners(key, 'survey360.personVisible');
      expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
      for (const o of found) expect(o.inner).toEqual({ role: 'or', group: 'personVisible', alt: 'allActivities' });
    }
    const registered = GUARD_INNER_ALTS['survey360.personVisible'];
    expect(Object.keys(registered?.alts ?? {}).sort()).toEqual(['allActivities', 'finePermissionOff', 'personInScope']);
  });

  it('精细化条件守卫：关联日志 / 同步冲突清单 / 冲突处理 → unrestricted；新建人员 → personCreatable（全部活动 或 精细化关闭）', () => {
    for (const key of [
      `GET ${BASE}/people/:id/link-logs`,
      `GET ${BASE}/people/sync-conflicts`,
      `POST ${BASE}/people/sync-conflicts/:id/resolve`,
    ]) {
      const found = inners(key, 'survey360.unrestricted');
      expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
      for (const o of found) expect(o.inner).toEqual({ role: 'or', group: 'unrestricted', alt: 'allActivities' });
    }
    const created = inners(`POST ${BASE}/people`, 'survey360.personCreatable');
    expect(created.map((o) => o.perm).sort()).toEqual([VIEW_ALL, VIEW].sort());
    for (const carrier of ['survey360.unrestricted', 'survey360.personCreatable']) {
      expect(Object.keys(GUARD_INNER_ALTS[carrier]?.alts ?? {}).sort(), carrier).toEqual([
        'allActivities',
        'finePermissionOff',
      ]);
    }
  });

  it('列表范围披露 / 写范围与披露：GET /activities、GET /people、POST /people/sync → disclosure:allActivities（两个键，need none）', () => {
    for (const key of [`GET ${BASE}/activities`, `GET ${BASE}/people`, `POST ${BASE}/people/sync`]) {
      const found = entry(key).filter((o) => o.purpose === 'disclosure:allActivities');
      expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
      for (const o of found) expect(o.need, `${key} ${o.perm}`).toEqual({ scope: 'none' });
      expect(declaredPerms(route(key).policy).optional.has('allActivities'), key).toBe(true);
    }
  });

  it('反例：列表披露分支被删 → DISCLOSURE_MISSING；any([披露, 普通成员]) → DISCLOSURE_WEAK', () => {
    const key = `GET ${BASE}/people`;
    const base = route(key);
    const policy = JSON.parse(JSON.stringify(base.policy)) as { optional?: Record<string, unknown> };
    const { allActivities: branch, ...rest } = policy.optional ?? {};
    expect(branch).toBeDefined();
    expect(codes(check([{ ...base, policy: { ...policy, optional: rest } as never }]))).toContain('DISCLOSURE_MISSING');
    const member = { kind: 'member', reason: '夹具', fields: { mode: 'none', reason: '夹具' } };
    const weak = { ...policy, optional: { allActivities: { kind: 'any', of: [branch, member] } } };
    expect(codes(check([{ ...base, policy: weak as never }]))).toContain('DISCLOSURE_WEAK');
  });

  it('真实声明 × 真实表零发现', () => {
    const survey = manifest.declared.filter((r) => r.path.startsWith(BASE));
    expect(survey.length).toBeGreaterThan(40);
    const findings = check(survey);
    expect(findings, show(findings)).toEqual([]);
  });
});
