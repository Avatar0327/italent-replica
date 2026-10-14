import { registrationGate, registration } from '../registration.js';
import { KNOWN_GAPS, checkKnownGapEvidence, type KnownGapGroup } from '../probe-known-gaps.js';
import { REDUNDANT_OBSERVATIONS, checkRedundantEvidence, type RedundantGroup } from '../probe-redundant.js';
import { expect } from 'vitest';
import { type Finding } from '../compare.js';
import { DISCOVERY_GAPS, DISCOVERY_FACTS, DISCOVERY_TABLE, DISCOVERY_ROUTES } from '../discovery-fixture.js';
import { checkDiscovery, checkIdApplicabilityDrift, readFrozenProbes } from '../discovery.js';
import { expectDeclared, knownGapPairIds } from '../module-declared.js';
import type { DiscoveryCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function discoveryChecks(context: DiscoveryCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };

  const fresh = context.discoveries;

  const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
  const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
  const ACCOUNT = { knownGaps: KNOWN_GAPS, redundant: REDUNDANT_OBSERVATIONS };
  const records = () => ({ discoveries: fresh, table: REQUIRED, routes: manifest.declared, accounting: ACCOUNT });
  return [
    {
      id: 'declarations',
      label: '全部端点零发现（P0 认领、P3 非法标识、映射）；未认领的请求只经精确的 KNOWN_GAPS 逐对登记',
      wrapped: false,
      verify: () => {
        const findings = registrationGate(records(), '真实发现 × 静态义务登记（DEC-416③）');
        expect(findings, show(findings)).toEqual([]);
      },
    },
    {
      id: 'accounting',
      label:
        '逐对对账：未认领的"端点 × 请求键"恰好等于两本账的登记对之并集：各模块声明的有实际用途的缺口对（DEC-475④）+ 0 项冗余观测（F-075 / F-075b 已清空冗余观测账本），互斥',
      wrapped: false,
      verify: () => {
        expect(registrationGate(records(), '实际未认领记录与两本台账的差异（DEC-416③）')).toEqual([]);
        const gaps = KNOWN_GAPS.flatMap((g) => g.pairs);
        const redundant = REDUNDANT_OBSERVATIONS.flatMap((g) => g.pairs);
        registration('已知缺口按模块声明', () => expectDeclared('已知缺口登记对', 'knownGapPairs', knownGapPairIds()));
        registration('冗余观测冻结数量', () => expect(redundant).toHaveLength(0));
        const all = [...gaps, ...redundant].map(([r, k]) => `${r}\t${k}`);
        expect(new Set(all).size, '登记对不重复，两本账互斥').toBe(all.length);
      },
    },
    {
      id: 'accountEvidence',
      label: '台账每组写明用途、归属与源码证据，证据锚点仍出现在所指文件里；冗余观测另写"为何不影响结果"',
      wrapped: false,
      verify: () => {
        for (const group of KNOWN_GAPS) {
          expect(group.owner.length, group.id).toBeGreaterThan(5);
          expect(group.purpose.length, group.id).toBeGreaterThan(1);
          expect(group.evidence.length, group.id).toBeGreaterThan(0);
        }
        for (const group of REDUNDANT_OBSERVATIONS) {
          expect(group.why.length, group.id).toBeGreaterThan(20);
          expect(group.evidence.length, group.id).toBeGreaterThan(0);
        }
        // F-090：账本证据锚点与源码对不上默认只警告
        expect(registrationGate(checkKnownGapEvidence(KNOWN_GAPS), '已知缺口账本证据锚点')).toEqual([]);
        expect(registrationGate(checkRedundantEvidence(REDUNDANT_OBSERVATIONS), '冗余观测账本证据锚点')).toEqual([]);
        const tampered: KnownGapGroup[] = [
          {
            ...DISCOVERY_GAPS[0]!,
            evidence: [{ file: 'apps/api/src/app.ts', anchor: 'thisSnippetDoesNotExistAnywhere()' }],
          },
        ];
        expect(codes(checkKnownGapEvidence(tampered))).toEqual(['PROBE_KNOWN_GAP_EVIDENCE']);
      },
    },
    {
      id: 'redundant',
      label: 'DEC-367：冗余观测只是记录——不是显式表义务，也不能豁免账外的 P0；同一对不能同时登记在两本账',
      wrapped: false,
      verify: () => {
        // 真实冗余账已清空（F-075 / F-075b 去掉了全部冗余调用）；机制用夹具验证：把第一个已知缺口对挪到冗余账里
        registration('真实冗余观测台账已清空', () => expect(REDUNDANT_OBSERVATIONS).toEqual([]));
        const [first, ...rest] = DISCOVERY_GAPS;
        const [route0, key0] = first!.pairs[0]!;
        const restPairs = first!.pairs.slice(1);
        const moved: RedundantGroup[] = [
          { id: 'fixture#1', why: 'x'.repeat(30), evidence: [], pairs: [[route0, key0]] },
        ];
        const gaps = [{ ...first!, pairs: restPairs }, ...rest];
        // 登记在冗余账里：只是记录，不再报 P0
        expect(
          codes(
            checkDiscovery(DISCOVERY_FACTS, DISCOVERY_TABLE, DISCOVERY_ROUTES, { knownGaps: gaps, redundant: moved }),
          ),
        ).toEqual([]);
        // 删掉冗余账后，这个请求立刻变成 P0（冗余账不是豁免，也不是义务）
        const withoutRedundant = checkDiscovery(DISCOVERY_FACTS, DISCOVERY_TABLE, DISCOVERY_ROUTES, {
          knownGaps: gaps,
          redundant: [],
        });
        expect(withoutRedundant.filter((f) => f.code === 'PROBE_ADMISSION_UNCLAIMED')).toHaveLength(1);
        expect(withoutRedundant.some((f) => f.route === route0 && f.detail.includes(key0))).toBe(true);
        // 同一对同时登记在两本账里 → 报重叠
        const overlap = checkDiscovery(DISCOVERY_FACTS, DISCOVERY_TABLE, DISCOVERY_ROUTES, {
          knownGaps: DISCOVERY_GAPS,
          redundant: moved,
        });
        expect(codes(overlap)).toContain('PROBE_ACCOUNT_OVERLAP');
      },
    },
    {
      id: 'invalidIds',
      label: '适用性与冻结事实零漂移（PROBE_ID_APPLICABILITY_CHANGED 为空）；非法标识没有 5xx',
      wrapped: false,
      verify: () => {
        expect(
          registrationGate(checkIdApplicabilityDrift(fresh, readFrozenProbes()), '非法标识适用性（DEC-416③）'),
        ).toEqual([]);
        expect(Object.entries(fresh).filter(([, d]) => (d.invalidId?.status ?? 0) >= 500)).toEqual([]);
      },
    },
  ];
}
