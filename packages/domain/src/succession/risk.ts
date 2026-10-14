/** 设计 §4.1～4.3：宿主提供人口与字段状态；过滤和等级比较只用 B1 / R3-T00。 */
import { evaluateFormula } from '../expression/engine.js';
import type { EvaluationCalendar } from '../expression/context.js';
import { compileRuleSet, RULE_COMPILER_VERSION } from '../expression/rules/index.js';
import type { PlainValue } from '../expression/values.js';
import { compileSuccessionLevel, type SuccessionLevelRow, type SuccessionLevelRules } from './levels.js';
import { POPULATION_FIELDS } from './populations.js';
export type RiskValue = PlainValue | { status: 'forbidden' | 'unavailable' };
export interface RiskPerson {
  id: string;
  [field: string]: RiskValue;
}
export type RiskSourceState = { status: 'available' } | { status: 'forbidden' | 'unavailable' };
export interface RiskPopulation {
  sources?: Readonly<Record<string, RiskSourceState>>;
  incumbents: readonly RiskPerson[];
  successors: readonly RiskPerson[];
}
export interface RiskLevel {
  id: string;
  rules: SuccessionLevelRules;
  formula: string | null;
  compilerVersion: string | null;
  compileError: unknown;
}
export class RiskFailure extends Error {
  constructor(
    readonly code: string,
    readonly rowNo?: number,
    public levelId?: string,
  ) {
    super(code);
  }
}
export function riskIncumbents(primary: readonly RiskPerson[], partTime: readonly RiskPerson[], include: boolean) {
  return [...new Map([...(include ? partTime : []), ...primary].map((p) => [p.id, p])).values()];
}
export function riskMeasure(row: SuccessionLevelRow, population: RiskPopulation, calendar: EvaluationCalendar) {
  const people = row.subject === 'incumbent' ? population.incumbents : population.successors;
  // §4.1：来源状态独立于人口；先统一验权 / 验源，再允许空人口和零分母成为 EMPTY。
  if (row.fieldCode) {
    const source = population.sources?.[row.fieldCode];
    if (source?.status !== 'available')
      throw new RiskFailure(source?.status === 'forbidden' ? 'FIELD_FORBIDDEN' : 'DATA_UNAVAILABLE', row.rowNo);
    for (const value of people.map((p) => p[row.fieldCode!]))
      if (value && typeof value === 'object' && 'status' in value)
        throw new RiskFailure(value.status === 'forbidden' ? 'FIELD_FORBIDDEN' : 'DATA_UNAVAILABLE', row.rowNo);
  }
  let denominator = 1;
  if (row.measure === 'count_over_incumbents') denominator = population.incumbents.length;
  else if (row.measure === 'count_over_successors') denominator = population.successors.length;
  if (!people.length || !denominator) return null;
  let selected = people.length;
  if (row.fieldCode) {
    const field = POPULATION_FIELDS.find((f) => f.code === row.fieldCode) ?? {
      object: 'successor' as const,
      code: 'readiness_id',
      path: 'successor.readiness_id',
      kind: 'text' as const,
    };
    const compiled = compileRuleSet(
      {
        expression: String(row.rowNo),
        rows: [
          {
            rowNo: row.rowNo,
            kind: 'field',
            field,
            operator: row.filterOperator ?? 'not_empty',
            values: row.filterValues,
          },
        ],
      },
      { resolve: () => field },
    );
    if (!compiled.ok) throw new RiskFailure('RULE_ROW_INVALID', row.rowNo);
    selected = 0;
    for (const person of people) {
      const value = person[row.fieldCode] as PlainValue;
      const result = evaluateFormula(compiled.compiled.formula, {
        calendar,
        subject: {
          id: person.id,
          resolveField: () => ({ status: 'found', value }),
        },
        fieldKind: () => (field.kind === 'date' || field.kind === 'number' ? field.kind : 'text'),
      });
      if (!result.ok) throw new RiskFailure(result.failure.code, row.rowNo);
      if (result.value.kind === 'number' && result.value.value === 1) selected++;
    }
  }
  return selected / denominator;
}
export function evaluateRisk(levels: readonly RiskLevel[], people: RiskPopulation, calendar: EvaluationCalendar) {
  for (const level of levels) {
    try {
      const compiled = compileSuccessionLevel('risk', level.rules, []);
      if (
        !compiled.ok ||
        level.compileError ||
        level.compilerVersion !== RULE_COMPILER_VERSION ||
        level.formula !== compiled.compiled.formula
      )
        throw new RiskFailure('RULE_CACHE_STALE');
      const values = new Map(level.rules.rows.map((row) => [`行${row.rowNo}.值`, riskMeasure(row, people, calendar)]));
      const result = evaluateFormula(level.formula, {
        calendar,
        subject: { id: level.id, resolveField: (path) => ({ status: 'found', value: values.get(path) }) },
        fieldKind: () => 'number',
      });
      if (!result.ok) throw new RiskFailure(result.failure.code);
      if (result.value.kind === 'number' && result.value.value === 1) return level.id;
    } catch (error) {
      if (error instanceof RiskFailure) error.levelId = level.id;
      throw error;
    }
  }
  return null;
}
