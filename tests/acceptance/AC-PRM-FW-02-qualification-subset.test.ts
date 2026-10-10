/**
 * AC-PRM-FW-02（续，R3-T02 C1-1 第 1 轮 P2-3）：任职资格子集策略的 F-039 登记。
 * 通用钩子证据（runSubsetSavePolicy / runSubsetRequestPolicy）只证明“钩子被调用”，qualification 策略里的拦截被删掉时它仍然成立。
 * 本文件锁住三件事：
 *   1. 守卫内部义务：HR 新增 / 更换引用的 PATCH 向授权器问类别 / 级别的对象查看权，登记为 `personnel.subsetPolicy` 的内部 when 义务，
 *      条件（人工来源 + 新引用 + 规范化后才算变化）写进 INNER_CONDITIONS；不进已知缺口账本；
 *   2. 有效载荷授权轨迹：真实请求在各种载荷下问到的 `Qualification.*` 查看权，与登记的内部义务一一对应（不多不少）；
 *   3. 证据链：注册关系（登记函数 + 策略常量）与四道拦截（申请准入、落地自助拦截、SW74 锁、引用检查）各自带锚点，删除任何一道
 *      都让证据校验报错。
 */
import { type ManifestRoute, routeManifest, type RouteManifest } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { subsetScene } from './AC-QL-subset-support.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { type SourceReader, checkEvidence, checkStored, repoSource } from './support/route-policy/evidence.js';
import { gateEvidence } from './support/route-policy/evidence-gate.js';
import { KNOWN_GAPS } from './support/route-policy/probe-known-gaps.js';
import { checkRequired } from './support/route-policy/required.js';
import { INNER_CONDITIONS } from './support/route-policy/required/guard-inner.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

let manifest: RouteManifest;
let frozen: ObservedContract;

beforeAll(() => {
  manifest = routeManifest(tenantApi(database().db, { authorize: undefined }).app);
  const stored = readFrozenContract();
  if (!stored) throw new Error('冻结基准不存在：先跑 AC-PRM-FW-02.test.ts 生成');
  frozen = stored;
});

const SUBSETS = '/api/tenant/personnel/employees/:employeeId/subsets/:kind';
const POST_KEY = `POST ${SUBSETS}`;
const PATCH_KEY = `PATCH ${SUBSETS}/:id`;
const DELETE_KEY = `DELETE ${SUBSETS}/:id`;
const REQUEST_KEY = 'POST /api/tenant/personnel/change-requests';
const RESUBMIT_KEY = 'POST /api/tenant/approval/instances/:id/resubmit';
const CARRIER = 'personnel.subsetPolicy';

const entry = (key: string): readonly Obligation[] => REQUIRED[key] ?? [];
const inners = (key: string) => entry(key).filter((o) => o.purpose === `guard:${CARRIER}`);
const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code);
const route = (key: string): ManifestRoute => {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
};
const withEntry = (key: string, obligations: readonly Obligation[]): RequiredTable => ({
  ...REQUIRED,
  [key]: obligations,
});

const CATEGORY = 'Qualification.EmploymentCategory';
const LEVEL = 'Qualification.EmploymentLevel';

