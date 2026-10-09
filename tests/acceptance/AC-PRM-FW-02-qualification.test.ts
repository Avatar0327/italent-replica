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
import type { Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { declaredPerms } from './support/route-policy/perms.js';
import { KNOWN_GAPS } from './support/route-policy/probe-known-gaps.js';
import { checkRequired } from './support/route-policy/required.js';
import { INNER_CONDITIONS } from './support/route-policy/required/guard-inner.js';
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
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
const check = (routes: readonly ManifestRoute[], table: RequiredTable = REQUIRED) =>
  checkRequired(table, frozen, routes);
const entry = (key: string): readonly Obligation[] => REQUIRED[key] ?? [];
const withEntry = (key: string, obligations: readonly Obligation[]): RequiredTable => ({
  ...REQUIRED,
  [key]: obligations,
});
const inners = (key: string, carrier: string) => entry(key).filter((o) => o.purpose === `guard:${carrier}`);

/** 类别 / 级别写入口：POST、PATCH、导入（都经 writeContext 解析岗职务）。 */
const JOB_ROUTES = {
  category: [`POST ${BASE}/categories`, `PATCH ${BASE}/categories/:id`, `POST ${BASE}/categories/import`],
  level: [`POST ${BASE}/levels`, `PATCH ${BASE}/levels/:id`, `POST ${BASE}/levels/import`],
} as const;
/** 关联类型 → 岗职务对象查看权（config-service JOB_KINDS × module-route-access JOB_OBJECT_CODES）。 */
const JOB_VIEWS = {
  category: [
    ['position', 'obj:TenantBase.Position:view'],
    ['post', 'obj:TenantBase.JobPost:view'],
    ['sequence', 'obj:TenantBase.JobSequence:view'],
    ['level_type', 'obj:TenantBase.JobLevelType:view'],
  ],
  level: [
    ['level', 'obj:TenantBase.JobLevel:view'],
    ['grade', 'obj:TenantBase.JobGrade:view'],
  ],
} as const;
const CONFLICT_VIEW = {
  category: 'obj:Qualification.EmploymentCategory:view',
  level: 'obj:Qualification.EmploymentLevel:view',
} as const;

describe('AC-PRM-FW-02 F-074 已知缺口账本：qualification 的 9 项精确删除，其余账不动', () => {
  it('账本里不再有 qualification 组，也不再含这 9 对；org 与 idp 两类不变', () => {
    expect(KNOWN_GAPS.filter((g) => g.id.startsWith('qualification'))).toEqual([]);
    const pairs = KNOWN_GAPS.flatMap((g) => g.pairs.map(([r, k]) => `${r} ${k}`));
    for (const key of [
      'DELETE /api/tenant/qualification/grade-schemes/:id obj:Qualification.Target:view',
      'PATCH /api/tenant/qualification/categories/:id obj:Qualification.EmploymentCategory:view',
      'PATCH /api/tenant/qualification/levels/:id obj:Qualification.EmploymentLevel:view',
      'PATCH /api/tenant/qualification/categories/:id obj:TenantBase.JobPost:view',
      'PATCH /api/tenant/qualification/levels/:id obj:TenantBase.JobGrade:view',
    ]) {
      expect(pairs, key).not.toContain(key);
    }
    expect(pairs.filter((p) => p.includes('/qualification/'))).toEqual([]);
    expect(KNOWN_GAPS.filter((g) => g.id.startsWith('org')).flatMap((g) => g.pairs)).toHaveLength(1);
    expect(KNOWN_GAPS.filter((g) => g.id.startsWith('idp')).flatMap((g) => g.pairs)).toHaveLength(28);
  });
});

describe('AC-PRM-FW-02 F-074 级联删除范围守卫：DELETE 等级方案 × 指标查看权', () => {
  const key = `DELETE ${BASE}/grade-schemes/:id`;

  it('guard:ql.childScope(target) 的内部义务：指标查看权，仅方案上遗留手改描述时才判（when）', () => {
    const found = inners(key, 'ql.childScope(target)');
    expect(found.map((o) => o.perm)).toEqual(['obj:Qualification.Target:view']);
    expect(found[0]?.inner).toEqual({ role: 'when', condition: 'scheme.leftovers' });
    expect(INNER_CONDITIONS['scheme.leftovers']).toMatch(/遗留/);
    expect(JSON.stringify(route(key).policy)).toContain('ql.childScope(target)');
  });

  it('反例：内部条件写成未登记的名字 → GUARD_INNER_CONDITION_UNREGISTERED', () => {
    const wrong = entry(key).map((o) =>
      o.purpose === 'guard:ql.childScope(target)'
        ? { ...o, inner: { role: 'when' as const, condition: '虚构条件' } }
        : o,
    );
    expect(codes(check([route(key)], withEntry(key, wrong)))).toContain('GUARD_INNER_CONDITION_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 F-074 条件引用准入：类别 / 级别写入口 × 岗职务查看权（6 项）', () => {
  it('POST / PATCH / 导入：ql.jobLinks 的内部义务按关联类型逐个登记为 when，条件语义已登记', () => {
    for (const object of ['category', 'level'] as const) {
      for (const key of JOB_ROUTES[object]) {
        const found = inners(key, `ql.jobLinks(${object})`);
        const expected = JOB_VIEWS[object].map(([type, perm]) => [perm, `jobLinkType=${type}`]);
        expect(
          found.map((o) => [o.perm, o.inner && 'condition' in o.inner ? o.inner.condition : '']),
          key,
        ).toEqual(expected);
        for (const o of found) expect(o.inner?.role, `${key} ${o.perm}`).toBe('when');
      }
    }
    for (const [type] of [...JOB_VIEWS.category, ...JOB_VIEWS.level]) {
      const text = INNER_CONDITIONS[`jobLinkType=${type}`];
      expect(text, type).toBeDefined();
      // 空数组、保持原类型的已有关联、改类型清空：三种语义都要写明
      expect(text).toMatch(/空/);
      expect(text).toMatch(/已有/);
    }
  });

  it('反例：内部条件写成未登记的名字 → GUARD_INNER_CONDITION_UNREGISTERED', () => {
    const key = `PATCH ${BASE}/categories/:id`;
    const wrong = entry(key).map((o) =>
      o.purpose === 'guard:ql.jobLinks(category)'
        ? { ...o, inner: { role: 'when' as const, condition: '虚构条件' } }
        : o,
    );
    expect(codes(check([route(key)], withEntry(key, wrong)))).toContain('GUARD_INNER_CONDITION_UNREGISTERED');
  });
});

describe('AC-PRM-FW-02 F-074 冲突名称披露：类别 / 级别写入口 × 本对象查看权（2 项）', () => {
  it('POST / PATCH / 导入：disclosure:conflictName（need ql.openRead），声明里有同名 optional 分支', () => {
    for (const object of ['category', 'level'] as const) {
      for (const key of JOB_ROUTES[object]) {
        const found = entry(key).filter((o) => o.purpose === 'disclosure:conflictName');
        expect(
          found.map((o) => o.perm),
          key,
        ).toEqual([CONFLICT_VIEW[object]]);
        expect(found[0]?.need, key).toEqual({
          scope: 'list',
          predicate: `ql.openRead(ql_${object === 'category' ? 'categories' : 'levels'})`,
        });
        expect(declaredPerms(route(key).policy).optional.has('conflictName'), key).toBe(true);
      }
    }
  });

  it('只在会解析岗职务的写入口：列表 / 详情 / 删除不带这个分支', () => {
    for (const key of [
      `GET ${BASE}/categories`,
      `GET ${BASE}/categories/:id`,
      `DELETE ${BASE}/categories/:id`,
      `GET ${BASE}/levels`,
      `GET ${BASE}/levels/:id`,
      `DELETE ${BASE}/levels/:id`,
    ]) {
      expect(declaredPerms(route(key).policy).optional.has('conflictName'), key).toBe(false);
    }
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
    const ql = manifest.declared.filter((r) => r.path.startsWith(BASE));
    expect(ql.length).toBeGreaterThan(40);
    const findings = check(ql);
    expect(findings, show(findings)).toEqual([]);
  });
});
