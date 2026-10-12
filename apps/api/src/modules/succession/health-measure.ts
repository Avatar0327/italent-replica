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
import { healthDependencies, type HealthDependencies } from './health-dependencies.js';
import { CalcObjectFailure } from './calc-contract.js';
export interface HealthSample {
  /** 人员键用于去重；来源零提名不伪造人员样本。 */
  key: string;
  read: FieldRead;
}
export interface HealthSource {
  status: HealthMetric['status'];
  samples: readonly HealthSample[];
  field: RuleFieldRef;
  population: number;
  successors: number;
  incumbents: number;
  succession?: {
    original: 'zero' | 'present';
    /** all 不限制提名人员；其余人口用独立成员集合，空集合仍是空人口。 */
    populationKeys: readonly string[] | null;
    numeric: boolean;
  };
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
type SelectionState = 'present' | 'empty_population' | 'source_zero' | 'no_matching_nominations';
function selectPopulation(source: HealthSource): { state: SelectionState; samples: readonly HealthSample[] } {
  const origin = source.succession;
  if (!origin) return { state: 'present', samples: source.samples };
  // §4.1：人口为空优先于“模块存在、零提名”；不能由筛选后的数组反推来源状态。
  if (!source.population) return { state: 'empty_population', samples: [] };
  if (origin.original === 'zero') return { state: 'source_zero', samples: [] };
  const members = origin.populationKeys === null ? null : new Set(origin.populationKeys);
  const samples = source.samples.filter((s) => members === null || members.has(s.key));
  return { state: samples.length ? 'present' : 'no_matching_nominations', samples };
}
export function measureHealth(
  row: SuccessionLevelRow,
  source: HealthSource,
  asOf: string,
  timezone: string,
  dependencies: HealthDependencies = healthDependencies(row),
): HealthMetric {
  const statuses = [source.status, ...source.samples.map((s) => s.read.status)];
  for (const status of ['forbidden', 'unavailable', 'module_absent'] as const)
    if (statuses.includes(status)) return { status };
  if (source.status === 'empty') return { status: 'empty' };
  const population = selectPopulation(source);
  if (population.state === 'empty_population') return { status: 'empty' };
  // 人数字段的值由选定人口中的真实提名去重得到，过滤仍在最终聚合前执行。
  const numeric = source.succession?.numeric;
  const fieldValue = unique(population.samples).length;
  const samples = numeric
    ? population.samples.map((s) => ({ ...s, read: healthScalar(fieldValue) }))
    : population.samples;
  const nonempty = unique(samples.filter((s) => s.read.status === 'value'));
  const realZero = population.state === 'source_zero' || population.state === 'no_matching_nominations';
  if (!nonempty.length && !realZero) return { status: 'empty' };
  const zeroFieldMatches = numeric && realZero && matches(row, fieldValue, source.field, asOf, timezone);
  const selected = unique(
    samples.filter((s) => matches(row, s.read.value as PlainValue, source.field, asOf, timezone)),
  );
  if (dependencies.measure.numerator === 'values') {
    const values = selected.filter((s) => s.read.status === 'value').map((s) => s.read.value);
    // 真正的零人数字段可参与平均值；不向样本集合补入合成的“第零名人员”。
    if (zeroFieldMatches) values.push(fieldValue);
    if (!values.length) return { status: 'empty' };
    if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return { status: 'unavailable' };
    return { status: 'value', value: (values as number[]).reduce((sum, n) => sum + n, 0) / values.length };
  }
  const count = selected.length;
  const denominatorKey = dependencies.measure.denominator;
  if (denominatorKey === null) return { status: 'value', value: count };
  const denominator = denominatorKey === 'nonempty' ? nonempty.length : source[denominatorKey];
  if (!denominator) return { status: 'empty' };
  return { status: 'value', value: count / denominator };
}
