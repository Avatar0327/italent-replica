import { expect } from 'vitest';
import { registrationDrift, registrationGate, compareRegisteredDeclarations, registration } from '../registration.js';
import { countDrift, countEndpoints, readEndpointCounts } from '../endpoint-counts.js';
import { generatedGate } from '../generated-gate.js';
import { checkStored } from '../evidence.js';
import { type Finding } from '../compare.js';
import { checkRequired } from '../required.js';
import { type ManifestRoute } from '@italent/api';
import { type RequiredTable, type Obligation } from '../required/types.js';
import { DETECTOR_REQUIRED, DETECTOR_CONTRACT, DETECTOR_SEMANTICS } from '../detector-fixtures.js';
import { evaluateLocal, type LocalCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function requiredChecks(context: LocalCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };
  const frozen = context.contract;

  const MANAGER = 'GET /api/tenant/employment/transfers/manager';
  const MODEL_IMAGE = 'GET /api/tenant/talent/criteria/:id/model-image';
  const HR_BUTTON = 'btn:TenantBase.EmploymentRecord#Transfer.Hr@detail';
  const MANAGER_BUTTON = 'btn:TenantBase.EmploymentRecord#Transfer.Manager@detail';
  function route(key: string): ManifestRoute {
    const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
    if (!found) throw new Error(`没有声明 ${key}`);
    return found;
  }

  const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
  const check = (routes: readonly ManifestRoute[], table: RequiredTable = DETECTOR_REQUIRED) =>
    checkRequired(table, DETECTOR_CONTRACT, routes, DETECTOR_SEMANTICS);
  function entry(key: string): readonly Obligation[] {
    const found = DETECTOR_REQUIRED[key];
    if (!found) throw new Error(`表里没有 ${key}`);
    return found;
  }
  return [
    {
      id: 'endpointKeys',
      label: '表键与运行时 592 个端点相等：静态漏登 / 多登默认警告（DEC-416③）',
      wrapped: false,
      verify: () => {
        const declared = manifest.declared.map((r) => `${r.method} ${r.path}`).sort();
        const registered = Object.keys(REQUIRED);
        const drift = [
          ...declared.filter((key) => !registered.includes(key)).map((key) => `${key} 静态义务表漏登`),
          ...registered.filter((key) => !declared.includes(key)).map((key) => `${key} 静态义务表多登`),
        ];
        expect(registrationDrift('静态义务表端点登记', drift)).toEqual([]);
        const counts = countDrift(countEndpoints(manifest.declared), readEndpointCounts(), { totalOnly: true });
        expect(generatedGate('端点计数（显式表）', counts)).toEqual([]);
      },
    },
    {
      id: 'storedEvidence',
      label: '全表证据校验零发现：每条义务都有强制调用点证据，锚点命中，摘要与源码一致',
      wrapped: false,
      verify: () => {
        // F-090：登记与源码不一致默认只警告；登记自身的错误仍判红；ROUTE_POLICY_EVIDENCE_STRICT=1 全部判红
        const findings = registrationGate(
          evaluateLocal(context, 'required.stored', () => checkStored(REQUIRED, { unused: true })),
          '全表证据校验',
        );
        expect(findings, show(findings)).toEqual([]);
      },
    },
    {
      id: 'declarations',
      label: '真实声明 × 真实表：零发现',
      wrapped: false,
      verify: () => {
        const findings = registrationGate(
          checkRequired(REQUIRED, frozen, manifest.declared),
          '真实声明 × 静态义务表（DEC-416③）',
        );
        expect(findings, show(findings)).toEqual([]);
      },
    },

    {
      id: 'manager',
      label: '经理入口：真实声明零发现；canApply / canViewReporting 在表里是披露义务',
      wrapped: false,
      verify: () => {
        expect(registrationGate(checkRequired(REQUIRED, frozen, [route(MANAGER)]), '经理入口静态义务登记')).toEqual([]);
        expect(check([route(MANAGER)])).toEqual([]);
        const purposes = Object.fromEntries((REQUIRED[MANAGER] ?? []).map((o) => [o.perm, o.purpose]));
        registration('经理入口 canViewReporting 用途', () =>
          expect(purposes[HR_BUTTON]).toBe('disclosure:canViewReporting'),
        );
        registration('经理入口 canApply 用途', () => expect(purposes[MANAGER_BUTTON]).toBe('disclosure:canApply'));
      },
    },
    {
      id: 'modelImage',
      label:
        '模型图：准入与 optional.canEdit 共用同一个 point 范围，零发现（按 对象 + 操作 + 用途 匹配，不按范围字符串）',
      wrapped: false,
      verify: () => {
        expect(registrationGate(checkRequired(REQUIRED, frozen, [route(MODEL_IMAGE)]), '模型图静态义务登记')).toEqual(
          [],
        );
        expect(check([route(MODEL_IMAGE)])).toEqual([]);
        const findings = registrationGate(
          compareRegisteredDeclarations(frozen, [route(MODEL_IMAGE)], undefined, REQUIRED),
          '模型图冻结基准',
        );
        expect(findings, show(findings)).toEqual([]);
        const canEdit = entry(MODEL_IMAGE).filter((o) => o.purpose === 'disclosure:canEdit');
        expect(canEdit.map((o) => o.perm)).toContain('obj:TalentCenter.TalentCriterion:update');
      },
    },
  ];
}
