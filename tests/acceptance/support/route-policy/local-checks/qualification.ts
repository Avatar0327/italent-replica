import { expect } from 'vitest';
import { KNOWN_GAPS } from '../probe-known-gaps.js';
import { type Obligation } from '../required/types.js';
import { INNER_CONDITIONS } from '../required/guard-inner.js';
import { type ManifestRoute } from '@italent/api';
import { declaredPerms } from '../perms.js';
import { registrationGate } from '../registration.js';
import { checkRequired } from '../required.js';
import { type Finding } from '../compare.js';
import { expectDeclared, knownGapPairIds } from '../module-declared.js';
import type { LocalCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function qualificationChecks(context: LocalCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };
  const frozen = context.contract;

  const BASE = '/api/tenant/qualification';
  const route = (key: string): ManifestRoute => {
    const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
    if (!found) throw new Error(`没有声明 ${key}`);
    return found;
  };
  const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
  const entry = (key: string): readonly Obligation[] => REQUIRED[key] ?? [];
  const inners = (key: string, carrier: string) => entry(key).filter((o) => o.purpose === `guard:${carrier}`);
  const JOB_ROUTES = {
    category: [`POST ${BASE}/categories`, `PATCH ${BASE}/categories/:id`, `POST ${BASE}/categories/import`],
    level: [`POST ${BASE}/levels`, `PATCH ${BASE}/levels/:id`, `POST ${BASE}/levels/import`],
  } as const;
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
  return [
    {
      id: 'knownGaps',
      label: '账本里不再有 qualification 组，也不再含这 9 对；其余模块的缺口对与各自声明逐项相等',
      wrapped: true,
      verify: () => {
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
        expectDeclared('已知缺口登记对', 'knownGapPairs', knownGapPairIds());
      },
    },
    {
      id: 'cascade',
      label: 'guard:ql.childScope(target) 的内部义务：指标查看权，仅方案上遗留手改描述时才判（when）',
      wrapped: true,
      verify: () => {
        const key = `DELETE ${BASE}/grade-schemes/:id`;

        const found = inners(key, 'ql.childScope(target)');
        expect(found.map((o) => o.perm)).toEqual(['obj:Qualification.Target:view']);
        expect(found[0]?.inner).toEqual({ role: 'when', condition: 'scheme.leftovers' });
        expect(INNER_CONDITIONS['scheme.leftovers']).toMatch(/遗留/);
        expect(JSON.stringify(route(key).policy)).toContain('ql.childScope(target)');
      },
    },
    {
      id: 'jobLinks',
      label: 'POST / PATCH / 导入：ql.jobLinks 的内部义务按关联类型逐个登记为 when，条件语义已登记',
      wrapped: true,
      verify: () => {
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
      },
    },
    {
      id: 'conflictNames',
      label: 'POST / PATCH / 导入：disclosure:conflictName（need ql.openRead），声明里有同名 optional 分支',
      wrapped: true,
      verify: () => {
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
      },
    },
    {
      id: 'readBranches',
      label: '只在会解析岗职务的写入口：列表 / 详情 / 删除不带这个分支',
      wrapped: true,
      verify: () => {
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
      },
    },
    {
      id: 'declarations',
      label: '真实声明 × 真实表零发现',
      wrapped: false,
      verify: () => {
        const ql = manifest.declared.filter((r) => r.path.startsWith(BASE));
        expect(ql.length).toBeGreaterThan(40);
        const findings = registrationGate(
          checkRequired(REQUIRED, frozen, ql),
          '任职资格声明 × 静态义务登记（DEC-416③）',
        );
        expect(findings, show(findings)).toEqual([]);
      },
    },
  ];
}
