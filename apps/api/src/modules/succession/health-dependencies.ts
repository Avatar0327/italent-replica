/** DEC-431① / DEC-455①：字段、人口、度量共用依赖计划，授权和取数不得分别猜测来源。 */
import type { SuccessionLevelRow } from '@italent/domain';
import { unsupportedHealthRule } from './health-rule-support.js';
import { CalcObjectFailure } from './calc-contract.js';

type Source = 'org' | 'incumbents' | 'successors' | 'on_duty_count' | 'green_rate' | 'review';
type Denominator = 'population' | 'successors' | 'incumbents' | 'nonempty' | null;
interface Measure {
  numerator: 'count' | 'values';
  denominator: Denominator;
}
// §4.3 八种度量：values 取过滤后非空值的平均值，count 取过滤后去重人数。
const measures = {
  green_rate: { numerator: 'values', denominator: null },
  review_result_ratio: { numerator: 'count', denominator: 'nonempty' },
  successor_count: { numerator: 'count', denominator: null },
  average: { numerator: 'values', denominator: null },
  ratio: { numerator: 'count', denominator: 'population' },
  count: { numerator: 'count', denominator: null },
  count_over_successors: { numerator: 'count', denominator: 'successors' },
  count_over_incumbents: { numerator: 'count', denominator: 'incumbents' },
} as const satisfies Record<string, Measure>;
export interface HealthDependencies {
  field: Source | null;
  population: SuccessionLevelRow['population'] | null;
  measure: Measure;
  reads: ReadonlySet<Source>;
}
function fieldSource(row: SuccessionLevelRow): Source | null {
  if (row.measure === 'green_rate') return 'green_rate';
  if (row.fieldCode === null && row.measure !== 'successor_count') return null;
  if (row.fieldSource === 'succession') return 'successors';
  if (row.fieldSource === 'review') return 'review';
  if (row.fieldCode === 'person_in_charge_id') return 'incumbents';
  if (row.fieldCode === 'on_duty_count' || row.fieldCode === 'green_rate') return row.fieldCode;
  throw new CalcObjectFailure('RULE_ROW_INVALID', false, undefined, row.rowNo);
}
export function healthDependencies(row: SuccessionLevelRow): HealthDependencies {
  if (unsupportedHealthRule(row)) throw new CalcObjectFailure('FIELD_FORBIDDEN', true, undefined, row.rowNo);
  if (!Object.hasOwn(measures, row.measure))
    throw new CalcObjectFailure('RULE_ROW_INVALID', false, undefined, row.rowNo);
  const measure = measures[row.measure as keyof typeof measures];
  const field = fieldSource(row);
  // 绿化率直算由 T04 返回最终标量，不读取行上未使用的人口；绿化率字段仍遵从普通度量。
  const population = row.measure === 'green_rate' ? null : (row.population ?? 'all');
  const reads = new Set<Source>();
  if (field) reads.add(field);
  // 来源上下文的对象权与继任模块五态仍有效，不能因无字段计数而绕过。
  if (row.fieldSource === 'org') reads.add('org');
  if (row.fieldSource === 'succession') reads.add('successors');
  if (population === 'incumbents' || population === 'successors') reads.add(population);
  if (measure.denominator === 'incumbents' || measure.denominator === 'successors') reads.add(measure.denominator);
  return { field, population, measure, reads };
}
