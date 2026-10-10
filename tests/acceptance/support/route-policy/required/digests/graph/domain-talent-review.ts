/**
 * 直接依赖图：区域 domain-talent-review（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/talent-review/calc-rule.ts#analyzeCalcItems': [
    'packages/domain/src/expression/engine.ts#orderComputationItems',
    'packages/domain/src/expression/engine.ts#validateFormula',
    'packages/domain/src/expression/registry.ts#createDefaultRegistry',
    '#FORMULA_CONTEXT_FIELDS',
    '#formulaPath',
    '#formulaReferences',
    '#staticKind',
    '#toIssue',
  ],
  'packages/domain/src/talent-review/calc-rule.ts#formulaPath': ['#FORMULA_OBJECT'],
  'packages/domain/src/talent-review/calc-rule.ts#formulaReferences': [
    'packages/domain/src/expression/engine.ts#validateFormula',
  ],
  'packages/domain/src/talent-review/calc-rule.ts#unreferenceableItem': [
    'packages/domain/src/expression/engine.ts#validateFormula',
    'packages/domain/src/expression/registry.ts#createDefaultRegistry',
    '#FORMULA_CONTEXT_FIELDS',
    '#formulaPath',
    '#toIssue',
  ],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>calcRule': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>category': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>field': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>matrix': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>readiness': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>role': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>settings': ['#object'],
  'packages/domain/src/talent-review/catalog.ts#object': ['#SYSTEM_FIELDS', '#TALENT_REVIEW_APP', '#crud'],
  'packages/domain/src/talent-review/matrix.ts#checkAxisLevels': [
    '#MATRIX_MAX_LEVELS',
    '#MATRIX_MIN_LEVELS',
    '#checkNumericLevels',
    '#checkOptionLevels',
    '#violation',
  ],
  'packages/domain/src/talent-review/matrix.ts#checkCells': ['#violation'],
  'packages/domain/src/talent-review/matrix.ts#checkNumericLevels': ['#violation'],
  'packages/domain/src/talent-review/matrix.ts#checkOptionLevels': ['#violation'],
  'packages/domain/src/talent-review/matrix.ts#checkRatioRule': ['#violation'],
};
