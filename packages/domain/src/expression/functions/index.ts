import { ASSESSMENT_FUNCTIONS } from './assessment.js';
import { CORE_FUNCTIONS } from './core.js';
import { DATE_FUNCTIONS } from './dates.js';
import { PERFORMANCE_FUNCTIONS } from './performance.js';
import { RANKING_FUNCTIONS } from './ranking.js';
import { REVIEW_FUNCTIONS } from './review.js';
import { SURVEY360_FUNCTIONS } from './survey360.js';
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
