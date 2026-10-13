/** DEC-460：L2 暂停审查确认缺少人口源授权的组合；完整矩阵及放开条件归 F-108。 */
import type { SuccessionLevelRow, SuccessionLevelRules } from '@italent/domain';

import { AppError } from '../../errors.js';
import { healthRuleMessages } from './health-rule-messages.js';

export function unsupportedHealthRule(row: SuccessionLevelRow): boolean {
  return row.population === 'all' && row.fieldCode === null && (row.measure === 'count' || row.measure === 'ratio');
}

export function requireSupportedHealthRules(rules: SuccessionLevelRules | null | undefined): void {
  const unsupported = rules?.rows.find(unsupportedHealthRule);
  if (unsupported)
    throw new AppError('VALIDATION_FAILED', healthRuleMessages.unsupportedCombination, {
      reason: 'HEALTH_RULE_COMBINATION_UNSUPPORTED',
      rowNo: unsupported.rowNo,
    });
}

export interface HealthLevelChange {
  readonly enabled?: boolean;
  readonly rules?: SuccessionLevelRules | null;
}

/** DEC-466：启用继承旧规则；显式 null 清空，不能被当作省略而回退到旧规则。 */
export function requireSupportedHealthChange(
  change: HealthLevelChange | undefined,
  inheritedRules?: SuccessionLevelRules | null,
): void {
  let rules = change?.rules;
  if (rules === undefined && change?.enabled === true) rules = inheritedRules;
  requireSupportedHealthRules(rules);
}
