import { contractNotes } from '../contracts/annotations.js';
import { evaluationNotes } from './evaluation.js';
import { survey360Notes } from './survey360.js';
import { personnelNotes } from './personnel.js';
import { foundationNotes } from './foundation.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = {
  ...foundationNotes,
  ...personnelNotes,
  ...evaluationNotes,
  ...survey360Notes,
  ...contractNotes,
};
export type { DecisionAnnotation } from './foundation.js';
