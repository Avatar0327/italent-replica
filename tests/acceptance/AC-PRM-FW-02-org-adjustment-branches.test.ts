/**
 * F-039 BE-11c-b 第 5 轮 P2-3：POST /org-adjustment/adjustments/:id/items/:section/:itemId/rebase 是 section 两分支。
 *  - section = org：只走明细对象按钮 EditOrgApprovalDetail@list_row（组织行授权），不判来源员工 / 联动；
 *  - section = transfer：主对象按钮 EditAdjustOrgDetailBtn@detail + 来源员工守卫 transfer.source + 联动守卫
 *    employment.linkage（routes.ts rebaseTransferRoute → saveRow）。
 * 两个守卫只挂在调动备选；内存里分别删掉任一备选，checkRoute 必须报发现（用真实声明 × 真实必需项表 × 冻结基准）。
 */
import { type ManifestRoute, routeManifest, type RoutePolicy } from '@italent/api';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { ObservedRoute } from './support/route-policy/contract.js';
import { declaredPerms } from './support/route-policy/perms.js';
import { checkRoute } from './support/route-policy/required.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import { tenantApi } from './support/tenant-api.js';

const KEY = 'POST /api/tenant/org-adjustment/adjustments/:id/items/:section/:itemId/rebase';
const GUARDS = ['guard:transfer.source', 'guard:employment.linkage'];
const ORG_BUTTON = 'EditOrgApprovalDetail@list_row';
const TRANSFER_BUTTON = 'EditAdjustOrgDetailBtn@detail';

let handle: Awaited<ReturnType<typeof createTestDb>>;
let real: ManifestRoute;
let observed: ObservedRoute | undefined;

beforeAll(async () => {
  handle = await createTestDb();
  const manifest = routeManifest(tenantApi(handle.db, { authorize: undefined }).app);
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === KEY);
  if (!found) throw new Error(`没有声明 ${KEY}`);
  real = found;
  const frozen = readFrozenContract();
  if (!frozen) throw new Error('冻结基准不存在：先跑 AC-PRM-FW-02.test.ts 生成');
  observed = frozen.routes[KEY];
}, 300_000);
afterAll(async () => handle?.close());

type Node = RoutePolicy & { of?: readonly RoutePolicy[]; kind: string };
/** 路由声明是 all([主对象节点, any([组织按钮, 调动按钮])])：any 是按 section 分支的两个备选。 */
const root = (route: ManifestRoute) => route.policy as Node;
const anyNode = (): Node => {
  const found = root(real).of?.find((n) => (n as Node).kind === 'any') as Node | undefined;
  if (!found?.of || found.of.length !== 2) throw new Error('声明应是 all([主对象, any([组织按钮, 调动按钮])])');
  return found;
};
/** 把 any 节点换成给定的备选（单个备选直接替换）。 */
const withBranch = (replacement: RoutePolicy): RoutePolicy => ({
  ...root(real),
  of: root(real).of!.map((n) => ((n as Node).kind === 'any' ? replacement : n)),
});
const check = (policy: RoutePolicy) =>
  checkRoute(KEY, REQUIRED[KEY]!, { ...real, policy }, observed).map((f) => `${f.code}: ${f.detail}`);
const permsOf = (policy: RoutePolicy) => declaredPerms(policy).alternatives.map((alt) => [...alt.keys()]);

describe('AC-PRM-FW-02 BE-11c-b 第 5 轮 P2-3：rebase 单行按 section 分支登记', () => {
  it('声明：来源员工 / 联动守卫只在调动备选，组织备选只有明细按钮', () => {
    const [org, transfer] = permsOf(real.policy) as [string[], string[]];
    expect(org.some((p) => p.endsWith(ORG_BUTTON))).toBe(true);
    for (const guard of GUARDS) expect(org, `组织备选不带 ${guard}`).not.toContain(guard);
    expect(transfer.some((p) => p.endsWith(TRANSFER_BUTTON))).toBe(true);
    for (const guard of GUARDS) expect(transfer, `调动备选带 ${guard}`).toContain(guard);
  });

  it('真实声明零发现', () => {
    expect(check(real.policy)).toEqual([]);
  });

  it('删掉调动备选：checkRoute 必须报发现（缺调动按钮与来源 / 联动守卫的整条分支）', () => {
    const [org] = anyNode().of!;
    const findings = check(withBranch(org!));
    expect(findings.length, findings.join('\n')).toBeGreaterThan(0);
    expect(findings.join('\n')).toMatch(/section:transfer|EditAdjustOrgDetailBtn|transfer\.source/);
  });

  it('删掉组织备选：checkRoute 必须报发现（section:org 的组织行按钮无人满足）', () => {
    const [, transfer] = anyNode().of!;
    const findings = check(withBranch(transfer!));
    expect(findings.length, findings.join('\n')).toBeGreaterThan(0);
    expect(findings.join('\n')).toMatch(/section:org|EditOrgApprovalDetail/);
  });

  it('调动备选少一个守卫：必须报发现，且指向缺失守卫（守卫没有被组织备选的按钮掩盖）', () => {
    const [org, transfer] = anyNode().of!;
    expect(permsOf(transfer!).flat()).toEqual(expect.arrayContaining(GUARDS));
    const { guards: _dropped, ...stripped } = transfer as Node & { guards?: unknown };
    const findings = check(withBranch({ ...anyNode(), of: [org!, stripped as RoutePolicy] } as RoutePolicy));
    expect(findings.join('\n')).toMatch(/guard:transfer\.source|guard:employment\.linkage|section:transfer/);
  });
});
