/**
 * BE-15a 第 4 轮审查 P2（#400）：立即执行回执的人员披露要单独登记。
 * 回执内容受任职记录查看权（TenantBase.EmploymentRecord:view）控制（visibleEmployees 先判 object.view，再按范围逐人过滤），
 * 所以除了配置准入，声明里要有一条任职记录 view 的可选披露分支，必需项表里要有对应的 disclosure 义务承接
 * object.view 的探测事实。缺任何一边，比较器都要判红。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { createRig } from './support/route-policy/discovery.js';
import { checkRequired } from './support/route-policy/required.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { RequiredTable } from './support/route-policy/required/types.js';

const testDb = useTestDb();
const RUN = 'POST /api/tenant/employment/auto-regularization/run';
let routes: readonly ManifestRoute[];
let contract: ObservedContract;

beforeAll(async () => {
  const { manifest } = await createRig(testDb().db);
  routes = manifest.declared;
  const stored = readFrozenContract();
  if (!stored) throw new Error('真实冻结基准不存在');
  contract = stored;
}, 600_000);

const runRoute = () => {
  const found = routes.find((r) => `${r.method} ${r.path}` === RUN);
  if (!found) throw new Error(`没有声明 ${RUN}`);
  return found;
};
const findingsOf = (table: RequiredTable, declared: readonly ManifestRoute[]) =>
  checkRequired(table, contract, declared).filter((f) => f.route === RUN);
const isDisclosure = (purpose: string | undefined) => purpose === 'disclosure:receiptDisclosure';

describe('BE-15a 立即执行回执披露的登记', () => {
  it('完整登记零发现：声明有任职记录 view 的可选披露分支，表里有对应 disclosure 义务承接 object.view 事实', () => {
    const policy = runRoute().policy as unknown as {
      optional?: Record<string, { object?: string; operation?: string }>;
    };
    expect(policy.optional?.['receiptDisclosure']).toMatchObject({
      object: 'TenantBase.EmploymentRecord',
      operation: 'view',
    });
    const disclosure = REQUIRED[RUN]!.filter((o) => isDisclosure(o.purpose));
    expect(disclosure).toEqual([
      expect.objectContaining({
        perm: 'obj:TenantBase.EmploymentRecord:view',
        need: { scope: 'list', predicate: 'employment.runReceipt' },
        facts: expect.arrayContaining(['object:object.* 动作']),
      }),
    ]);
    // object.view 的探测事实只由披露义务承接，配置 update 准入义务不再挂它
    const update = REQUIRED[RUN]!.find((o) => o.perm === 'obj:TenantBase.EmploymentSettings:update' && !o.purpose);
    expect(update?.facts ?? []).not.toContain('object:object.* 动作');
    expect(findingsOf(REQUIRED, routes)).toEqual([]);
  });

  it('必需项表漏登 disclosure 义务（撤掉任职记录 view 的披露用途）时判红', () => {
    const table: RequiredTable = { ...REQUIRED, [RUN]: REQUIRED[RUN]!.filter((o) => !isDisclosure(o.purpose)) };
    expect(findingsOf(table, routes).length).toBeGreaterThan(0);
  });

  it('声明里删掉可选披露分支时判红', () => {
    const declared = routes.map((r) => {
      if (`${r.method} ${r.path}` !== RUN) return r;
      const { optional: _optional, ...rest } = r.policy as unknown as Record<string, unknown>;
      return { ...r, policy: rest as unknown as RoutePolicy };
    });
    expect(findingsOf(REQUIRED, declared).length).toBeGreaterThan(0);
  });
});
