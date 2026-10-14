import { survey360Checks } from './support/route-policy/local-checks/survey360.js';
import { registrationIt as test } from './support/route-policy/registration.js';
/**
 * AC-PRM-FW-02（续，F-073：F-039 survey360 组补表 / 声明，#163 已知缺口账本里 survey360 的 87 项）：
 * 全允许探测在 survey360 管理端问到的 `obj:Survey360.Activity:view` / `btn:Survey360.Activity#viewAll@list`
 * 是 allActivities（360 系统管理员，context.ts allActivitiesOf）的判定，它决定活动 / 人员**可见范围的广度**，
 * 会让结果变成 404 / 403 或整体放宽，所以**按实际用途分别登记**，不整体放进 optional：
 *   - 活动资源守卫（requireActivity 的内部“或”：全部活动 或 本人创建 / 被授权）：38 个 `/activities/:id…` 端点（含 F-060 的报告 PDF / 报表 PNG 下载），
 *     承载者 guard:survey360.activityScope；
 *   - 人员资源守卫（visiblePerson：全部活动 或 精细化关闭 或 人员在范围内）：GET / PUT /people/:id，承载者 personVisible；
 *   - 精细化条件守卫（requireUnrestricted / requireCreatable：全部活动 或 精细化关闭）：关联日志、同步冲突清单与处理（承载者
 *     unrestricted）、新建人员（承载者 personCreatable）；
 *   - 列表范围披露 / 写范围与披露（只决定响应范围的广度，不拒绝请求）：GET /activities、GET /people、POST /people/sync，
 *     optional.allActivities 披露分支。
 * 每补一项，从已知缺口账本删掉对应的“端点 × 请求键”（精确集合）；冗余观测账本不动。零行为变化。
 */
import { readFileSync } from 'node:fs';
import { type ManifestRoute, routeManifest, type RouteManifest } from '@italent/api';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { DETECTOR_CONTRACT, DETECTOR_REQUIRED, DETECTOR_SEMANTICS } from './support/route-policy/detector-fixtures.js';
import type { Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { checkRequired } from './support/route-policy/required.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';
import { world360 } from './AC-360-support.js';
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

const route = (key: string): ManifestRoute => {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
};
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);

const check = (routes: readonly ManifestRoute[], table: RequiredTable = DETECTOR_REQUIRED) =>
  checkRequired(table, DETECTOR_CONTRACT, routes, DETECTOR_SEMANTICS);
const fixtureEntry = (key: string): readonly Obligation[] => DETECTOR_REQUIRED[key] ?? [];

const withEntry = (key: string, obligations: readonly Obligation[]): RequiredTable => ({
  ...DETECTOR_REQUIRED,
  [key]: obligations,
});

describe('AC-PRM-FW-02 F-073 已知缺口账本：survey360 的 87 项精确删除，其余账不动', () => {
  test('账本里不再有 survey360 组；其余模块的缺口对与各自声明逐项相等（任职资格由 F-074 补完）；冗余观测账本已清空（F-075 / F-075b）', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'knownGaps')!
      .verify();
  });
});

