import { registrationGate, compareRegisteredDeclarations } from '../registration.js';
import { expect } from 'vitest';
import type { LocalCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function fw02Checks(context: LocalCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };
  const frozen = context.contract;

  return [
    {
      id: 'declarations',
      label: '真实声明不弱于基准，也不多于基准（双向零发现）',
      wrapped: false,
      verify: () => {
        // F-090：过度声明（OVERDECLARED:*）属“登记与源码不一致”，默认只警告；弱化 / 身份不符照旧判红
        const findings = registrationGate(
          compareRegisteredDeclarations(frozen, manifest.declared, undefined, REQUIRED),
          '真实声明 × 基准',
        );
        expect(findings, findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n')).toEqual([]);
      },
    },
  ];
}
