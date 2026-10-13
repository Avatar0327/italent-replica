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
