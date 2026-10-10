/**
 * 总开关打开时的能力检查（F-082 契约 §10）：新写入路径依赖的三项前置能力任一未登记，createApp 拒绝启动——
 * - items 投影：hints 服从 items 查看权的投影（calc-rule-hints.ts，F082-4）；
 * - 响应投影：GET / 写响应 / 重放按查看人渲染公式与绑定（calc-rule-present.ts，F082-3/4）；
 * - 审计裁剪：calcRuleSources 已登记（audit/source-registry.ts，F082-2）。
 * 只核对本进程内的登记，不读库，与 DEC-386 删除的“启用标记 / 基于标记的启动拒绝”无关；首次启用与回退的约束
 * 见部署前置条件（scripts/check-deploy-target.mjs）。
 */
import { CALC_RULE_AUDIT_TYPE } from '../../audit/calc-rule-sources.js';
import { auditSourceRegistered } from '../../audit/source-registry.js';

export type FormulaCapability = 'items-projection' | 'response-projection';

const REGISTERED = new Set<FormulaCapability>();

/** 提供该能力的模块在加载时登记自己。 */
export function registerFormulaCapability(name: FormulaCapability): void {
  REGISTERED.add(name);
}

export const CAPABILITY_LABELS: Readonly<Record<FormulaCapability | 'audit-redactor', string>> = {
  'items-projection': 'hints 的 items 投影',
  'response-projection': '响应 / 重放的按查看人渲染',
  'audit-redactor': '计算规则审计裁剪 calcRuleSources',
};

/** 缺少的能力（空数组 = 齐全）。两个参数只给测试用。 */
export function missingFormulaCapabilities(
  registered: ReadonlySet<string> = REGISTERED,
  auditRegistered: boolean = auditSourceRegistered(CALC_RULE_AUDIT_TYPE),
): string[] {
  const missing: string[] = [];
  for (const name of ['items-projection', 'response-projection'] as const) {
    if (!registered.has(name)) missing.push(CAPABILITY_LABELS[name]);
  }
  if (!auditRegistered) missing.push(CAPABILITY_LABELS['audit-redactor']);
  return missing;
}

export function assertFormulaBindingCapabilities(registered?: ReadonlySet<string>, auditRegistered?: boolean): void {
  const missing = missingFormulaCapabilities(registered, auditRegistered);
  if (missing.length > 0) {
    throw new Error(`formulaIdBinding 已打开，但前置能力未登记：${missing.join('、')}`);
  }
}
