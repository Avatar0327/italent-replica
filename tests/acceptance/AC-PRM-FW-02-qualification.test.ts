import { qualificationChecks } from './support/route-policy/local-checks/qualification.js';
import { registrationIt as test } from './support/route-policy/registration.js';
/**
 * AC-PRM-FW-02（续，F-074：F-039 任职资格组补表 / 声明，#163 已知缺口账本里 qualification 的 9 项）：
 * 全允许探测在任职资格写入口问到的 9 个 `obj:*:view` 逐项读源码后分三类登记（零行为变化，只补表 / 声明）：
 *   - 级联删除范围守卫（1 项）：DELETE 等级方案 → guard:ql.childScope(target) 的内部义务 `obj:Qualification.Target:view`，
 *     仅在方案上遗留手改的指标等级描述时才被判（writeContext 恒问，requireTargetsEditable 有遗留才用）；
 *   - 条件引用准入（6 项）：类别 / 级别写入口的岗职务查看权，守卫 ql.jobLinks(category|level) 的内部义务，
 *     关联类型对应的那一种才被判（jobObject：查看权为假 → 403）；
 *   - 冲突名称披露（2 项）：关联的岗职务已被别的类别 / 级别占用时，冲突提示里带出占用对象的名称，按操作人对本对象名称字段的
 *     查看权披露（replaceJobLinks；只决定提示文案，不拒绝请求）→ disclosure:conflictName。
 * 每补一项，从已知缺口账本删掉对应的“端点 × 请求键”（精确集合）；冗余观测账本不动（qualification.referencedView 的
 * 冗余项归 F-075）。
 */
import { type ManifestRoute, routeManifest, type RouteManifest } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { DETECTOR_CONTRACT, DETECTOR_REQUIRED, DETECTOR_SEMANTICS } from './support/route-policy/detector-fixtures.js';
import type { Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { checkRequired } from './support/route-policy/required.js';
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

const BASE = '/api/tenant/qualification';
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

/** 类别 / 级别写入口：POST、PATCH、导入（都经 writeContext 解析岗职务）。 */

/** 关联类型 → 岗职务对象查看权（config-service JOB_KINDS × module-route-access JOB_OBJECT_CODES）。 */

describe('AC-PRM-FW-02 F-074 已知缺口账本：qualification 的 9 项精确删除，其余账不动', () => {
  test('账本里不再有 qualification 组，也不再含这 9 对；org 与 idp 两类不变', () => {
    qualificationChecks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'knownGaps')!
      .verify();
  });
});

describe('AC-PRM-FW-02 F-074 级联删除范围守卫：DELETE 等级方案 × 指标查看权', () => {
  const key = `DELETE ${BASE}/grade-schemes/:id`;

  test('guard:ql.childScope(target) 的内部义务：指标查看权，仅方案上遗留手改描述时才判（when）', () => {
    qualificationChecks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'cascade')!
      .verify();
  });

  it('反例：内部条件写成未登记的名字 → GUARD_INNER_CONDITION_UNREGISTERED', () => {
    const wrong = fixtureEntry(key).map((o) =>
      o.purpose === 'guard:ql.childScope(target)'
        ? { ...o, inner: { role: 'when' as const, condition: '虚构条件' } }
        : o,
    );
    expect(codes(check([route(key)], withEntry(key, wrong)))).toContain('GUARD_INNER_CONDITION_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 F-074 条件引用准入：类别 / 级别写入口 × 岗职务查看权（6 项）', () => {
  test('POST / PATCH / 导入：ql.jobLinks 的内部义务按关联类型逐个登记为 when，条件语义已登记', () => {
    qualificationChecks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'jobLinks')!
      .verify();
  });

  it('反例：内部条件写成未登记的名字 → GUARD_INNER_CONDITION_UNREGISTERED', () => {
    const key = `PATCH ${BASE}/categories/:id`;
    const wrong = fixtureEntry(key).map((o) =>
      o.purpose === 'guard:ql.jobLinks(category)'
        ? { ...o, inner: { role: 'when' as const, condition: '虚构条件' } }
        : o,
    );
    expect(codes(check([route(key)], withEntry(key, wrong)))).toContain('GUARD_INNER_CONDITION_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 F-074 冲突名称披露：类别 / 级别写入口 × 本对象查看权（2 项）', () => {
  test('POST / PATCH / 导入：disclosure:conflictName（need ql.openRead），声明里有同名 optional 分支', () => {
    qualificationChecks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'conflictNames')!
      .verify();
  });

  test('只在会解析岗职务的写入口：列表 / 详情 / 删除不带这个分支', () => {
    qualificationChecks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'readBranches')!
      .verify();
  });

  it('反例：分支被删 → DISCLOSURE_MISSING；范围谓词换成别的 → DISCLOSURE_WEAK', () => {
    const key = `PATCH ${BASE}/categories/:id`;
    const base = route(key);
    const policy = JSON.parse(JSON.stringify(base.policy)) as { optional?: Record<string, unknown> };
    const { conflictName: branch, ...rest } = policy.optional ?? {};
    expect(branch).toBeDefined();
    expect(codes(check([{ ...base, policy: { ...policy, optional: rest } as never }]))).toContain('DISCLOSURE_MISSING');
    // 范围谓词换成别的：权限还在但范围不符（need 要求 ql.openRead(ql_categories)）
    const weak = {
      ...policy,
      optional: {
        conflictName: { ...(branch as object), scope: { mode: 'list', predicate: 'ql.readable(ql_categories)' } },
      },
    };
    expect(codes(check([{ ...base, policy: weak as never }]))).toContain('DISCLOSURE_WEAK');
  });

  it('真实声明 × 真实表零发现', () => {
    qualificationChecks({ table: REQUIRED, routes: manifest.declared, contract: frozen })
      .find((check) => check.id === 'declarations')!
      .verify();
  });
});
