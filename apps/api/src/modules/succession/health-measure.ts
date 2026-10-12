/** §4.1 / §4.3：所有来源共用五态 → 字段过滤 → 按对象去重 → 聚合；空字段不能伪装成零。 */
import {
  compileRuleSet,
  evaluateFormula,
  inMemorySubject,
  type PlainValue,
  type RuleFieldRef,
  type SuccessionLevelRow,
  type FieldRead,
  type HealthMetric,
} from '@italent/domain';
import { CalcObjectFailure } from './calc-contract.js';
export interface HealthSample {
  /** 人员键用于去重；null 只表示“继任模块存在、零提名”的真实数值，不算一名人员。 */
  key: string | null;
  read: FieldRead;
}
export interface HealthSource {
  status: HealthMetric['status'];
  samples: readonly HealthSample[];
  field: RuleFieldRef;
  population: number;
  successors: number;
  incumbents: number;
  zeroNominations?: boolean;
}
export const healthScalar = (value: PlainValue): FieldRead => ({
  status: value === null || value === undefined ? 'empty' : 'value',
  value: value ?? null,
});
function matches(row: SuccessionLevelRow, value: PlainValue, field: RuleFieldRef, asOf: string, timezone: string) {
  if (!row.filterOperator) return value !== null && value !== undefined;
  const compiled = compileRuleSet(
    {
      expression: '1',
      rows: [{ rowNo: 1, kind: 'field', field, operator: row.filterOperator, values: row.filterValues }],
    },
    { resolve: () => field },
  );
  if (!compiled.ok) throw new CalcObjectFailure('RULE_ROW_INVALID', false, undefined, row.rowNo);
  const evaluated = evaluateFormula(compiled.compiled.formula, {
    calendar: { today: asOf, timeZone: timezone },
    subject: inMemorySubject('filter', { [field.path]: value }),
    fieldKind: () => (field.kind === 'option' ? 'text' : field.kind),
  });
  if (!evaluated.ok) throw new CalcObjectFailure(evaluated.failure.code, true, undefined, row.rowNo);
  return evaluated.value.kind === 'number' && evaluated.value.value === 1;
}
const unique = (samples: readonly HealthSample[]) => [...new Map(samples.map((s) => [s.key, s])).values()];
export function measureHealth(
  row: SuccessionLevelRow,
  source: HealthSource,
  asOf: string,
  timezone: string,
): HealthMetric {
  const statuses = [source.status, ...source.samples.map((s) => s.read.status)];
  for (const status of ['forbidden', 'unavailable', 'module_absent'] as const)
    if (statuses.includes(status)) return { status };
  if (source.status === 'empty') return { status: 'empty' };
  const nonempty = unique(source.samples.filter((s) => s.read.status === 'value'));
  if (!nonempty.length && !source.zeroNominations) return { status: 'empty' };
  const selected = unique(
    source.samples.filter((s) => matches(row, s.read.value as PlainValue, source.field, asOf, timezone)),
  );
  const count = selected.filter((s) => s.key !== null).length;
  if (row.measure === 'green_rate' || row.measure === 'average') {
    const values = selected.filter((s) => s.read.status === 'value').map((s) => s.read.value);
    if (!values.length) return { status: 'empty' };
    if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return { status: 'unavailable' };
    return { status: 'value', value: (values as number[]).reduce((sum, n) => sum + n, 0) / values.length };
  }
  if (row.measure === 'count' || row.measure === 'successor_count') return { status: 'value', value: count };
  let denominator = source.population;
  if (row.measure === 'count_over_successors') denominator = source.successors;
  if (row.measure === 'count_over_incumbents') denominator = source.incumbents;
  if (row.measure === 'review_result_ratio') denominator = nonempty.filter((s) => s.key !== null).length;
  if (!denominator) return { status: 'empty' };
  return { status: 'value', value: count / denominator };
}
