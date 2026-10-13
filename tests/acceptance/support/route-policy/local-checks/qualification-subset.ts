import { type Obligation } from '../required/types.js';
import { expect } from 'vitest';
import { INNER_CONDITIONS } from '../required/guard-inner.js';
import { KNOWN_GAPS } from '../probe-known-gaps.js';
import { type ManifestRoute } from '@italent/api';
import { registrationGate } from '../registration.js';
import { checkRequired } from '../required.js';
import { type SourceReader, repoSource, checkStored } from '../evidence.js';
import { checkDetectorEvidence, subsetChainFixture } from '../detector-fixtures.js';
import { evaluateLocal, type LocalCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function qualificationSubsetChecks(context: LocalCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };
  const frozen = context.contract;

  const SUBSETS = '/api/tenant/personnel/employees/:employeeId/subsets/:kind';
  const POST_KEY = `POST ${SUBSETS}`;
  const PATCH_KEY = `PATCH ${SUBSETS}/:id`;
  const DELETE_KEY = `DELETE ${SUBSETS}/:id`;
  const REQUEST_KEY = 'POST /api/tenant/personnel/change-requests';
  const RESUBMIT_KEY = 'POST /api/tenant/approval/instances/:id/resubmit';
  const CARRIER = 'personnel.subsetPolicy';
  const entry = (key: string): readonly Obligation[] => REQUIRED[key] ?? [];
  const inners = (key: string) => entry(key).filter((o) => o.purpose === `guard:${CARRIER}`);
  const route = (key: string): ManifestRoute => {
    const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
    if (!found) throw new Error(`没有声明 ${key}`);
    return found;
  };
  const CATEGORY = 'Qualification.EmploymentCategory';
  const LEVEL = 'Qualification.EmploymentLevel';
  return [
    {
      id: 'newReferences',
      label: 'POST 新增、PATCH 更换引用：personnel.subsetPolicy 登记两条内部 when 义务；DELETE 不产生',
      wrapped: true,
      verify: () => {
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
      },
    },
    {
      id: 'conditionSemantics',
      label: '条件语义已登记：人工来源 + 新引用 + 规范化后才算变化；只改日期、同一 UUID 大小写不同、删除不判',
      wrapped: true,
      verify: () => {
        for (const name of ['qualification.newCategoryRef', 'qualification.newLevelRef']) {
          const text = INNER_CONDITIONS[name];
          expect(text, name).toBeDefined();
          for (const word of ['人工来源', '新引用', '规范化', '只改日期', '大小写', '删除']) {
            expect(text, `${name} 缺“${word}”`).toContain(word);
          }
        }
      },
    },
    {
      id: 'knownGaps',
      label: '不进已知缺口账本（这些是登记的义务，不是缺口）',
      wrapped: true,
      verify: () => {
        const pairs = KNOWN_GAPS.flatMap((g) => g.pairs.map(([r, k]) => `${r} ${k}`));
        expect(
          pairs.filter((p) => p.includes('personnel/employees/:employeeId/subsets') && p.includes('Qualification.')),
        ).toEqual([]);
        expect(KNOWN_GAPS.filter((g) => g.id.includes('qualification-subset'))).toEqual([]);
      },
    },
    {
      id: 'declarations',
      label: '真实声明 × 真实表对这几个端点零发现',
      wrapped: false,
      verify: () => {
        const routes = [POST_KEY, PATCH_KEY, DELETE_KEY, REQUEST_KEY].map(route);
        const findings = registrationGate(
          checkRequired(REQUIRED, frozen, routes),
          '任职资格子集静态义务登记（DEC-416③）',
        );
        expect(findings.map((f) => `${f.route} ${f.code}: ${f.detail}`)).toEqual([]);
      },
    },
    {
      id: 'traces',
      label: '问到的每一项都在登记里（不多）；登记的每一项在上面的载荷下都被问到过（不少）',
      wrapped: true,
      verify: () => {
        const declared = (key: string) => inners(key).map((o) => o.perm.replace(/^obj:/, '').replace(/:view$/, ''));

        expect(declared(POST_KEY).sort()).toEqual([CATEGORY, LEVEL]);
        expect(declared(PATCH_KEY).sort()).toEqual([CATEGORY, LEVEL]);
        expect(declared(DELETE_KEY)).toEqual([]);
      },
    },
    {
      id: 'evidenceChain',
      label: '基线：真实源码零发现',
      wrapped: false,
      verify: () => {
        const KINDS = ['EVIDENCE_ANCHOR', 'EVIDENCE_STALE', 'EVIDENCE_UNIT'];
        const fixture = subsetChainFixture([POST_KEY, PATCH_KEY, DELETE_KEY], [REQUEST_KEY, RESUBMIT_KEY]);
        const found = (read: SourceReader) =>
          checkDetectorEvidence(fixture, { read }).filter((f) => KINDS.includes(f.code));

        expect(evaluateLocal(context, 'subset.fixture', () => found(repoSource))).toEqual([]);
        const drift = evaluateLocal(context, 'subset.stored', () => checkStored(REQUIRED, { read: repoSource })).filter(
          (f) => KINDS.includes(f.code),
        );
        expect(registrationGate(drift, '任职资格子集证据')).toEqual([]);
      },
    },
  ];
}