describe('AC-PRM-FW-02 C1-1 P2-3 守卫内部义务：qualification 的新引用校验 × 类别 / 级别查看权', () => {
  it('POST 新增、PATCH 更换引用：personnel.subsetPolicy 登记两条内部 when 义务；DELETE 不产生', () => {
    for (const key of [POST_KEY, PATCH_KEY]) {
      const found = inners(key);
      expect(
        found.map((o) => [o.perm, o.inner && 'condition' in o.inner ? o.inner.condition : '']),
        key,
      ).toEqual([
        [`obj:${CATEGORY}:view`, 'qualification.newCategoryRef'],
        [`obj:${LEVEL}:view`, 'qualification.newLevelRef'],
      ]);
      for (const o of found) expect(o.inner?.role, `${key} ${o.perm}`).toBe('when');
    }
    expect(inners(DELETE_KEY)).toEqual([]);
  });

  it('条件语义已登记：人工来源 + 新引用 + 规范化后才算变化；只改日期、同一 UUID 大小写不同、删除不判', () => {
    for (const name of ['qualification.newCategoryRef', 'qualification.newLevelRef']) {
      const text = INNER_CONDITIONS[name];
      expect(text, name).toBeDefined();
      for (const word of ['人工来源', '新引用', '规范化', '只改日期', '大小写', '删除']) {
        expect(text, `${name} 缺“${word}”`).toContain(word);
      }
    }
  });

  it('反例：内部条件写成未登记的名字 → GUARD_INNER_CONDITION_UNREGISTERED', () => {
    const wrong = entry(PATCH_KEY).map((o) =>
      o.purpose === `guard:${CARRIER}` ? { ...o, inner: { role: 'when' as const, condition: '虚构条件' } } : o,
    );
    const found = checkRequired(withEntry(PATCH_KEY, wrong), frozen, [route(PATCH_KEY)]);
    expect(codes(found)).toContain('GUARD_INNER_CONDITION_UNREGISTERED');
  });

  it('不进已知缺口账本（这些是登记的义务，不是缺口）', () => {
    const pairs = KNOWN_GAPS.flatMap((g) => g.pairs.map(([r, k]) => `${r} ${k}`));
    expect(
      pairs.filter((p) => p.includes('personnel/employees/:employeeId/subsets') && p.includes('Qualification.')),
    ).toEqual([]);
    expect(KNOWN_GAPS.filter((g) => g.id.includes('qualification-subset'))).toEqual([]);
  });

  it('真实声明 × 真实表对这几个端点零发现', () => {
    const routes = [POST_KEY, PATCH_KEY, DELETE_KEY, REQUEST_KEY].map(route);
    const findings = checkRequired(REQUIRED, frozen, routes);
    expect(findings.map((f) => `${f.route} ${f.code}: ${f.detail}`)).toEqual([]);
  });
});

describe('AC-PRM-FW-02 C1-1 P2-3 有效载荷授权轨迹：真实请求问到的 Qualification 查看权 = 登记的内部义务', () => {
  const declared = (key: string) => inners(key).map((o) => o.perm.replace(/^obj:/, '').replace(/:view$/, ''));

  async function traceWorld() {
    const scene = await subsetScene(database, 'fw-trace');
    const asked: string[] = [];
    const recorder = tenantApi(scene.w.db, {
      clock: scene.w.clock,
      authorize: ((request: { action: string; resource?: string }) => {
        if (request.action === 'object.view' && request.resource?.startsWith('Qualification.')) {
          asked.push(request.resource);
        }
        return true;
      }) as never,
    });
    const send = (method: string, path: string, body?: unknown, ifMatch = 0) =>
      recorder.request(method, path, { user: scene.w.hr.id, tenant: scene.w.tenant.id, ifMatch, body });
    /** 执行一次请求，返回这次请求问到的 Qualification.* 查看权（去重排序）。 */
    const trace = async (run: () => Promise<Response>, status: number) => {
      asked.length = 0;
      const response = await run();
      expect(response.status, await response.clone().text()).toBe(status);
      return [...new Set(asked)].sort();
    };
    return { ...scene, send, trace };
  }

  it('POST 新增：新类别 + 新级别都问；PATCH 只改日期不问；换类别只问类别；换级别只问级别；原样带回大写同一 UUID 不问；DELETE 不问', async () => {
    const f = await traceWorld();
    const { path, catalog } = f;
    const post = () =>
      f.send('POST', path, { categoryId: catalog.category.id, levelId: catalog.level.id, startDate: '2026-01-01' });
    let created!: { id: string };
    expect(
      await f.trace(async () => {
        const response = await post();
        created = (await response.clone().json()) as { id: string };
        return response;
      }, 201),
    ).toEqual([CATEGORY, LEVEL]);
    const patch = (body: Record<string, unknown>, revision: number) =>
      f.send('PATCH', `${path}/${created.id}`, body, revision);
    expect(await f.trace(() => patch({ endDate: '2027-01-01' }, 1), 200)).toEqual([]);
    expect(await f.trace(() => patch({ categoryId: catalog.otherCategory.id }, 2), 200)).toEqual([CATEGORY]);
    expect(await f.trace(() => patch({ levelId: catalog.otherLevel.id }, 3), 200)).toEqual([LEVEL]);
    expect(
      await f.trace(
        () =>
          patch(
            { categoryId: catalog.otherCategory.id.toUpperCase(), levelId: catalog.otherLevel.id.toUpperCase() },
            4,
          ),
        200,
      ),
    ).toEqual([]);
    expect(await f.trace(() => f.send('DELETE', `${path}/${created.id}`, undefined, 5), 200)).toEqual([]);
  });

  it('问到的每一项都在登记里（不多）；登记的每一项在上面的载荷下都被问到过（不少）', () => {
    expect(declared(POST_KEY).sort()).toEqual([CATEGORY, LEVEL]);
    expect(declared(PATCH_KEY).sort()).toEqual([CATEGORY, LEVEL]);
    expect(declared(DELETE_KEY)).toEqual([]);
  });
});

