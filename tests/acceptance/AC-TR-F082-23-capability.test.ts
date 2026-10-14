/**
 * F-082 AC-23 开关打开时的能力检查（F082-5，契约 §10）：items 投影、响应 / 重放投影、审计裁剪 calcRuleSources 任一未登记，
 * createApp 拒绝启动；开关关闭时不检查（B5 路径不依赖这些能力）。只核对本进程内的登记，不读库。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as SourceRegistry from '../../apps/api/src/audit/source-registry.js';
import { createApp } from '../../apps/api/src/app.js';
import {
  assertFormulaBindingCapabilities,
  missingFormulaCapabilities,
} from '../../apps/api/src/modules/talent-review/formula-binding-capabilities.js';

// 把“calcRuleSources 已登记”做成可切换的探针（其余登记照常）
const registry = vi.hoisted(() => ({ calcRuleRegistered: true }));
vi.mock('../../apps/api/src/audit/source-registry.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof SourceRegistry;
  const { TALENT_REVIEW_OBJECTS: objects } = await import('@italent/domain');
  return {
    ...actual,
    auditSourceRegistered: (objectType: string) =>
      actual.auditSourceRegistered(objectType) && (registry.calcRuleRegistered || objectType !== objects.calcRule.code),
  };
});

const testDb = useTestDb();

describe('AC-23 能力检查', () => {
  it('齐全时没有缺项；缺 items 投影 / 响应投影 / 审计裁剪各自被点名', () => {
    expect(missingFormulaCapabilities()).toEqual([]);
    expect(missingFormulaCapabilities(new Set(['response-projection']), true)).toEqual(['hints 的 items 投影']);
    expect(missingFormulaCapabilities(new Set(['items-projection']), true)).toEqual(['响应 / 重放的按查看人渲染']);
    expect(missingFormulaCapabilities(new Set(['items-projection', 'response-projection']), false)).toEqual([
      '计算规则审计裁剪 calcRuleSources',
    ]);
    expect(() => assertFormulaBindingCapabilities(new Set(), false)).toThrow(/items 投影.*响应.*calcRuleSources/);
  });

  it('开关打开且审计裁剪未登记 → createApp 抛错；登记后正常；开关关闭时不检查', () => {
    registry.calcRuleRegistered = false;
    try {
      expect(() => createApp({ db: testDb().db, formulaIdBinding: true })).toThrow(/calcRuleSources/);
      expect(() => createApp({ db: testDb().db })).toThrow(/calcRuleSources/); // 默认开关就是打开
      expect(() => createApp({ db: testDb().db, formulaIdBinding: false })).not.toThrow();
    } finally {
      registry.calcRuleRegistered = true;
    }
    expect(() => createApp({ db: testDb().db, formulaIdBinding: true })).not.toThrow();
  });
});
