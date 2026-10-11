/** B2b：度量与来源的组合按设计 §4.3 校验；比较和过滤统一交 B1 编译器，不接受自由公式。 */
import {
  compileRuleSet,
  type RuleFieldRef,
  type RuleOperator,
  type RuleCompileError,
  type RuleWarning,
} from '../expression/rules/index.js';
import { POPULATION_FIELDS } from './populations.js';

export type SuccessionLevelKind = 'risk' | 'health';
export interface SuccessionLevelRow {
  rowNo: number;
  fieldCode: string | null;
  filterOperator: RuleOperator | null;
  filterValues: (string | number | boolean)[];
  measure: string;
  comparator: RuleOperator;
  threshold: number | null;
  thresholdHigh: number | null;
  isPercent: boolean;
  subject?: 'incumbent' | 'successor';
  population?: 'all' | 'successors' | 'incumbents' | 'custom';
  populationId?: string | null;
  fieldSource?: 'review' | 'org' | 'succession';
}
export interface SuccessionLevelRules {
  expression: string;
  rows: SuccessionLevelRow[];
}
const ref = (object: RuleFieldRef['object'], code: string, kind: RuleFieldRef['kind']): RuleFieldRef => ({
  object,
  code,
  kind,
  path: `${object}.${code}`,
});
const orgFields = [
  ref('org', 'person_in_charge_id', 'text'),
  ref('org', 'green_rate', 'number'),
  ref('org', 'on_duty_count', 'number'),
];
const successionFields = [ref('successor', 'successor_count', 'number'), ref('successor', 'readiness_code', 'text')];
export function compileSuccessionLevel(
  kind: SuccessionLevelKind,
  rules: SuccessionLevelRules,
  reviewFields: readonly RuleFieldRef[],
) {
  if (rules.rows.length > 50) return { ok: false as const, errors: [{ code: 'RULE_TOO_LARGE' as const }] };
  const errors: RuleCompileError[] = [];
  const warnings: RuleWarning[] = [];
  for (const row of rules.rows) {
    let fields: readonly RuleFieldRef[] = POPULATION_FIELDS;
    if (kind === 'risk') {
      if (row.subject === 'successor') fields = [...fields, ref('successor', 'readiness_id', 'text')];
    } else if (row.fieldSource === 'review') fields = reviewFields;
    else if (row.fieldSource === 'org') fields = orgFields;
    else fields = successionFields;
    const field = fields.find((item) => item.code === row.fieldCode);
    const invalid = (reason: RuleCompileError['reason']) =>
      errors.push({ code: 'RULE_ROW_INVALID', rowNo: row.rowNo, reason });
    if ((row.fieldCode !== null || row.filterOperator !== null) && !field) {
      invalid('FIELD_UNKNOWN');
      continue;
    }
    if (
      (row.measure === 'average' && field?.kind !== 'number') ||
      (row.measure === 'green_rate' &&
        (row.fieldSource !== 'org' || row.fieldCode !== null || row.filterOperator !== null)) ||
      (row.measure === 'review_result_ratio' &&
        (row.fieldSource !== 'review' || !field || row.filterOperator === null)) ||
      (row.measure === 'successor_count' && row.fieldSource !== 'succession')
    ) {
      invalid('FIELD_MISMATCH');
      continue;
    }
    // 多选禁用、候选值类型／字面量／选项域由权威目录与公共编译器复核，连未引用的行也校验。
    if (field) {
      const checked = compileRuleSet(
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
      if (!checked.ok) errors.push(...checked.errors);
      else warnings.push(...checked.warnings);
    } else if (row.filterValues.length > 20) errors.push({ code: 'RULE_TOO_LARGE', rowNo: row.rowNo });
  }
  if (errors.length) return { ok: false as const, errors };
  const compared = compileLevelComparisons(rules);
  if (!compared.ok) return compared;
  return {
    ...compared,
    warnings: [
      ...new Map(
        [...warnings, ...compared.warnings].map((warning) => [`${warning.code}:${warning.rowNo}`, warning]),
      ).values(),
    ],
  };
}
/** 读取时从原始比较行重建保存警告，不从编译公式反推条件行（DEC-261）。 */
export function compileLevelComparisons(rules: SuccessionLevelRules) {
  return compileRuleSet(
    {
      expression: rules.expression,
      rows: rules.rows.map((row) => ({
        rowNo: row.rowNo,
        kind: 'aggregate',
        operator: row.comparator,
        values:
          row.threshold === null
            ? []
            : row.comparator === 'between'
              ? [row.threshold, ...(row.thresholdHigh === null ? [] : [row.thresholdHigh])]
              : [row.threshold],
      })),
    },
    { resolve: () => undefined },
  );
}
