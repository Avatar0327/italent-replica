/** §4.1：来源失败不能被布尔短路隐藏；module_absent 才可跳过整个等级。 */
import { evaluateFormula, inMemorySubject } from '../expression/index.js';
import { compileLevelComparisons, type SuccessionLevelRow, type SuccessionLevelRules } from './levels.js';
export type HealthMetric =
  { status: 'value'; value: number } | { status: 'empty' | 'forbidden' | 'unavailable' | 'module_absent' };
export interface SuccessionHealthLevel {
  id: string;
  displayOrder: number;
  rules: SuccessionLevelRules | null;
}
export async function evaluateHealthLevels(
  levels: readonly SuccessionHealthLevel[],
  read: (row: SuccessionLevelRow, levelId: string) => Promise<HealthMetric>,
  calendar = { today: '2000-01-01', timeZone: 'UTC' },
) {
  const skipped: string[] = [];
  for (const level of [...levels].sort((a, b) => a.displayOrder - b.displayOrder)) {
    if (!level.rules) continue;
    const compiled = compileLevelComparisons(level.rules);
    if (!compiled.ok) return { levelId: null, skipped, failure: { code: 'RULE_CACHE_STALE', levelId: level.id } };
    const values: Record<string, number | null> = {};
    let absent = false;
    for (const row of level.rules.rows) {
      if (!compiled.compiled.referencedRows.includes(row.rowNo)) continue;
      const metric = await read(row, level.id);
      if (metric.status === 'forbidden' || metric.status === 'unavailable')
        return {
          levelId: null,
          skipped,
          failure: {
            code: metric.status === 'forbidden' ? 'FIELD_FORBIDDEN' : 'DATA_UNAVAILABLE',
            levelId: level.id,
            rowNo: row.rowNo,
          },
        };
      if (metric.status === 'module_absent') absent = true;
      values[`行${row.rowNo}.值`] = metric.status === 'value' ? metric.value : null;
    }
    if (absent) {
      skipped.push(level.id);
      continue;
    }
    const result = evaluateFormula(compiled.compiled.formula, {
      calendar,
      subject: inMemorySubject(level.id, values),
      fieldKind: () => 'number',
    });
    if (!result.ok) return { levelId: null, skipped, failure: { code: result.failure.code, levelId: level.id } };
    if (result.value.kind === 'number' && result.value.value === 1) return { levelId: level.id, skipped };
  }
  return { levelId: null, skipped };
}
