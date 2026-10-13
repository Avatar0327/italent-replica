import { evaluationNotes } from './evaluation.js';
import { foundationNotes } from './foundation.js';
import { personnelNotes } from './personnel.js';
import { settingsNotes } from './settings.js';
import { survey360Notes } from './survey360.js';
import { talentReviewNotes } from './talent-review.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = {
  ...evaluationNotes,
  ...foundationNotes,
  ...personnelNotes,
  ...settingsNotes,
  ...survey360Notes,
  ...talentReviewNotes,
};
export type { DecisionAnnotation } from './foundation.js';