describe('AC-PRM-FW-02 F-073 活动资源守卫：38 个 /activities/:id… 端点（allActivities 或 本人创建 / 被授权）', () => {
  it('端点集合：38 个（F-073 的 36 个 + F-060 两个下载），全部有承载者 guard:survey360.activityScope（声明与表一致）', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'activityCarrier')!
      .verify();
  });

  test('allActivities 的两个请求登记为守卫内部“或”备选（不整体 optional）：obj 查看 + 全部活动按钮', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'activityAlternatives')!
      .verify();
  });

  it('GUARD_INNER_ALTS 登记两支：allActivities（权限，含两个键）与 本人创建 / 被授权（数据态，不经授权器）', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'alternativeEvidence')!
      .verify();
  });

  it('反例：删声明里的承载者守卫 → REQUIRED_MISSING；把 inner 的备选改成数据态 ownerOrGranted → GUARD_INNER_ALT_UNREGISTERED', () => {
    const key = `DELETE ${BASE}/activities/:id`;
    const base = route(key);
    const stripped = JSON.parse(JSON.stringify(base.policy)) as { guards?: string[] };
    stripped.guards = (stripped.guards ?? []).filter((g) => g !== 'survey360.activityScope');
    expect(codes(check([{ ...base, policy: stripped as never }]))).toContain('REQUIRED_MISSING');
    const wrong = fixtureEntry(key).map((o) =>
      o.purpose === 'guard:survey360.activityScope'
        ? { ...o, inner: { role: 'or' as const, group: 'activityVisible', alt: 'ownerOrGranted' } }
        : o,
    );
    expect(codes(check([base], withEntry(key, wrong)))).toContain('GUARD_INNER_ALT_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 F-073 人员 / 列表用途分别登记', () => {
  it('人员资源守卫：GET / PUT /people/:id → personVisible，内部“或”：全部活动 / 精细化关闭 / 人员数据范围为全部 / 人员在范围内', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'personVisible')!
      .verify();
  });

  test('精细化条件守卫：关联日志 / 同步冲突清单 / 冲突处理 → unrestricted；新建人员 → personCreatable（全部活动 / 精细化关闭 / 人员数据范围为全部）', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'unrestricted')!
      .verify();
  });

  test('列表 / 写范围披露：GET /activities、GET /people、POST /people/sync → disclosure:allActivities（两个键，need none）', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'listDisclosure')!
      .verify();
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
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'declarations')!
      .verify();
  });
});

describe('AC-PRM-FW-02 F-073 第 2 轮 P2-1：三个人员守卫的内部备选补“人员数据范围为全部”（loadAdmin 的 scope.all 分支）', () => {
  test('GUARD_INNER_ALTS 三个守卫都登记 personScopeAll（数据态，不经授权器），证据指向 loadAdmin 的 scope.all 分支', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'personScopeAll')!
      .verify();
  });

  test('表里这三个守卫的内部义务（allActivities 的两个授权请求）也带 scope.all 证据（人员可见 / 受限管理员 403 / 新建人员）', () => {
    survey360Checks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'scopeEvidence')!
      .verify();
  });

  it('policy.ts 的“不受精细化限制”说明写明三个条件：全部活动、精细化关闭、人员数据范围为全部', () => {
    const text = readFileSync('apps/api/src/modules/survey360/policy.ts', 'utf8');
    const note = text.slice(text.indexOf('allActivities（360 系统管理员'), text.indexOf('const ACTIVITY_SCOPE ='));
    expect(note).toContain('scope.all');
    expect(note).toContain('人员数据范围为全部');
  });

  it('真实授权器 / 范围解析器对照：精细化开启、没有 viewAll，授“人员数据范围为全部”前后——外部人员 404 → 200、新建 403 → 201、冲突清单 403 → 200', async () => {
    const w = await world360(testDb().db, 'f073-scope-all');
    const advanced = await w.member('范围全部高级管理员');
    await w.appoint(advanced, 'advanced');
    const external = await w.person('外部人员');
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    const as = w.as(advanced);
    const create = (email: string) => as('POST', '/people', { ifMatch: 0, body: { name: '新建人员', email } });
    // 对照：没有授数据范围（缺省为空），精细化生效 → 受限
    expect((await as('GET', `/people/${external.id}`)).status).toBe(404);
    expect((await create('f073-before@example.com')).status).toBe(403);
    expect((await as('GET', '/people/sync-conflicts')).status).toBe(403);
    // 授 Survey360 的人员数据范围为全部（身份数据范围 seeAll）：不改运行时行为，只是内部“或”的第三支成立
    await w.ok(
      w.enterprise('PUT', `/profiles/${w.profiles.advanced}/data-scopes/${survey360.SURVEY360_APP}`, {
        ifMatch: 0,
        body: { targetKind: 'app', targetCode: '', seeAll: true },
      }),
    );
    expect((await as('GET', `/people/${external.id}`)).status).toBe(200);
    expect((await create('f073-after@example.com')).status).toBe(201);
    expect((await as('GET', '/people/sync-conflicts')).status).toBe(200);
  });
});