describe('AC-PRM-FW-02 C1-1 P2-3 证据链：注册关系与四道拦截各自带锚点，删除任何一道都报错', () => {
  const POLICY_FILE = 'apps/api/src/modules/qualification/subset-policy.ts';

  /** 在策略文件里把 `from` 换成 `to`；其他文件原样。 */
  function patched(from: string | RegExp, to: string): SourceReader {
    return (file) => {
      const text = repoSource(file);
      if (file !== POLICY_FILE) return text;
      const next = text.replace(from, to);
      expect(next, `${String(from)} 应当在策略文件里`).not.toBe(text);
      return next;
    };
  }
  const KINDS = ['EVIDENCE_ANCHOR', 'EVIDENCE_STALE', 'EVIDENCE_UNIT'];
  const found = (read: SourceReader) => checkEvidence(REQUIRED, { read }).filter((f) => KINDS.includes(f.code));
  const routesOf = (read: SourceReader) => new Set(found(read).map((f) => f.route));

  it('基线：真实源码零发现', () => {
    const drift = checkStored(REQUIRED, { read: repoSource }).filter((f) => KINDS.includes(f.code));
    expect(gateEvidence(drift, '任职资格子集证据')).toEqual([]);
  });

  it('删掉申请准入的自助拦截 → 首次提交与同单重提两处证据报错', () => {
    const routes = routesOf(
      patched(/(qualificationBeforeRequest\(\): Promise<void> \{\s*)throw SELF_SERVICE_CLOSED\(\);/, '$1'),
    );
    expect(routes.has(REQUEST_KEY)).toBe(true);
    expect(routes.has(RESUBMIT_KEY)).toBe(true);
  });

  it('删掉落地前复核里的自助拦截 → HR 写入口（POST / PATCH / DELETE）证据报错', () => {
    const routes = routesOf(patched("if (source.type === 'self_service') throw SELF_SERVICE_CLOSED();", ''));
    for (const key of [POST_KEY, PATCH_KEY, DELETE_KEY]) expect(routes.has(key), key).toBe(true);
  });

  it('删掉 SW74 锁 → HR 写入口证据报错', () => {
    const routes = routesOf(
      patched('if (human && before?.isAutoSync === true) await assertAutoSyncEditable(tx, ctx);', ''),
    );
    for (const key of [POST_KEY, PATCH_KEY, DELETE_KEY]) expect(routes.has(key), key).toBe(true);
  });

  it('删掉新引用校验 → HR 写入口与两条内部义务的证据报错', () => {
    const routes = routesOf(patched('if (human) await assertRefs(tx, ctx, newRefs(before, row));', ''));
    expect(routes.has(POST_KEY)).toBe(true);
    expect(routes.has(PATCH_KEY)).toBe(true);
  });

  it('删掉登记关系（登记函数里的 registerSubsetPolicy 或策略常量里的回调）→ 证据报错', () => {
    expect(found(patched("registerSubsetPolicy('qualification', QUALIFICATION_POLICY);", '')).length).toBeGreaterThan(
      0,
    );
    expect(
      found(patched('beforeRequest: qualificationBeforeRequest,', 'beforeRequest: undefined,')).length,
    ).toBeGreaterThan(0);
  });
});
