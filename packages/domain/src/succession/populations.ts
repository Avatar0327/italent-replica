/** 人员范围字段目录：设计 §4.3 首版固定子集；路径和类型由服务端决定，不能信任客户端声明。 */
import { compileRuleSet, type RuleFieldRef, type RuleSet } from '../expression/rules/index.js';

// DEC-420 / D-077（🟡）：取测试租户当前值，未证实为北森出厂值。
export const SUCCESSION_DEFAULT_COLORS = { position_risk: '#7498FB', org_health: '#F2F3F5' } as const;
export type SuccessionRuleKind = keyof typeof SUCCESSION_DEFAULT_COLORS;

const field = (object: RuleFieldRef['object'], code: string, kind: RuleFieldRef['kind']): RuleFieldRef => ({
  object,
  code,
  kind,
  path: `${object}.${code}`,
});
export const POPULATION_FIELDS: readonly RuleFieldRef[] = [
  field('employee', 'name', 'text'),
  field('employee', 'gender', 'text'),
  field('employee', 'age', 'number'),
  field('employee', 'entry_date', 'date'),
  field('employee', 'work_years', 'number'),
  ...['org_id', 'position_id', 'job_level_id', 'job_sequence_id'].map((code) => field('employment', code, 'text')),
  field('employment', 'employee_status', 'number'),
];

export function compilePopulation(rules: RuleSet) {
  // compileRuleSet 内部统一调用 parseRowExpression，保留 rowSpans 与所有安全诊断。
  return compileRuleSet(rules, {
    resolve: (object, code) => POPULATION_FIELDS.find((item) => item.object === object && item.code === code),
  });
}
