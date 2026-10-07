import { ASSESSMENT_FUNCTIONS, ASSESSMENT_OBJECTS } from './assessment.js';
import { CORE_FUNCTIONS } from './core.js';
import { DATE_FUNCTIONS } from './dates.js';
import { PERFORMANCE_FIELDS, PERFORMANCE_FUNCTIONS } from './performance.js';
import { RANKING_FUNCTIONS } from './ranking.js';
import { REVIEW_FUNCTIONS } from './review.js';
import { SURVEY360_FUNCTIONS, SURVEY360_OBJECT } from './survey360.js';
import type { FunctionSpec } from '../registry.js';

/** 内置函数全集（`26` §8.1 + REQ-EXP-001 评定专用函数）。 */
export const BUILTIN_FUNCTIONS: readonly FunctionSpec[] = [
  ...CORE_FUNCTIONS,
  ...DATE_FUNCTIONS,
  ...PERFORMANCE_FUNCTIONS,
  ...SURVEY360_FUNCTIONS,
  ...ASSESSMENT_FUNCTIONS,
  ...RANKING_FUNCTIONS,
  ...REVIEW_FUNCTIONS,
];

export { ASSESSMENT_OBJECTS } from './assessment.js';
export { PERFORMANCE_FIELDS } from './performance.js';
export { SURVEY360_OBJECT } from './survey360.js';

/** 取数函数记录作用域里的对象名：这些对象下的字段来自端口记录，连字符一律按字段名处理（如 360结果.问卷-他评总分）。 */
export const RECORD_OBJECTS: readonly string[] = [PERFORMANCE_FIELDS.object, SURVEY360_OBJECT, ...ASSESSMENT_OBJECTS];
